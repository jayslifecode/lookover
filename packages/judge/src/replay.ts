import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type Attempt,
  type BrowserSession,
  createRun,
  defaultObservers,
  type Environment,
  ensureAuth,
  type Finding,
  type Lens,
  type LookoverConfig,
  launchSession,
  type RunContext,
  redactDeep,
  type Screen,
  usingSession,
  type Viewport,
} from '@jayslifecode/lookover-core';
import { batchesFor } from './batch.js';
import { Harness } from './harness.js';

/** A replay measures the finding in this many fresh contexts unless asked for more. */
export const DEFAULT_REPLAY_TIMES = 1;

export interface ReplayOptions {
  /** The project directory: a storage state path in `config.auth` is resolved against it. */
  cwd: string;
  config: LookoverConfig;
  finding: Finding;
  /** The lens that reported the finding (none for an observer finding). */
  lenses: readonly Lens[];
  /** Lookover's own version, recorded in the environment. */
  lookoverVersion: string;
  /** Fresh contexts to measure it in; default `DEFAULT_REPLAY_TIMES`. */
  times?: number;
  /** Default `true`, as `BrowserSession.launch` has it. */
  headless?: boolean;
  /** Where a form login reads its credentials. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface ReplayResult {
  /** Every attempt at every target, in order: an occurrence finding's targets one after the other. */
  attempts: Attempt[];
  /** The attempts that reproduced it. */
  reproduced: number;
  /** The attempts made. */
  of: number;
  environment: Environment;
}

/** What a replay needs once its session is open and logged in. */
export interface ReplaySession {
  session: BrowserSession;
  ctx: RunContext;
  finding: Finding;
  lenses: readonly Lens[];
  viewports: readonly Viewport[];
  interaction: 'full' | 'safe';
  times: number;
  lookoverVersion: string;
}

type Auth = LookoverConfig['auth'];

const TEMP_PREFIX = 'lookover-replay-';
const STATE_DIR = 'state';
const LINE_SEPARATOR = '  ';
const REPRODUCED = 'reproduced';
const NOT_REPRODUCED = 'not reproduced';
const NOT_SEEN = 'not seen again';
const MS_PER_SECOND = 1_000;

/**
 * Measures one finding again, as the judge does, in a browser session of its own: launched inside the
 * network envelope as the engine launches a run's (the config's `allowHosts`, its storage state), the
 * config's confirmed backends enforced (any other backend is blocked, with no probe to ask), and logged
 * in as `config.auth` says. Its evidence and log go to a temporary run directory that is removed
 * afterwards, so nothing is written under the project. The session is always closed.
 */
export async function runReplay(options: ReplayOptions): Promise<ReplayResult> {
  const { config, finding, headless, env } = options;
  const auth = resolveAuth(config.auth, options.cwd);
  return inTemporaryRun(config, async (ctx) => {
    const session = await launchSession({
      viewport: leadViewport(finding),
      allowHosts: config.allowHosts,
      // No run log keeps the hosts it saw, and no probe asks about them: the confirmed ones are enforced.
      onEvent: () => undefined,
      ...(headless === undefined ? {} : { headless }),
      ...(auth.type === 'storageState' ? { storageStatePath: auth.path } : {}),
    });
    return usingSession(session, async () => {
      session.enforceConfirmedHosts(config.confirmedBackendHosts);
      await ensureAuth(session, auth, {
        baseUrl: config.baseUrl,
        stateDir: join(ctx.lookoverDir, STATE_DIR),
        ...(env === undefined ? {} : { env }),
      });
      return replayIn({
        session,
        ctx,
        finding,
        lenses: options.lenses,
        viewports: config.viewports,
        interaction: config.interaction,
        times: options.times ?? DEFAULT_REPLAY_TIMES,
        lookoverVersion: options.lookoverVersion,
      });
    });
  });
}

