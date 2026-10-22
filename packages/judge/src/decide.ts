import {
  type Attempt,
  type Environment,
  type Judgement,
  type Occurrence,
  type OccurrenceFinding,
  type StepFinding,
  type TokenUsage,
  withRebuiltFixPrompt,
} from '@jayslifecode/lookover-core';
import { REPRODUCTION_ATTEMPTS } from './constants.js';
import { isReproduced, targetKey } from './harness.js';
import { clip, MAX_NOTE_CHARS, type Verdict } from './model/schema.js';

/** What the judge model said about one reproduced finding, and what saying it cost. */
export interface ModelVerdict {
  verdict: Verdict;
  /** The model that gave the verdict. */
  model: string;
  /** What the call used; `null` for a verdict served from the cache, which used nothing. */
  usage: TokenUsage | null;
  /** What the call cost; `0` for a cached verdict, `null` for a model the price table does not know. */
  estimatedUsd: number | null;
  cached: boolean;
}

export interface DecideOptions {
  /** When the decision is made: the judgement's `judgedAt`. */
  judgedAt: string;
  /** The attempts every target was given. Default `REPRODUCTION_ATTEMPTS`. */
  of?: number;
  /**
   * The note of a harness confirmation: why the model gave no verdict on a reproduced finding when there
   * is a reason worth reading (it was unavailable). Default `null`.
   */
  harnessNote?: string | null;
}

/** How one finding's occurrences fared across their attempts. */
export interface OccurrenceSplit {
  /** The occurrences reproduced on every attempt, in the finding's order. */
  kept: Occurrence[];
  /** The rest, in the finding's order. */
  dropped: Occurrence[];
  /** Every attempt, occurrence by occurrence in the finding's order. */
  attempts: Attempt[];
  /** The kept occurrences' attempts alone: what the model is shown. */
  keptAttempts: Attempt[];
  /** The most attempts any one occurrence reproduced on. */
  best: number;
}

/** A judgement's parts that say who decided what, and the status they give the finding. */
type Ruling = Pick<
  Judgement,
  'decidedBy' | 'attribution' | 'oracle' | 'note' | 'model' | 'usage' | 'estimatedUsd' | 'cached'
> & { status: 'confirmed' | 'rejected' };

/**
 * A step finding as judged. Reproduced on every one of `of` attempts, it is confirmed by the harness as a
 * product defect, or decided by the model when it gave a verdict (confirmed, or rejected with its
 * attribution, oracle and note). Reproduced fewer times, it is rejected as timing whatever the model said.
 * Builds a new finding; the inputs are untouched.
 */
export function decideStep(
  finding: StepFinding,
  attempts: readonly Attempt[],
  verdict: ModelVerdict | null,
  environment: Environment,
  options: DecideOptions,
): StepFinding {
  const of = options.of ?? REPRODUCTION_ATTEMPTS;
  const reproduced = reproducedCount(attempts);
  const { status, ...ruling } = isReproduced(attempts, of)
    ? rulingOf(verdict, options.harnessNote ?? null)
    : timingRuling(reproduced, of);
  return {
    ...finding,
    status,
    judgement: {
      reproduced,
      of,
      attempts: [...attempts],
      ...ruling,
      droppedOccurrences: [],
      environment,
      judgedAt: options.judgedAt,
    },
  };
}

/**
 * An occurrence finding as judged, from each occurrence's attempts (keyed by `targetKey`). It keeps the
 * occurrences reproduced on every attempt and lists the rest in `droppedOccurrences`, its fix prompt
 * rebuilt when some were dropped; with at least one kept it is decided as a reproduced step finding is.
 * With none, it is rejected as timing (its note counting the best occurrence's reproductions) and keeps
 * every occurrence, so the record still says where it was seen. Builds a new finding; the inputs are
 * untouched.
 */
