import type { Finding, FindingsFile, Severity, StepFinding } from '@jayslifecode/lookover-core';
import { SEVERITIES } from '@jayslifecode/lookover-rules';
import { count } from './run-summary.js';

/** The candidates of one rule, as the summary lists them. */
export interface CandidateGroup {
  readonly severity: Severity;
  readonly ruleId: string;
  readonly title: string;
  readonly count: number;
  /** Where to look first: `/settings button "Save"`, or `3 occurrences on 2 screens`. */
  readonly example: string;
}

/**
 * What a page may put in an element's name that a terminal would act on rather than show: control
 * characters, format characters (bidi overrides such as U+202E) and line and paragraph separators.
 */
const TERMINAL_UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const COLUMN_GAP = '  ';
const LINE_INDENT = '  ';

/**
 * The run's candidates (not the worth-a-look entries) grouped by rule: from blocker to low, then the
 * rule with the most candidates first, then by rule id. The severity and the title are the first
 * candidate's, which every candidate of a rule shares.
 */
export function groupCandidates(file: FindingsFile): CandidateGroup[] {
  const tallies = file.findings.reduce<ReadonlyMap<string, Tally>>((byRule, finding) => {
    const known = byRule.get(finding.rule.id);
    const tally: Tally = { first: known?.first ?? finding, count: (known?.count ?? 0) + 1 };
    return new Map(byRule).set(finding.rule.id, tally);
  }, new Map());
  return [...tallies.values()].map(groupOf).sort(compareGroups);
}

/** One aligned line per group: `  high    interaction.focus-visible-missing  2  /settings button "Save"`. */
export function candidateLines(groups: readonly CandidateGroup[]): string[] {
  const severityWidth = widest(groups.map((group) => group.severity));
  const ruleWidth = widest(groups.map((group) => group.ruleId));
  const countWidth = widest(groups.map((group) => String(group.count)));
  return groups.map((group) =>
    [
      LINE_INDENT + group.severity.padEnd(severityWidth),
      group.ruleId.padEnd(ruleWidth),
      String(group.count).padStart(countWidth),
      group.example,
    ].join(COLUMN_GAP),
  );
}

interface Tally {
  readonly first: Finding;
  readonly count: number;
}

function groupOf({ first, count: size }: Tally): CandidateGroup {
  return {
    severity: first.severity,
    ruleId: first.rule.id,
    title: first.title,
    count: size,
    example: exampleOf(first).replaceAll(TERMINAL_UNSAFE_CHARACTERS, ' '),
  };
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
