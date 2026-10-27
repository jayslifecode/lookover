import { relative } from 'node:path';
import {
  type AppMap,
  confirmHostCommand,
  type FindingsFile,
  isFailedScreen,
  type JudgeTotals,
  type Screen,
  type SkipTally,
  type TokenUsage,
} from '@jayslifecode/lookover-core';
import { REPRODUCTION_ATTEMPTS } from '@jayslifecode/lookover-judge';

/** What the summary adds for a run that inspected its screens (not a `--map-only` run). */
export interface InspectionSummary {
  readonly findings: FindingsFile;
  /** The run's `findings.json`. */
  readonly findingsPath: string;
}

/** What the summary table reports about a finished run. */
export interface RunSummary {
  /** Paths are shown relative to this directory, the project's. */
  readonly cwd: string;
  readonly map: AppMap;
  readonly confirmedBackendHosts: readonly string[];
  readonly blockedRequests: number;
  readonly runDir: string;
  readonly appMapPath: string;
  readonly durationMs: number;
  /** Absent for a `--map-only` run: it has no findings to report. */
  readonly inspection?: InspectionSummary;
  /** The served report's URL; absent when no report is served (`--no-report`). */
  readonly reportUrl?: string;
}

/** Printed after the candidates of a `--no-judge` run: they are measurements, nothing judged or reproduced them. */
export const CANDIDATES_NOTE =
  'Candidates are measured but not reproduced or judged because the judge was turned off (--no-judge); run without it to confirm them.';

/** Printed after the confirmed findings of a run without `ANTHROPIC_API_KEY`: the harness decided alone. */
export const HARNESS_ONLY_NOTE = `Findings were reproduced ${REPRODUCTION_ATTEMPTS} times each but not reviewed by the judge model; set ANTHROPIC_API_KEY to enable it.`;

/** The Judge row of a run that was not judged. */
const JUDGE_OFF = 'off (--no-judge)';
/**
 * The Judge row of a run judged without the model, by why the model was not used. A `--no-judge` run's
 * file has `judge: null` (`JUDGE_OFF`), so `disabled` is never looked up here; it is kept so every reason
 * the totals can carry has its row.
 */
const HARNESS_ONLY: Readonly<Record<NonNullable<JudgeTotals['unavailable']> | 'unknown', string>> = {
  'no-api-key': 'harness only (no ANTHROPIC_API_KEY)',
  disabled: 'harness only (the judge model is turned off)',
  'api-error': 'harness only (the judge model failed)',
  unknown: 'harness only',
};
/** Ends the Judge row when the model failed partway, so the rest was decided by reproduction alone. */
const STOPPED_AFTER_API_ERROR = 'stopped after an API error';
const UNKNOWN_COST = 'cost unknown';
const JUDGE_SEPARATOR = ' · ';
const CENTS_DIGITS = 2;
/** Token counts are grouped by thousands the same way whatever the user's locale. */
const TOKEN_FORMAT = new Intl.NumberFormat('en-US');

const NO_HOSTS = 'none';
const NO_SKIPS = 'none';
/** The reasons the Skipped row lists: the most frequent, as the findings file orders them. */
const LISTED_SKIP_REASONS = 3;
const SKIP_SEPARATOR = ' · ';
const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const TENTHS_PER_SECOND = 10;

/**
 * One line per captured screen: `✓ /organisations/[id]  18 elements · 1 form`. A screen the page
 * was redirected to shows the path asked for, then where it landed:
 * `✓ /  → /home.html  18 elements · 1 form`. Once the screen has been inspected, `candidates` adds
 * what it yielded: `✓ /organisations/[id]  12 elements · 1 form · 2 candidates`.
 */
export function progressLine(screen: Screen, candidates?: number): string {
  if (isFailedScreen(screen)) {
    return `! ${screen.route}  navigation failed`;
  }
  const elements = count(screen.elements.length, 'element');
  const forms = count(screen.forms.length, 'form');
  const where =
    screen.redirectedFrom === null
      ? screen.route
      : `${pathOf(screen.redirectedFrom)}  → ${pathOf(screen.url)}`;
  const measured = [elements, forms, ...(candidates === undefined ? [] : [count(candidates, 'candidate')])];
  return `✓ ${where}  ${measured.join(' · ')}`;
}

/** The path of `href`, without the query a token may be in; `href` itself when it is not a URL. */
function pathOf(href: string): string {
  return URL.canParse(href) ? new URL(href).pathname : href;
}

export function summaryRows(summary: RunSummary): [string, string][] {
  const { screens } = summary.map;
  const elements = screens.reduce((total, screen) => total + screen.elements.length, 0);
  const forms = screens.reduce((total, screen) => total + screen.forms.length, 0);
  const hosts = summary.confirmedBackendHosts;
  return [
    ['Screens', String(screens.length)],
    ['Elements', String(elements)],
    ['Forms', String(forms)],
    ['Backend hosts', hosts.length === 0 ? NO_HOSTS : hosts.join(', ')],
    ['Blocked requests', String(summary.blockedRequests)],
    ['Run dir', displayPath(summary.cwd, summary.runDir)],
    ['App map', displayPath(summary.cwd, summary.appMapPath)],
    ['Duration', formatDuration(summary.durationMs)],
    ...inspectionRows(summary),
    ...reportRows(summary),
  ];
}