/** Runs `use` with a run in a fresh temporary directory, which is removed afterwards whatever happened. */
export async function inTemporaryRun<T>(
  config: LookoverConfig,
  use: (ctx: RunContext) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    return await use(await createRun({ cwd, config }));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * The harness, `times` fresh contexts, on each screen the finding was seen on (see `replayScreens`), one
 * screen after the other; the attempts of every target are added up. The result is redacted, as a run's
 * findings are before anyone sees them: what an attempt saw can quote the page.
 */
export async function replayIn(run: ReplaySession): Promise<ReplayResult> {
  const { ctx, finding } = run;
  const harness = new Harness({
    session: run.session,
    ctx,
    lenses: run.lenses,
    observers: () => defaultObservers(ctx),
    viewports: run.viewports,
    interaction: run.interaction,
    attempts: run.times,
    lookoverVersion: run.lookoverVersion,
  });
  let attempts: Attempt[] = [];
  for (const screen of replayScreens(finding)) {
    const result = await harness.reproduce(batchesFor(screen, [finding]));
    attempts = [...attempts, ...[...result.values()].flat()];
  }
  return redactDeep({
    attempts,
    reproduced: attempts.filter((attempt) => attempt.reproduced).length,
    of: attempts.length,
    environment: harness.environment(leadViewport(finding)),
  });
}

/**
 * The screens to load again, rebuilt from the finding: a step finding's from its trace, an occurrence
 * finding's one for each distinct screen it was seen on, in order. They hold no elements: the harness
 * extracts them again on the fresh page and matches the target by its selector.
 */
export function replayScreens(finding: Finding): Screen[] {
  if (finding.shape === 'step') {
    const { url, route, viewport } = finding.trace;
    return [rebuiltScreen(finding, { id: finding.screenId, url, route, viewport })];
  }
  const ids = finding.occurrences.map((occurrence) => occurrence.screenId);
  return finding.occurrences
    .filter((occurrence, index) => ids.indexOf(occurrence.screenId) === index)
    .map(({ screenId, url, route, viewport }) =>
      rebuiltScreen(finding, { id: screenId, url, route, viewport }),
    );
}

/** One line per attempt: its number, whether it reproduced, what it saw or why not, and how long it took. */
export function attemptLines(attempts: readonly Attempt[]): string[] {
  const numberWidth = String(attempts.length).length;
  const outcomes = attempts.map((attempt) => (attempt.reproduced ? REPRODUCED : NOT_REPRODUCED));
  const outcomeWidth = Math.max(0, ...outcomes.map((outcome) => outcome.length));
  return attempts.map((attempt, index) =>
    [
      String(index + 1).padStart(numberWidth),
      (outcomes[index] ?? '').padEnd(outcomeWidth),
      detailOf(attempt),
      `${(attempt.durationMs / MS_PER_SECOND).toFixed(1)} s`,
    ].join(LINE_SEPARATOR),
  );
}

/** `reproduced <n>/<of>`. */
export function replaySummary({ reproduced, of }: Pick<ReplayResult, 'reproduced' | 'of'>): string {
  return `reproduced ${reproduced}/${of}`;
}

/** Every attempt reproduced it, and there was at least one. */
export function isFullyReproduced({ reproduced, of }: Pick<ReplayResult, 'reproduced' | 'of'>): boolean {
  return of > 0 && reproduced === of;
}

/** `Replaying <id> (<rule>) on <url>, <n> attempts`, said before the browser opens. */
export function replayHeading(finding: Finding, times: number): string {
  const url = finding.shape === 'step' ? finding.trace.url : (finding.occurrences[0]?.url ?? '');
  const attempts = times === 1 ? '1 attempt' : `${times} attempts`;
  return `Replaying ${finding.id} (${finding.rule.id}) on ${url}, ${attempts}`;
}

function detailOf(attempt: Attempt): string {
  if (attempt.reproduced) return attempt.observed ?? '';
  return attempt.skipped === null ? NOT_SEEN : `skipped: ${attempt.skipped}`;
}

function rebuiltScreen(finding: Finding, place: Pick<Screen, 'id' | 'url' | 'route' | 'viewport'>): Screen {
  return {
    ...place,
    viewport: { ...place.viewport },
    title: '',
    status: 'captured',
    error: null,
    screenshot: null,
    elements: [],
    forms: [],
    tokens: [],
    links: [],
    redirectedFrom: null,
    discoveredFrom: null,
    capturedAt: finding.createdAt,
  };
}

/** The viewport the finding was first seen at: its trace's, or its first occurrence's. */
export function leadViewport(finding: Finding): Viewport {
  const viewport = finding.shape === 'step' ? finding.trace.viewport : finding.occurrences[0]?.viewport;
  if (viewport === undefined) throw new Error(`The finding ${finding.id} has no occurrence to replay`);
  return viewport;
}

/** A storage state path is relative to the project directory, as the engine has it. */
function resolveAuth(auth: Auth, cwd: string): Auth {
  return auth.type === 'storageState' ? { ...auth, path: resolve(cwd, auth.path) } : auth;
}
