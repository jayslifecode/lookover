import { relative } from 'node:path';
import { type AppMap, confirmHostCommand, isFailedScreen, type Screen } from '@jayslifecode/lookover-core';

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
}

const NO_HOSTS = 'none';
const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const TENTHS_PER_SECOND = 10;

/** One line per captured screen: `✓ /organisations/[id]  18 elements · 1 form`. */
export function progressLine(screen: Screen): string {
  if (isFailedScreen(screen)) {
    return `! ${screen.route}  navigation failed`;
  }
  const elements = count(screen.elements.length, 'element');
  const forms = count(screen.forms.length, 'form');
  return `✓ ${screen.route}  ${elements} · ${forms}`;
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

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Relative to the project when inside it, absolute otherwise. */
function displayPath(cwd: string, path: string): string {
  const shown = relative(cwd, path);
  return shown === '' || shown.startsWith('..') ? path : shown;
}