/** The URL of the report the run serves, last: the table ends where the user goes next. */
function reportRows({ reportUrl }: RunSummary): [string, string][] {
  return reportUrl === undefined ? [] : [['Report', reportUrl]];
}

/**
 * What became of the candidates, the worth-a-look entries, the skips, the judge and the findings file. A
 * judged run counts its confirmed, rejected and intended findings; a `--no-judge` run its candidates and
 * the findings its decisions left out as intended.
 */
function inspectionRows({ cwd, inspection }: RunSummary): [string, string][] {
  if (inspection === undefined) {
    return [];
  }
  const { findings, findingsPath } = inspection;
  return [
    ...outcomeRows(findings),
    ['Worth a look', String(findings.worthALook.length)],
    ['Skipped', skippedSummary(findings.skipped ?? [])],
    ['Judge', judgeSummary(findings.judge)],
    ['Findings', displayPath(cwd, findingsPath)],
  ];
}

/** A candidate the judge never decided on is in `findings` too, but it is not confirmed. */
function outcomeRows(file: FindingsFile): [string, string][] {
  if (file.judge === null) {
    return [
      ['Candidates', String(file.findings.length)],
      ['Intended', String(file.intended.length)],
    ];
  }
  const confirmed = file.findings.filter((finding) => finding.status === 'confirmed');
  return [
    ['Confirmed', String(confirmed.length)],
    ['Rejected', String(file.rejected.length)],
    ['Intended', String(file.intended.length)],
  ];
}

/**
 * The Judge row: `claude-sonnet-5-5 · 34 calls (3 cached) · 61,204 tokens · ≈ $0.19` when the model was
 * asked (ending `· stopped after an API error` when it failed partway), `harness only (no
 * ANTHROPIC_API_KEY)` when the harness decided alone, `off (--no-judge)` for a run that was not judged.
 */
export function judgeSummary(judge: JudgeTotals | null): string {
  if (judge === null) {
    return JUDGE_OFF;
  }
  if (judge.model === null) {
    return HARNESS_ONLY[judge.unavailable ?? 'unknown'];
  }
  return [
    judge.model,
    `${count(judge.calls, 'call')} (${judge.cacheHits} cached)`,
    `${TOKEN_FORMAT.format(totalTokens(judge.usage))} tokens`,
    judge.estimatedUsd === null ? UNKNOWN_COST : `≈ $${judge.estimatedUsd.toFixed(CENTS_DIGITS)}`,
    ...(judge.unavailable === 'api-error' ? [STOPPED_AFTER_API_ERROR] : []),
  ].join(JUDGE_SEPARATOR);
}

/**
 * What is printed under the findings list: the candidates note for a run that was not judged, the
 * harness-only note for one judged without `ANTHROPIC_API_KEY`, nothing when the model reviewed them.
 */
export function findingsNote(judge: JudgeTotals | null): string | null {
  if (judge === null) {
    return CANDIDATES_NOTE;
  }
  return judge.model === null && judge.unavailable === 'no-api-key' ? HARNESS_ONLY_NOTE : null;
}

function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * The most frequent reasons the lenses skipped a measurement for, with their counts:
 * `time-budget 12 · focus-indicator-ua-ring 9 · gone 1`; `none` when nothing was skipped.
 */
function skippedSummary(skipped: readonly SkipTally[]): string {
  if (skipped.length === 0) {
    return NO_SKIPS;
  }
  return skipped
    .slice(0, LISTED_SKIP_REASONS)
    .map(({ reason, count }) => `${reason} ${count}`)
    .join(SKIP_SEPARATOR);
}

/** `42.3 s` under a minute, `2 min 5 s` from then on. */
export function formatDuration(ms: number): string {
  const seconds = Math.round((ms / MS_PER_SECOND) * TENTHS_PER_SECOND) / TENTHS_PER_SECOND;
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds.toFixed(1)} s`;
  }
  const whole = Math.round(ms / MS_PER_SECOND);
  return `${Math.floor(whole / SECONDS_PER_MINUTE)} min ${whole % SECONDS_PER_MINUTE} s`;
}

/**
 * For backends the app called only after the confirmation step: nothing reached them. Each host is
 * listed as `labelHost` shows it; the command names the bare hosts.
 */
export function blockedHostsWarning(
  hosts: readonly string[],
  labelHost: (host: string) => string = (host) => host,
): string {
  return (
    `Blocked requests to backends that are not confirmed: ${hosts.map(labelHost).join(', ')}. ` +
    `If they are development or disposable instances, run: ${confirmHostCommand(hosts)}`
  );
}

/** `1 element`, `2 elements`. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Relative to the project when inside it, absolute otherwise. */
function displayPath(cwd: string, path: string): string {
  const shown = relative(cwd, path);
  return shown === '' || shown.startsWith('..') ? path : shown;
}
