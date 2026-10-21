import { relative } from 'node:path';
import {
  type AppMap,
  confirmHostCommand,
  type FindingsFile,
  isFailedScreen,
  type Screen,
} from '@jayslifecode/lookover-core';

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
}

/** Printed after the candidates: they are measurements, nothing has judged or reproduced them yet. */
export const CANDIDATES_NOTE =
  'Candidates are measured but not yet judged or reproduced; the judge arrives in the next release.';

const NO_HOSTS = 'none';
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
  ];
}

function inspectionRows({ cwd, inspection }: RunSummary): [string, string][] {
  if (inspection === undefined) {
    return [];
  }
  const { findings, findingsPath } = inspection;
  return [
    ['Candidates', String(findings.findings.length)],
    ['Worth a look', String(findings.worthALook.length)],
    ['Findings', displayPath(cwd, findingsPath)],
  ];
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
