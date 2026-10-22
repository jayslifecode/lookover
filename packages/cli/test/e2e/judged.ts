import { relative, resolve, sep } from 'node:path';
import type {
  AppMap,
  Attempt,
  DecidedBy,
  Finding,
  OccurrenceFinding,
  RunEvent,
} from '@jayslifecode/lookover-core';
import { isMissing } from './project.js';
import { isSeedPlace, type Seed } from './seeds.js';

/** Every target is measured again this many times in fresh contexts (the judge's REPRODUCTION_ATTEMPTS). */
export const ATTEMPTS = 3;
/** The environment of every judgement names the browser it ran in. */
const BROWSER_PREFIX = 'chromium ';

/** How many of the attempts at one target saw the finding again. */
interface Tally {
  readonly reproduced: number;
  readonly of: number;
}

/**
 * What is wrong with `finding` as the confirmed report of `seed`, one line each; empty when nothing is.
 * It must be confirmed, by one of `decidedBy`, in Chromium, and reproduced on every one of three attempts:
 * a step finding by its judgement (`reproduced === 3`), an occurrence finding at each of its occurrences
 * that is where the seed is (its `reproduced` counts occurrences, not attempts).
 */
export function seedJudgementProblems(
  finding: Finding,
  seed: Seed,
  map: AppMap,
  decidedBy: readonly DecidedBy[],
): string[] {
  const { judgement } = finding;
  if (finding.status !== 'confirmed' || judgement === null) {
    return [`${seed.id}: ${finding.status}`];
  }
  const tallies = talliesAt(finding, seed, map);
  const isReproduced =
    tallies.length > 0 && tallies.every(({ reproduced, of }) => reproduced === ATTEMPTS && of === ATTEMPTS);
  const browser = judgement.environment?.browser ?? 'no environment';
  return [
    ...(isReproduced ? [] : [`${seed.id}: reproduced ${tallies.map(describe).join(', ') || 'nowhere'}`]),
    ...(decidedBy.includes(judgement.decidedBy) ? [] : [`${seed.id}: decided by ${judgement.decidedBy}`]),
    ...(browser.startsWith(BROWSER_PREFIX) ? [] : [`${seed.id}: judged in ${browser}`]),
  ];
}

function talliesAt(finding: Finding, seed: Seed, map: AppMap): Tally[] {
  const { judgement } = finding;
  if (judgement === null) return [];
  if (finding.shape === 'step') {
    const screen = map.screens.find((candidate) => candidate.id === finding.screenId);
    return screen === undefined ? [] : [{ reproduced: judgement.reproduced, of: judgement.of }];
  }
  return seedOccurrences(finding, seed).map((occurrence) => {
    const attempts = judgement.attempts.filter((attempt) => isAt(attempt, occurrence));
    return { reproduced: attempts.filter((attempt) => attempt.reproduced).length, of: attempts.length };
  });
}

function seedOccurrences(finding: OccurrenceFinding, seed: Seed): OccurrenceFinding['occurrences'] {
  return finding.occurrences.filter(({ route, selector, viewport }) =>
    isSeedPlace({ route, selector, viewport: viewport.name }, seed),
  );
}

function isAt(attempt: Attempt, occurrence: OccurrenceFinding['occurrences'][number]): boolean {
  return (
    attempt.occurrence !== null &&
    attempt.occurrence.screenId === occurrence.screenId &&
    attempt.occurrence.selector === occurrence.selector &&
    attempt.occurrence.viewport === occurrence.viewport.name
  );
}

function describe({ reproduced, of }: Tally): string {
  return `${reproduced}/${of}`;
}

/**
 * What is wrong with the attempts `finding` was judged on, one line each; empty when nothing is: every
 * target (the finding itself, or each of its occurrences) was attempted exactly three times, numbered 1
 * to 3, and every attempt has evidence.
 */
export function attemptProblems(finding: Finding): string[] {
  const attempts = finding.judgement?.attempts ?? [];
  const byTarget = attempts.reduce<ReadonlyMap<string, readonly Attempt[]>>((groups, attempt) => {
    const target = targetOf(attempt);
    return new Map(groups).set(target, [...(groups.get(target) ?? []), attempt]);
  }, new Map());
  const expected =
    finding.shape === 'step'
      ? ['']
      : finding.occurrences.map(({ screenId, selector, viewport }) =>
          [screenId, selector ?? '', viewport.name].join('|'),
        );
  const missing = expected.filter((target) => !byTarget.has(target));
  const miscounted = [...byTarget].filter(
    ([, tried]) => tried.map(({ index }) => index).join(',') !== '1,2,3',
  );
  const bare = attempts.filter(({ evidence }) => evidence.length === 0);
  return [
    ...missing.map((target) => `${finding.id}: no attempt at ${target || 'the finding'}`),
    ...miscounted.map(([target, tried]) => `${finding.id}: ${tried.length} attempts at ${target || 'it'}`),
    ...bare.map(({ index }) => `${finding.id}: attempt ${index} has no evidence`),
  ];
}

function targetOf({ occurrence }: Attempt): string {
  return occurrence === null
    ? ''
    : [occurrence.screenId, occurrence.selector ?? '', occurrence.viewport].join('|');
}

/** The evidence of every attempt of `findings` that is outside `runDir` or missing, relative to it. */
export async function attemptEvidenceProblems(
  findings: readonly Finding[],
  runDir: string,
): Promise<string[]> {
  const root = resolve(runDir);
  const paths = findings.flatMap((finding) =>
    (finding.judgement?.attempts ?? []).flatMap((attempt) =>
      attempt.evidence.map((item) => resolve(root, item.ref.path)),
    ),
  );
  const problems: string[] = [];
  for (const path of new Set(paths)) {
    const shown = relative(root, path);
    if (shown.startsWith(`..${sep}`)) problems.push(`outside the run: ${path}`);
    else if (await isMissing(path)) problems.push(`missing: ${shown}`);
  }
  return problems;
}

/**
 * How long after `run.started` the first confirmed finding was logged (`finding.judged`), in ms; `null`
 * when nothing was confirmed.
 */
export function firstConfirmedMs(events: readonly RunEvent[]): number | null {
  const started = events.find((event) => event.type === 'run.started');
  const confirmed = events.find(
    (event) => event.type === 'finding.judged' && event.finding.status === 'confirmed',
  );
  if (started === undefined || confirmed === undefined) return null;
  return Date.parse(confirmed.at) - Date.parse(started.at);
}
