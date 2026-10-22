/*
 * The standalone replay: what a script from `generateStandaloneScript` runs. It is bundled with core, the
 * lenses and the rules into `dist/standalone-runner.js` (see `scripts/bundle-standalone.ts`), Playwright
 * left out, so the script needs nothing but Playwright and its Chromium. It is a script's entry point, so
 * it prints to the process's own streams and sets its exit code.
 */
import { resolve } from 'node:path';
import {
  configSchema,
  type Finding,
  isAllowedHost,
  type Lens,
  LookoverError,
  launchSession,
  normaliseHost,
  redact,
  type Step,
  usingSession,
  type Viewport,
} from '@jayslifecode/lookover-core';
import { InteractionLens } from '@jayslifecode/lookover-lenses';
import {
  attemptLines,
  inTemporaryRun,
  isFullyReproduced,
  leadViewport,
  type ReplayResult,
  replayHeading,
  replayIn,
  replayScreens,
  replaySummary,
} from '../replay.js';

/** Replaced by the bundle with the version of Lookover it was built from; undefined anywhere else. */
declare const LOOKOVER_VERSION: string | undefined;

export interface StandaloneOptions {
  /** The origin to replay on: every URL of the finding is moved onto it, its path kept. */
  baseUrl: string;
  headless: boolean;
  /** Fresh browser contexts to measure the finding in. */
  times: number;
  /** A Playwright storage state file to start from, for a finding behind a login; none when empty. */
  storageState?: string | undefined;
}

const EXIT_REPRODUCED = 0;
const EXIT_NOT_REPRODUCED = 1;
const UNBUNDLED_VERSION = '0.0.0-unbundled';
const VERSION = typeof LOOKOVER_VERSION === 'string' ? LOOKOVER_VERSION : UNBUNDLED_VERSION;
/** The interaction mode only matters to lenses that act on data; a replay never does. */
const INTERACTION = 'safe';

/**
 * Replays `finding` on `options.baseUrl` as `lookover replay` does, with no config: no auth beyond an
 * optional storage state, and only the base URL's host allowed (the loopback always is) with no backend
 * confirmed, so the app's calls to any other host are blocked. Prints what it replays, one line per
 * attempt and `reproduced <n>/<of>`; the exit code is 0 when every attempt reproduced it and 1 otherwise,
 * an error included (its message, redacted, goes to stderr).
 */
export async function main(finding: Finding, options: StandaloneOptions): Promise<void> {
  try {
    const times = checkedTimes(options.times);
    const rebased = rebaseFinding(finding, originOf(options.baseUrl));
    print(replayHeading(rebased, times));
    const result = await replayStandalone(rebased, { ...options, times });
    for (const line of [...attemptLines(result.attempts), replaySummary(result)]) print(line);
    process.exitCode = isFullyReproduced(result) ? EXIT_REPRODUCED : EXIT_NOT_REPRODUCED;
  } catch (error) {
    for (const line of errorLines(error)) process.stderr.write(`${line}\n`);
    process.exitCode = EXIT_NOT_REPRODUCED;
  }
}

async function replayStandalone(finding: Finding, options: StandaloneOptions): Promise<ReplayResult> {
  const config = configSchema.parse({
    baseUrl: options.baseUrl,
    interaction: INTERACTION,
    viewports: viewportsOf(finding),
  });
  const storageState = options.storageState ?? '';
  return inTemporaryRun(config, async (ctx) => {
    const session = await launchSession({
      viewport: leadViewport(finding),
      allowHosts: allowedHostsFor(options.baseUrl),
      onEvent: () => undefined,
      headless: options.headless,
      ...(storageState === '' ? {} : { storageStatePath: resolve(storageState) }),
    });
    return usingSession(session, () => {
      session.enforceConfirmedHosts([]);
      return replayIn({
        session,
        ctx,
        finding,
        lenses: lensesFor(finding),
        viewports: config.viewports,
        interaction: config.interaction,
        times: options.times,
        lookoverVersion: VERSION,
      });
    });
  });
}

/** The finding with every URL on `origin`: the trace's and its navigations', or each occurrence's. */
function rebaseFinding(finding: Finding, origin: URL): Finding {
  if (finding.shape === 'occurrence') {
    return {
      ...finding,
      occurrences: finding.occurrences.map((occurrence) => ({
        ...occurrence,
        url: moved(occurrence.url, origin),
      })),
    };
  }
  const steps = finding.trace.steps.map(
    (step): Step => (step.kind === 'navigate' ? { ...step, url: moved(step.url, origin) } : step),
  );
  return { ...finding, trace: { ...finding.trace, url: moved(finding.trace.url, origin), steps } };
}

/** `url` with the scheme, host and port of `origin`, its path, query and fragment kept. */
function moved(url: string, origin: URL): string {
  const next = new URL(url);
  next.protocol = origin.protocol;
  next.hostname = origin.hostname;
  next.port = origin.port;
  return next.href;
}

function originOf(baseUrl: string): URL {
  if (!URL.canParse(baseUrl)) throw new Error(`The base URL "${baseUrl}" is not a URL`);
  return new URL(new URL(baseUrl).origin);
}

/** The base URL's host, unless it is a local one, which the envelope always allows. */
function allowedHostsFor(baseUrl: string): string[] {
  const host = normaliseHost(new URL(baseUrl).hostname);
  return isAllowedHost(host, []) ? [] : [host];
}

/** Each viewport the finding was seen at, once. */
function viewportsOf(finding: Finding): Viewport[] {
  const viewports = replayScreens(finding).map((screen) => screen.viewport);
  const names = viewports.map(({ name }) => name);
  return viewports.filter(({ name }, index) => names.indexOf(name) === index);
}

/** The interaction lens for its findings; an observer finding is measured by the observers alone. */
function lensesFor(finding: Finding): Lens[] {
  return finding.source === 'interaction' ? [new InteractionLens()] : [];
}

function checkedTimes(times: number): number {
  if (!Number.isInteger(times) || times < 1) {
    throw new Error('TIMES must be a whole number above 0, such as TIMES=3');
  }
  return times;
}

function errorLines(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof LookoverError && error.hint !== undefined ? [`  hint: ${error.hint}`] : [];
  return [`✖ ${message}`, ...hint].map((line) => redact(line));
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}
