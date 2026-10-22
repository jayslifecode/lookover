import type {
  Attempt,
  Finding,
  FindingsFile,
  OccurrenceFinding,
  Severity,
  StepFinding,
} from '@jayslifecode/lookover-core';
import { SEVERITIES } from '@jayslifecode/lookover-rules';
import { count } from './run-summary.js';

/** How many of its attempts saw a judged finding again. */
export interface AttemptTally {
  readonly reproduced: number;
  readonly of: number;
}

/** The candidates (or, in a judged run, the confirmed findings) of one rule, as the summary lists them. */
export interface CandidateGroup {
  readonly severity: Severity;
  readonly ruleId: string;
  readonly title: string;
  readonly count: number;
  /** Where to look first: `/settings button "Save"`, or `3 occurrences on 2 screens`. */
  readonly example: string;
  /**
   * How often the first finding was seen again: its own attempts for a step finding, its first
   * occurrence's for an occurrence finding. Absent while nothing has judged it.
   */
  readonly attempts?: AttemptTally;
}

/**
 * What a page may put in an element's name that a terminal would act on rather than show: control
 * characters, line and paragraph separators, and the bidi controls that can show a name reversed (the
 * embeddings and overrides U+202A–U+202E, the isolates U+2066–U+2069, the marks U+200E, U+200F and
 * U+061C). The other format characters stay: the zero width joiner holds emoji sequences together, and
 * Persian and Mongolian write joiners and non-joiners inside words.
 */
const TERMINAL_UNSAFE_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/gu;
const COLUMN_GAP = '  ';
const LINE_INDENT = '  ';

/**
 * The run's candidates (not the worth-a-look entries) grouped by rule: from blocker to low, then the
 * rule with the most candidates first, then by rule id. The severity and the title are the first
 * candidate's, which every candidate of a rule shares.
 */
export function groupCandidates(file: FindingsFile): CandidateGroup[] {
  return groupByRule(file.findings);
}

/**
 * The confirmed findings of a judged run, grouped as `groupCandidates` groups candidates. A candidate the
 * judge never decided on is left out, as are the rejected and intended findings, which live in lists of
 * their own.
 */
export function groupConfirmed(file: FindingsFile): CandidateGroup[] {
  return groupByRule(file.findings.filter((finding) => finding.status === 'confirmed'));
}

/**
 * The lines the summary lists after its table: the confirmed findings of a judged run, each ending with
 * how often it was reproduced (`reproduced 3/3`), or the candidates of a run that was not judged.
 */
export function findingLines(file: FindingsFile): string[] {
  return candidateLines(file.judge === null ? groupCandidates(file) : groupConfirmed(file));
}

/**
 * One aligned line per group: `  high    interaction.focus-visible-missing  2  /settings button "Save"`.
 * A judged group ends with its reproductions, `  reproduced 3/3`, after the examples padded to one width.
 */
export function candidateLines(groups: readonly CandidateGroup[]): string[] {
  const severityWidth = widest(groups.map((group) => group.severity));
  const ruleWidth = widest(groups.map((group) => group.ruleId));
  const countWidth = widest(groups.map((group) => String(group.count)));
  const exampleWidth = widest(
    groups.flatMap((group) => (group.attempts === undefined ? [] : [group.example])),
  );
  return groups.map((group) => {
    const columns = [
      LINE_INDENT + group.severity.padEnd(severityWidth),
      group.ruleId.padEnd(ruleWidth),
      String(group.count).padStart(countWidth),
    ];
    if (group.attempts === undefined) {
      return [...columns, group.example].join(COLUMN_GAP);
    }
    const { reproduced, of } = group.attempts;
    return [...columns, group.example.padEnd(exampleWidth), `reproduced ${reproduced}/${of}`].join(
      COLUMN_GAP,
    );
  });
}

interface Tally {
  readonly first: Finding;
  readonly count: number;
}

function groupByRule(findings: readonly Finding[]): CandidateGroup[] {
  const tallies = findings.reduce<ReadonlyMap<string, Tally>>((byRule, finding) => {
    const known = byRule.get(finding.rule.id);
    const tally: Tally = { first: known?.first ?? finding, count: (known?.count ?? 0) + 1 };
    return new Map(byRule).set(finding.rule.id, tally);
  }, new Map());
  return [...tallies.values()].map(groupOf).sort(compareGroups);
}

function groupOf({ first, count: size }: Tally): CandidateGroup {
  const attempts = attemptTally(first);
  return {
    severity: first.severity,
    ruleId: first.rule.id,
    title: first.title,
    count: size,
    example: exampleOf(first).replaceAll(TERMINAL_UNSAFE_CHARACTERS, ' '),
    ...(attempts === undefined ? {} : { attempts }),
  };
}

/** How often `finding` was seen again, when the harness or the model judged it (a user decision tried nothing). */
function attemptTally(finding: Finding): AttemptTally | undefined {
  const { judgement } = finding;
  if (judgement === null || judgement.decidedBy === 'user') {
    return undefined;
  }
  const attempts =
    finding.shape === 'step' ? judgement.attempts : leadOccurrenceAttempts(finding, judgement.attempts);
  return { reproduced: attempts.filter((attempt) => attempt.reproduced).length, of: attempts.length };
}

/** The attempts made at an occurrence finding's first occurrence (a confirmed one keeps only those reproduced). */
function leadOccurrenceAttempts(finding: OccurrenceFinding, attempts: readonly Attempt[]): Attempt[] {
  const [lead] = finding.occurrences;
  if (lead === undefined) {
    return [];
  }
  return attempts.filter(
    ({ occurrence }) =>
      occurrence !== null &&
      occurrence.screenId === lead.screenId &&
      occurrence.selector === lead.selector &&
      occurrence.viewport === lead.viewport.name,
  );
}

function exampleOf(finding: Finding): string {
  if (finding.shape === 'occurrence') {
    const screens = new Set(finding.occurrences.map((occurrence) => occurrence.screenId));
    return `${count(finding.occurrences.length, 'occurrence')} on ${count(screens.size, 'screen')}`;
  }
  return stepExample(finding);
}

function stepExample({ target, trace }: StepFinding): string {
  return target === null ? trace.route : `${trace.route} ${target.role} "${target.name}"`;
}

function compareGroups(a: CandidateGroup, b: CandidateGroup): number {
  return (
    SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
    b.count - a.count ||
    compareText(a.ruleId, b.ruleId)
  );
}

/** By code point, so the order does not depend on the user's locale. */
function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function widest(texts: readonly string[]): number {
  return Math.max(0, ...texts.map((text) => text.length));
}
