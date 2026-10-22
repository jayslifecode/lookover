import type { Decision, Finding, Screen, Severity, SkipTally } from '@jayslifecode/lookover-core';
import { STREAM_RECONNECTING } from './api';
import { compareText, type ReportState, talliedSkips } from './reduce';

/*
 * What the views read from the report's state, computed and never stored. Each returns new arrays and
 * leaves its input as it was.
 */

/** Fix-first: the most severe first. The rule catalogue's order (`SEVERITIES` in the rules package). */
export const SEVERITY_ORDER: readonly Severity[] = ['blocker', 'high', 'medium', 'low'];

function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/** The more severe finding first; a stable sort keeps the order of equally severe ones. */
export function compareSeverity(a: Finding, b: Finding): number {
  return severityRank(a.severity) - severityRank(b.severity);
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
  /** What the lenses skipped on the screen, per reason, the most frequent first, then by reason. */
  readonly skipped: readonly SkipTally[];
  /** While the run is going: the candidates seen on the screen and not judged yet, being reproduced. */
  readonly reproducing: readonly Finding[];
}

/**
 * How the confirmed findings changed since the previous run, told apart by id, and which routes came and
 * went. The report has the previous run's findings but not its screen map, so the routes are compared
 * with the routes the previous run's findings name: a route it captured without a finding counts as added.
 */
export interface Drift {
  /** Confirmed now, not confirmed in the previous run. */
  readonly added: readonly Finding[];
  /** Confirmed in the previous run, and neither confirmed nor intended now. */
  readonly fixed: readonly Finding[];
  /** Confirmed in both runs; this run's version of each. */
  readonly unchanged: readonly Finding[];
  /** Confirmed in the previous run and decided intended since: never fixed. This run's version of each. */
  readonly intended: readonly Finding[];
  /** The routes of this run's screens that no finding of the previous run names, sorted. */
  readonly addedRoutes: readonly string[];
  /** The routes the previous run's findings name that no screen of this run is on, sorted. */
  readonly removedRoutes: readonly string[];
}