export function decideOccurrence(
  finding: OccurrenceFinding,
  attemptsByOccurrence: ReadonlyMap<string, readonly Attempt[]>,
  verdict: ModelVerdict | null,
  environment: Environment,
  options: DecideOptions,
): OccurrenceFinding {
  const of = options.of ?? REPRODUCTION_ATTEMPTS;
  const split = splitOccurrences(finding, attemptsByOccurrence, of);
  const isKept = split.kept.length > 0;
  const { status, ...ruling } = isKept
    ? rulingOf(verdict, options.harnessNote ?? null)
    : timingRuling(split.best, of);
  return {
    ...(isKept ? withKeptOccurrences(finding, split) : finding),
    status,
    judgement: {
      reproduced: split.kept.length,
      of: finding.occurrences.length,
      attempts: split.attempts,
      ...ruling,
      droppedOccurrences: split.dropped,
      environment,
      judgedAt: options.judgedAt,
    },
  };
}

/** Which of `finding`'s occurrences reproduced on every one of `of` attempts; one without attempts did not. */
export function splitOccurrences(
  finding: OccurrenceFinding,
  attemptsByOccurrence: ReadonlyMap<string, readonly Attempt[]>,
  of = REPRODUCTION_ATTEMPTS,
): OccurrenceSplit {
  const tried = finding.occurrences.map((occurrence) => {
    const attempts = attemptsByOccurrence.get(targetKey({ finding, occurrence })) ?? [];
    return { occurrence, attempts, isKept: isReproduced(attempts, of) };
  });
  const kept = tried.filter(({ isKept }) => isKept);
  return {
    kept: kept.map(({ occurrence }) => occurrence),
    dropped: tried.filter(({ isKept }) => !isKept).map(({ occurrence }) => occurrence),
    attempts: tried.flatMap(({ attempts }) => attempts),
    keptAttempts: kept.flatMap(({ attempts }) => attempts),
    best: Math.max(0, ...tried.map(({ attempts }) => reproducedCount(attempts))),
  };
}

/**
 * `finding` with only its kept occurrences and its fix prompt listing them, when some were dropped; as it
 * is otherwise (none dropped, or none kept).
 */
export function withKeptOccurrences(finding: OccurrenceFinding, split: OccurrenceSplit): OccurrenceFinding {
  if (split.dropped.length === 0 || split.kept.length === 0) return finding;
  return withRebuiltFixPrompt({ ...finding, occurrences: split.kept });
}

/** The note of a finding rejected because it did not reproduce on every attempt. */
export function timingNote(reproduced: number, of: number): string {
  return `Reproduced ${reproduced} of ${of} times; a problem that comes and goes is not reported`;
}

/** The note of a harness confirmation made because the judge model failed with `reason`. */
export function modelUnavailableNote(reason: string): string {
  return clip(
    `The judge model was unavailable (${reason}), so this finding is confirmed by reproduction alone.`,
    MAX_NOTE_CHARS,
  );
}

function rulingOf(verdict: ModelVerdict | null, harnessNote: string | null): Ruling {
  if (verdict === null) {
    return {
      status: 'confirmed',
      decidedBy: 'harness',
      attribution: 'product-defect',
      oracle: null,
      note: harnessNote,
      model: null,
      usage: null,
      estimatedUsd: null,
      cached: false,
    };
  }
  const { verdict: answer, model, usage, estimatedUsd, cached } = verdict;
  return {
    status: answer.verdict === 'confirm' ? 'confirmed' : 'rejected',
    decidedBy: 'model',
    attribution: answer.attribution,
    oracle: answer.oracle,
    note: answer.note,
    model,
    usage,
    estimatedUsd,
    cached,
  };
}

function timingRuling(reproduced: number, of: number): Ruling {
  return {
    status: 'rejected',
    decidedBy: 'harness',
    attribution: 'timing',
    oracle: null,
    note: timingNote(reproduced, of),
    model: null,
    usage: null,
    estimatedUsd: null,
    cached: false,
  };
}

function reproducedCount(attempts: readonly Attempt[]): number {
  return attempts.filter((attempt) => attempt.reproduced).length;
}
