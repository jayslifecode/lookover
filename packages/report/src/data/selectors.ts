import type { Finding, Screen, Severity, SkipTally } from '@jayslifecode/lookover-core';
import { compareText, type ReportState } from './reduce';

/*
 * What the views read from the report's state, computed and never stored. Each returns new arrays and
 * leaves its input as it was.
 */

/** Fix-first: the most severe first. The rule catalogue's order (`SEVERITIES` in the rules package). */
export const SEVERITY_ORDER: readonly Severity[] = ['blocker', 'high', 'medium', 'low'];

function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/** Findings about one component (one signature, else one component name, else one rule). */
export interface FindingGroup {
  /** Unique among the groups. */
  readonly key: string;
  /** What the group is about: the signature, the component name or the rule id. */
  readonly label: string;
  /** In the order first seen. */
  readonly findings: readonly Finding[];
  /** The most severe finding, the first seen on a tie: it stands for the group. */
  readonly lead: Finding;
  readonly severity: Severity;
  /** The distinct screens the findings were seen on, in the order first seen. */
  readonly screens: readonly string[];
  readonly count: number;
}

export interface Scorecard {
  readonly confirmed: Readonly<Record<Severity, number>>;
  readonly worthALook: number;
  readonly rejected: number;
  /** Confirmed findings every attempt (or every occurrence) of which reproduced. */
  readonly reproducedEveryTime: number;
  /** What the lenses skipped on the screen, the most frequent first. */
  readonly skipped: readonly SkipTally[];
}

/** How the confirmed findings changed since the previous run, told apart by id. */
export interface Drift {
  /** Confirmed now, not a finding of the previous run. */
  readonly added: readonly Finding[];
  /** A finding of the previous run that is neither confirmed nor intended now. */
  readonly fixed: readonly Finding[];
  /** Confirmed now and a finding of the previous run; this run's version of each. */
  readonly unchanged: readonly Finding[];
}

/** The distinct screens `finding` was seen on, in the order first seen. */
export function screensOf(finding: Finding): string[] {
  if (finding.shape === 'step') return [finding.screenId];
  return [...new Set(finding.occurrences.map((occurrence) => occurrence.screenId))];
}

/** A step finding is on its screen; an occurrence finding on every screen one of its occurrences is. */
export function isOnScreen(finding: Finding, screenId: string): boolean {
  if (finding.shape === 'step') return finding.screenId === screenId;
  return finding.occurrences.some((occurrence) => occurrence.screenId === screenId);
}

function judgedWith(state: ReportState, status: Finding['status']): Finding[] {
  return [...state.judged.values()].filter((finding) => finding.status === status);
}

export function confirmedFindings(state: ReportState): Finding[] {
  return judgedWith(state, 'confirmed');
}

export function findingsOnScreen(state: ReportState, screenId: string): Finding[] {
  return confirmedFindings(state).filter((finding) => isOnScreen(finding, screenId));
}

/** The first screen the run captured (a screen whose navigation failed holds nothing to show). */
export function firstCapturedScreen(state: ReportState): Screen | null {
  return state.screens.find((screen) => screen.status === 'captured') ?? null;
}

function groupOf(finding: Finding): { key: string; label: string } {
  const target = finding.shape === 'step' ? finding.target : null;
  if (target?.signature != null) return { key: `signature:${target.signature}`, label: target.signature };
  if (target?.componentName != null) {
    return { key: `component:${target.componentName}`, label: target.componentName };
  }
  return { key: `rule:${finding.rule.id}`, label: finding.rule.id };
}

function mostSevere(findings: readonly [Finding, ...Finding[]]): Finding {
  return findings.reduce((lead, finding) =>
    severityRank(finding.severity) < severityRank(lead.severity) ? finding : lead,
  );
}

/** Groups by `target.signature`, else `target.componentName`, else `rule.id`, in the order first seen. */
export function groups(findings: readonly Finding[]): FindingGroup[] {
  const keyed = findings.map((finding) => ({ finding, ...groupOf(finding) }));
  const labels = new Map(keyed.map(({ key, label }) => [key, label]));
  return [...labels].map(([key, label]) => {
    // Every key came from a finding, so no group is empty.
    const members = keyed.filter((entry) => entry.key === key).map((entry) => entry.finding);
    const lead = mostSevere(members as [Finding, ...Finding[]]);
    return {
      key,
      label,
      findings: members,
      lead,
      severity: lead.severity,
      screens: [...new Set(members.flatMap(screensOf))],
      count: members.length,
    };
  });
}

function compareGroups(a: FindingGroup, b: FindingGroup): number {
  return (
    severityRank(a.severity) - severityRank(b.severity) ||
    b.screens.length - a.screens.length ||
    compareText(a.lead.rule.id, b.lead.rule.id) ||
    compareText(a.lead.title, b.lead.title) ||
    compareText(a.key, b.key)
  );
}

/**
 * Most severe first, then the most screens affected, then by rule id, then by title, then by the group's
 * key: a total order, so it does not depend on the order the findings arrived in.
 */
export function fixFirst(findingGroups: readonly FindingGroup[]): FindingGroup[] {
  return findingGroups.toSorted(compareGroups);
}

function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  return Object.fromEntries(
    SEVERITY_ORDER.map((severity) => [severity, findings.filter((f) => f.severity === severity).length]),
  ) as Record<Severity, number>;
}

function reproducedEveryTime(finding: Finding): boolean {
  const judgement = finding.judgement;
  return judgement !== null && judgement.of > 0 && judgement.reproduced === judgement.of;
}

export function scorecard(state: ReportState, screenId: string): Scorecard {
  const onScreen = (finding: Finding) => isOnScreen(finding, screenId);
  const confirmed = findingsOnScreen(state, screenId);
  return {
    confirmed: countBySeverity(confirmed),
    worthALook: state.worthALook.filter(onScreen).length,
    rejected: judgedWith(state, 'rejected').filter(onScreen).length,
    reproducedEveryTime: confirmed.filter(reproducedEveryTime).length,
    skipped: state.inspections.get(screenId)?.skipped ?? [],
  };
}

/** `null` until the previous run's findings are loaded, and for a first run. */
export function drift(state: ReportState): Drift | null {
  if (state.previous === null) return null;
  const before = state.previous.findings;
  const current = confirmedFindings(state);
  const beforeIds = new Set(before.map((finding) => finding.id));
  const currentIds = new Set(current.map((finding) => finding.id));
  const intendedIds = new Set(judgedWith(state, 'intended').map((finding) => finding.id));
  return {
    added: current.filter((finding) => !beforeIds.has(finding.id)),
    fixed: before.filter((finding) => !currentIds.has(finding.id) && !intendedIds.has(finding.id)),
    unchanged: current.filter((finding) => beforeIds.has(finding.id)),
  };
}
