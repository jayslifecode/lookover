import type {
  DecisionsFile,
  EvidenceRef,
  Finding,
  FindingsFile,
  JudgeTotals,
  RunEvent,
  Screen,
  SkipTally,
} from '@jayslifecode/lookover-core';
import type { RunManifest, RunStatus } from '../../node/api';

/*
 * What the report knows about the run, and the pure functions that move it on: `reduce` folds one event
 * of the run log into it; the `with…` functions take in what the store loaded besides (the manifest, the
 * findings file, the decisions, the previous run). Nothing here mutates: every change is a new state
 * that shares what did not change. `reduce` is idempotent per event and handles every event type, so a
 * resumed stream that repeats events, or an event type it does not know, never breaks it.
 */

/** Where the findings come from: the run's events, or its `findings.json`, which then wins for good. */
export type FindingsSource = 'events' | 'file';

export type ReportErrorSource = 'manifest' | 'events' | 'findings' | 'decisions' | 'previous';

/** Something the report could not load, said in plain words for the UI. */
export interface ReportError {
  readonly source: ReportErrorSource;
  readonly message: string;
}

/** What the run finished with (`run.finished`). */
export interface RunCounts {
  readonly screens: number;
  readonly confirmed: number;
  readonly rejected: number;
  readonly intended: number;
  readonly worthALook: number;
}

export interface RunInfo {
  readonly status: RunStatus;
  readonly baseUrl: string | null;
  readonly startedAt: string | null;
  /** When `run.finished` or `run.failed` closed the run; `null` while it is open. */
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  /** The failure `run.failed` carried. */
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly counts: RunCounts | null;
}

/** One screen's `screen.inspected`. */
export interface ScreenInspection {
  readonly durationMs: number;
  readonly candidates: number;
  readonly worthALook: number;
  readonly skipped: readonly SkipTally[];
  /** The screen's state gallery; `null` when no lens wrote one (or the log is older than the field). */
  readonly gallery: EvidenceRef | null;
  readonly error: string | null;
}

export interface ReportState {
  readonly manifest: RunManifest | null;
  readonly run: RunInfo;
  /** The captured screens, by capture time (then id), whatever order their events came in. */
  readonly screens: readonly Screen[];
  readonly inspections: ReadonlyMap<string, ScreenInspection>;
  /** Seen by the lenses, not judged yet; by id. */
  readonly candidates: ReadonlyMap<string, Finding>;
  /** Judged or decided (`confirmed`, `rejected`, `intended`); by id. */
  readonly judged: ReadonlyMap<string, Finding>;
  /** The lower-confidence entries; only `findings.json` lists them. */
  readonly worthALook: readonly Finding[];
  /** What the lenses skipped across the run, per reason, the most frequent first. */
  readonly skipped: readonly SkipTally[];
  readonly totals: JudgeTotals | null;
  readonly findingsSource: FindingsSource;
  /** The project's decisions; `null` until loaded. */
  readonly decisions: DecisionsFile | null;
  /** The previous run's findings, for drift; `null` when there is none, or until loaded. */
  readonly previous: FindingsFile | null;
  /** At most one per source, the latest. */
  readonly errors: readonly ReportError[];
  /** The highest `seq` reduced so far. */
  readonly lastSeq: number;
}

export function initialState(): ReportState {
  return {
    manifest: null,
    run: {
      status: 'running',
      baseUrl: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      error: null,
      counts: null,
    },
    screens: [],
    inspections: new Map(),
    candidates: new Map(),
    judged: new Map(),
    worthALook: [],
    skipped: [],
    totals: null,
    findingsSource: 'events',
    decisions: null,
    previous: null,
    errors: [],
    lastSeq: 0,
  };
}

type EventOf<T extends RunEvent['type']> = Extract<RunEvent, { type: T }>;

/** By code point, so the order does not depend on the locale. */
export function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareScreens(a: Screen, b: Screen): number {
  return compareText(a.capturedAt, b.capturedAt) || compareText(a.id, b.id);
}

/** `skips` added up per reason, the most frequent first, then by reason. */
export function talliedSkips(skips: readonly SkipTally[]): SkipTally[] {
  const counts = skips.reduce(
    (sum, { reason, count }) => new Map(sum).set(reason, (sum.get(reason) ?? 0) + count),
    new Map<string, number>(),
  );
  return [...counts]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || compareText(a.reason, b.reason));
}

/** The skips of every inspected screen added up per reason, the most frequent first, then by reason. */
function tallySkips(inspections: ReadonlyMap<string, ScreenInspection>): SkipTally[] {
  return talliedSkips([...inspections.values()].flatMap((inspection) => inspection.skipped));
}

function withoutKey<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  if (!map.has(key)) return map;
  return new Map([...map].filter(([id]) => id !== key));
}

function withEntry<V>(map: ReadonlyMap<string, V>, key: string, value: V): ReadonlyMap<string, V> {
  return new Map(map).set(key, value);
}

/** A screen captured again (a resumed stream) replaces itself. */
function onScreenCaptured(state: ReportState, { screen }: EventOf<'screen.captured'>): ReportState {
  const others = state.screens.filter((known) => known.id !== screen.id);
  return { ...state, screens: [...others, screen].sort(compareScreens) };
}