/** The routes `finding` was seen on, each once, in the order first seen. */
export function routesOf(finding: Finding): string[] {
  if (finding.shape === 'step') return [finding.trace.route];
  return [...new Set(finding.occurrences.map((occurrence) => occurrence.route))];
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

/**
 * The user's word on `finding`, which wins over how it was judged. Once the project's decisions are
 * loaded they say (a decision made or taken back in the report shows at once); until then, the findings
 * file's own `intended` status, with the note it was decided with.
 */
export function decisionOf(state: ReportState, finding: Finding): Decision | null {
  if (state.decisions !== null) {
    const { decisions } = state.decisions;
    return Object.hasOwn(decisions, finding.id) ? (decisions[finding.id] ?? null) : null;
  }
  if (finding.status !== 'intended') return null;
  const judgedAt = finding.judgement?.judgedAt ?? finding.createdAt;
  return { status: 'intended', at: judgedAt, note: finding.judgement?.note ?? null };
}

function judgedWith(state: ReportState, status: Finding['status']): Finding[] {
  return [...state.judged.values()].filter(
    (finding) => finding.status === status && decisionOf(state, finding) === null,
  );
}

/** Reproduced and not decided intended by the user. */
export function confirmedFindings(state: ReportState): Finding[] {
  return judgedWith(state, 'confirmed');
}

/**
 * Whether `finding` came from the findings file's `intended` list and its decision was taken back since:
 * it was never judged, so it stays with the intended findings until the next run judges it.
 */
export function isDecisionCleared(state: ReportState, finding: Finding): boolean {
  return finding.status === 'intended' && decisionOf(state, finding) === null;
}

/** Decided intended by the user, whatever the judge made of them, and those whose decision was cleared. */
export function intendedFindings(state: ReportState): Finding[] {
  return [...state.judged.values()].filter(
    (finding) => decisionOf(state, finding) !== null || finding.status === 'intended',
  );
}

/** Judged and not reproduced, or explained away; never listed as findings. */
export function rejectedFindings(state: ReportState): Finding[] {
  return judgedWith(state, 'rejected');
}

/** Whether `id` names a worth-a-look entry: set aside before judging, so not a finding. */
export function isWorthALook(state: ReportState, id: string): boolean {
  if (state.judged.has(id) || state.candidates.has(id)) return false;
  return state.worthALook.some((entry) => entry.id === id);
}

/** The finding `id` names: judged, still a candidate, or worth a look; `null` when the run has none. */
export function findingById(state: ReportState, id: string): Finding | null {
  return (
    state.judged.get(id) ??
    state.candidates.get(id) ??
    state.worthALook.find((finding) => finding.id === id) ??
    null
  );
}

export function findingsOnScreen(state: ReportState, screenId: string): Finding[] {
  return confirmedFindings(state).filter((finding) => isOnScreen(finding, screenId));
}

/** While the run is going, a captured screen the lenses have not finished with yet. */
export function isInspecting(state: ReportState, screen: Screen): boolean {
  return state.run.status === 'running' && screen.status === 'captured' && !state.inspections.has(screen.id);
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

/**
 * While the run is going, the candidates not judged yet: they are being reproduced. None once the run is
 * over, when what is still a candidate (a run not judged) will not be reproduced.
 */
export function reproducingFindings(state: ReportState): Finding[] {
  return state.run.status === 'running' ? [...state.candidates.values()] : [];
}

export function scorecard(state: ReportState, screenId: string): Scorecard {
  const onScreen = (finding: Finding) => isOnScreen(finding, screenId);
  const confirmed = findingsOnScreen(state, screenId);
  return {
    confirmed: countBySeverity(confirmed),
    worthALook: state.worthALook.filter(onScreen).length,
    rejected: rejectedFindings(state).filter(onScreen).length,
    reproducedEveryTime: confirmed.filter(reproducedEveryTime).length,
    // As logged, a screen's skips are each lens's in the order met, so a reason can come twice.
    skipped: talliedSkips(state.inspections.get(screenId)?.skipped ?? []),
    reproducing: reproducingFindings(state).filter(onScreen),
  };
}

/** The whole run's numbers, as a screen's scorecard counts them. */
export function runScorecard(state: ReportState): Scorecard {
  const confirmed = confirmedFindings(state);
  return {
    confirmed: countBySeverity(confirmed),
    worthALook: state.worthALook.length,
    rejected: rejectedFindings(state).length,
    reproducedEveryTime: confirmed.filter(reproducedEveryTime).length,
    skipped: state.skipped,
    reproducing: reproducingFindings(state),
  };
}

/** Whether the run is going and its event stream dropped, so the browser is reconnecting it. */
export function isReconnecting(state: ReportState): boolean {
  return (
    state.run.status === 'running' &&
    state.errors.some((error) => error.source === 'events' && error.message === STREAM_RECONNECTING)
  );
}

function sortedDifference(source: ReadonlySet<string>, other: ReadonlySet<string>): string[] {
  return [...source].filter((value) => !other.has(value)).toSorted(compareText);
}

/** `null` until the previous run's findings are loaded, and for a first run. */
export function drift(state: ReportState): Drift | null {
  const { previous } = state;
  if (previous === null) return null;
  // A run that was not judged lists its candidates as findings: those were never confirmed.
  const before = previous.findings.filter((finding) => finding.status === 'confirmed');
  const current = confirmedFindings(state);
  const intended = intendedFindings(state);
  const beforeIds = new Set(before.map((finding) => finding.id));
  const currentIds = new Set(current.map((finding) => finding.id));
  const intendedIds = new Set(intended.map((finding) => finding.id));
  const listedBefore = [
    ...previous.findings,
    ...previous.worthALook,
    ...previous.rejected,
    ...previous.intended,
  ];
  const routesBefore = new Set(listedBefore.flatMap(routesOf));
  const routesNow = new Set(state.screens.map((screen) => screen.route));
  return {
    added: current.filter((finding) => !beforeIds.has(finding.id)),
    fixed: before.filter((finding) => !currentIds.has(finding.id) && !intendedIds.has(finding.id)),
    unchanged: current.filter((finding) => beforeIds.has(finding.id)),
    intended: intended.filter((finding) => beforeIds.has(finding.id)),
    addedRoutes: sortedDifference(routesNow, routesBefore),
    removedRoutes: sortedDifference(routesBefore, routesNow),
  };
}