function onScreenInspected(state: ReportState, event: EventOf<'screen.inspected'>): ReportState {
  const { durationMs, candidates, worthALook, skipped, error } = event;
  const inspections = withEntry(state.inspections, event.screenId, {
    durationMs,
    candidates,
    worthALook,
    skipped,
    // A log written before screen.inspected named the gallery has no such field.
    gallery: event.gallery ?? null,
    error,
  });
  // Once the findings file is in, its own tally is the run's.
  const tally = state.findingsSource === 'file' ? state.skipped : tallySkips(inspections);
  return { ...state, inspections, skipped: tally };
}

/** A candidate seen again replaces itself; one for a finding already judged is stale and ignored. */
function onCandidate(state: ReportState, { finding }: EventOf<'finding.candidate'>): ReportState {
  if (state.findingsSource === 'file' || state.judged.has(finding.id)) return state;
  return { ...state, candidates: withEntry(state.candidates, finding.id, finding) };
}

/** A judge batch can finish after the crawl failed; the failed run's findings stay as they were. */
function onJudged(state: ReportState, { finding }: EventOf<'finding.judged'>): ReportState {
  if (state.findingsSource === 'file' || state.run.error !== null) return state;
  return {
    ...state,
    candidates: withoutKey(state.candidates, finding.id),
    judged: withEntry(state.judged, finding.id, finding),
  };
}

function onStarted(state: ReportState, event: EventOf<'run.started'>): ReportState {
  return { ...state, run: { ...state.run, baseUrl: event.baseUrl, startedAt: event.at } };
}

function onFinished(state: ReportState, event: EventOf<'run.finished'>): ReportState {
  const { screens, confirmed, rejected, intended, worthALook } = event;
  return {
    ...state,
    run: {
      ...state.run,
      status: 'finished',
      finishedAt: event.at,
      durationMs: event.durationMs,
      error: null,
      counts: { screens, confirmed, rejected, intended, worthALook },
    },
    totals: state.findingsSource === 'file' ? state.totals : event.judge,
  };
}

function onFailed(state: ReportState, event: EventOf<'run.failed'>): ReportState {
  return { ...state, run: { ...state.run, status: 'failed', finishedAt: event.at, error: event.error } };
}

/** The state after `event`; the same state for an event type the report does not know. */
export function reduce(state: ReportState, event: RunEvent): ReportState {
  const next = apply(state, event);
  if (next === null) return state;
  return next.lastSeq >= event.seq ? next : { ...next, lastSeq: event.seq };
}

/** `null` for an unknown event type. */
function apply(state: ReportState, event: RunEvent): ReportState | null {
  switch (event.type) {
    case 'run.started':
      return onStarted(state, event);
    case 'screen.captured':
      return onScreenCaptured(state, event);
    case 'screen.inspected':
      return onScreenInspected(state, event);
    case 'finding.candidate':
      return onCandidate(state, event);
    case 'finding.judged':
      return onJudged(state, event);
    case 'run.finished':
      return onFinished(state, event);
    case 'run.failed':
      return onFailed(state, event);
    case 'route.discovered':
    case 'auth.completed':
    case 'auth.lost':
    case 'host.observed':
    case 'request.blocked':
    case 'screen.discovered':
    case 'screen.skipped':
    case 'screen.truncated':
    case 'judge.unavailable':
      return state;
    default:
      return null;
  }
}

/** Whether the events have closed the run (`run.finished` or `run.failed`). */
export function isRunClosed(state: ReportState): boolean {
  return state.run.finishedAt !== null;
}

/** The manifest's status stands until the events close the run; they are the newer word. */
export function withManifest(state: ReportState, manifest: RunManifest): ReportState {
  return {
    ...state,
    manifest,
    run: {
      ...state.run,
      status: isRunClosed(state) ? state.run.status : manifest.status,
      baseUrl: state.run.baseUrl ?? manifest.baseUrl,
      startedAt: state.run.startedAt ?? manifest.startedAt,
    },
  };
}

function byId(findings: readonly Finding[]): ReadonlyMap<string, Finding> {
  return new Map(findings.map((finding) => [finding.id, finding]));
}

/**
 * The run's `findings.json` replaces the findings the events built, for good: a run that was not judged
 * lists its candidates there, a judged one its confirmed, rejected and intended findings.
 */
export function withFindingsFile(state: ReportState, file: FindingsFile): ReportState {
  const listed = [...file.findings, ...file.rejected, ...file.intended];
  return {
    ...state,
    candidates: byId(listed.filter((finding) => finding.status === 'candidate')),
    judged: byId(listed.filter((finding) => finding.status !== 'candidate')),
    worthALook: file.worthALook,
    skipped: file.skipped ?? tallySkips(state.inspections),
    totals: file.judge,
    findingsSource: 'file',
  };
}

export function withDecisions(state: ReportState, decisions: DecisionsFile): ReportState {
  return { ...state, decisions };
}

export function withPrevious(state: ReportState, previous: FindingsFile | null): ReportState {
  return { ...state, previous };
}

/** Keeps the latest error of each source. */
export function withError(state: ReportState, error: ReportError): ReportState {
  return { ...state, errors: [...state.errors.filter((known) => known.source !== error.source), error] };
}
