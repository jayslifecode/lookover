import { join, resolve } from 'node:path';
import { checkStorageState, type EnsureAuthOptions, ensureAuth, isLoginUrl } from '../browser/auth.js';
import { isAllowedHost, networkHost, normaliseHost } from '../browser/network-policy.js';
import { BrowserSession, type SessionEvent, type SessionOptions } from '../browser/session.js';
import { CONFIG_FILENAME } from '../config/load.js';
import type { LookoverConfig } from '../config/schema.js';
import { type ErrorCode, LookoverError } from '../errors.js';
import { type CrawlOptions, crawl } from '../map/crawler.js';
import { discoverNextRoutes, staticRoutePatterns } from '../map/next-routes.js';
import { writeAppMap } from '../map/persist.js';
import type { AppMap, RouteInfo, Screen, Viewport } from '../map/types.js';
import {
  type ConfirmHosts,
  confirmBackends,
  confirmHostCommand,
  EDIT_CONFIG_ALTERNATIVE,
} from './backend-probe.js';
import type { RunEvent } from './events.js';
import type { RunContext } from './run-context.js';
import type { RunLog } from './run-log.js';

export interface DiscoveryHooks {
  /**
   * Asked once, after the probe, with every backend host the app called during the probe that is
   * neither allowed nor already confirmed in the config (sorted). Returns the ones the user confirms
   * are development or disposable instances; the run refuses to go on while any host is left out.
   */
  confirmHosts?: ConfirmHosts;
  /** Every event of the run as the log writes it, from `run.started` to `run.finished` or `run.failed`. */
  onEvent?: (event: RunEvent) => void;
}

export interface DiscoveryOptions {
  /** The project directory: `config.root` and a storage state path are resolved against it. */
  cwd: string;
  headless?: boolean;
  /** Where a form login reads its credentials. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  hooks?: DiscoveryHooks;
}

export interface DiscoveryResult {
  map: AppMap;
  /** `config.confirmedBackendHosts` plus the hosts confirmed in this run, deduplicated, to persist. */
  confirmedBackendHosts: string[];
  /**
   * Hosts the app called after the confirmation step that were blocked as unconfirmed backends
   * (sorted); nothing reached them. The engine only asks about hosts the probe observed, so these are
   * confirmed outside it: with `--confirm-host`, which the CLI merges into `confirmedBackendHosts`
   * before the run, or by adding them to `confirmedBackendHosts` in lookover.config.json.
   */
  blockedUnconfirmedHosts: string[];
}

type Auth = LookoverConfig['auth'];

/** What the crawl needs besides the config, worked out before the browser starts. */
interface CrawlPlan {
  routes: RouteInfo[];
  viewport: Viewport;
}

const STATE_DIR = 'state';
const ROOT_SEED = '/';
/** How Playwright names a storage state it cannot read or will not accept. */
const STORAGE_STATE_ERROR = /storage ?state/i;
const RUN_LOG_HINT = 'Check that the .lookover directory is writable and its disk has room';

/**
 * Stage 1 end to end, recorded in the run log from `run.started` to `run.finished`:
 *
 * 1. The routes on disk (Next.js only), each logged as `route.discovered`.
 * 2. One browser session inside the network envelope, at the first viewport; its events go to the
 *    run log.
 * 3. The probe, before logging in (see `confirmBackends`): the run refuses (`E_HOSTS_UNCONFIRMED`) to go
 *    on while a backend the app called is not confirmed as a development or disposable instance.
 *    From then on the session blocks every other backend (`unconfirmed-backend`), login included.
 * 4. The login as `config.auth` says (`auth.completed`).
 * 5. The bounded crawl from `/` and every static route, logging in again once if the session is lost.
 * 6. The App Map, written to the run directory and as the project's latest.
 *
 * Any failure is logged as `run.failed` (code `E_RUN_FAILED` for errors that are not a `LookoverError`)
 * and rethrown; see `recordFailure` for what is added to it. A run that otherwise succeeded but whose
 * log lost an event fails with `E_RUN_FAILED` ("Run log write failed"), since it has no complete
 * record. The session is always closed.
 */
export async function runDiscovery(ctx: RunContext, opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const startedAt = performance.now();
  const recorder = new SessionRecorder(ctx.log);
  const onEvent = opts.hooks?.onEvent;
  const unsubscribe = onEvent === undefined ? () => undefined : ctx.log.subscribe(onEvent);
  try {
    const result = await discover(ctx, opts, recorder);
    await ctx.log.append({
      type: 'run.finished',
      screens: result.map.screens.length,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return result;
  } catch (error) {
    throw await recordFailure(ctx.log, recorder, error);
  } finally {
    unsubscribe();
  }
}

async function discover(
  ctx: RunContext,
  opts: DiscoveryOptions,
  recorder: SessionRecorder,
): Promise<DiscoveryResult> {
  const { config } = ctx;
  await ctx.log.append({
    type: 'run.started',
    baseUrl: config.baseUrl,
    interaction: config.interaction,
    viewports: config.viewports,
  });
  const viewport = firstViewport(config);
  assertBaseUrlAllowed(config);
  const routes = await discoverRoutes(ctx, opts.cwd);
  const { screens, confirmedBackendHosts } = await explore(ctx, opts, recorder, { routes, viewport });
  await recorder.assertComplete();
  const map: AppMap = {
    version: 1,
    runId: ctx.runId,
    createdAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    routes,
    screens,
  };
  await writeAppMap(ctx, map);
  return { map, confirmedBackendHosts, blockedUnconfirmedHosts: recorder.blockedUnconfirmedHosts() };
}

async function discoverRoutes(ctx: RunContext, cwd: string): Promise<RouteInfo[]> {
  if (ctx.config.framework !== 'next') {
    return [];
  }
  const routes = await discoverNextRoutes(resolve(cwd, ctx.config.root));
  for (const route of routes) {
    await ctx.log.append({ type: 'route.discovered', route });
  }
  return routes;
}

/** Steps 2 to 5, in one session that is closed whatever happens. */
async function explore(
  ctx: RunContext,
  opts: DiscoveryOptions,
  recorder: SessionRecorder,
  plan: CrawlPlan,
): Promise<{ screens: Screen[]; confirmedBackendHosts: string[] }> {
  const { config } = ctx;
  const auth = resolveAuth(config.auth, opts.cwd);
  const session = await launchSession({
    viewport: plan.viewport,
    allowHosts: config.allowHosts,
    onEvent: recorder.record,
    ...(opts.headless === undefined ? {} : { headless: opts.headless }),
    ...(auth.type === 'storageState' ? { storageStatePath: auth.path } : {}),
  });
  return usingSession(session, async () => {
    const confirmedBackendHosts = await confirmBackends(
      session,
      config,
      plan.routes,
      opts.hooks?.confirmHosts,
    );
    session.enforceConfirmedHosts(confirmedBackendHosts);
    const logIn = loginStep(ctx, session, auth, opts.env);
    await logIn();
    const screens = await crawl(session, ctx, crawlOptions(config, plan, auth, logIn));
    return { screens, confirmedBackendHosts };
  });
}

/** A storage state path is relative to the project directory, not to wherever the process runs. */
function resolveAuth(auth: Auth, cwd: string): Auth {
  return auth.type === 'storageState' ? { ...auth, path: resolve(cwd, auth.path) } : auth;
}

/**
 * Launches the session. A storage state is checked first, so a missing or malformed file fails as the
 * auth problem it is (`E_AUTH_FAILED` naming the file) rather than as a browser error; so does a file the
 * browser still rejects, such as one holding a cookie it cannot use.
 */
async function launchSession(options: SessionOptions): Promise<BrowserSession> {
  const statePath = options.storageStatePath;
  if (statePath !== undefined) {
    await checkStorageState(statePath);
  }
  try {
    return await BrowserSession.launch(options);
  } catch (error) {
    if (statePath === undefined || !STORAGE_STATE_ERROR.test(messageOf(error))) {
      throw error;
    }
    throw new LookoverError(
      'E_AUTH_FAILED',
      `The browser rejected the storage state file ${statePath}: ${firstLine(error)}`,
      `Save the storage state again with Playwright, or point auth.path in ${CONFIG_FILENAME} at another file`,
    );
  }
}

/** Runs `use`, then closes the session. When `use` failed, its error is the one surfaced. */
async function usingSession<T>(session: BrowserSession, use: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await use();
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
  await session.close();
  return result;
}

/** Logs the session in as `auth` says and records how; the crawl runs it again when a form login is lost. */
function loginStep(
  ctx: RunContext,
  session: BrowserSession,
  auth: Auth,
  env: NodeJS.ProcessEnv | undefined,
): () => Promise<void> {
  const options: EnsureAuthOptions = {
    baseUrl: ctx.config.baseUrl,
    stateDir: join(ctx.lookoverDir, STATE_DIR),
    ...(env === undefined ? {} : { env }),
  };
  return async () => {
    const result = await ensureAuth(session, auth, options);
    await ctx.log.append({ type: 'auth.completed', ...result });
  };
}

function crawlOptions(
  config: LookoverConfig,
  plan: CrawlPlan,
  auth: Auth,
  logIn: () => Promise<void>,
): CrawlOptions {
  return {
    baseUrl: config.baseUrl,
    // Dynamic patterns have no URL of their own; links reach them.
    seeds: [...new Set([ROOT_SEED, ...staticRoutePatterns(plan.routes)])],
    routes: plan.routes,
    maxScreens: config.maxScreens,
    maxPerRoute: config.maxPerRoute,
    viewport: plan.viewport,
    ...(auth.type === 'none'
      ? {}
      : {
          auth: {
            isLoginUrl: (url: URL) => isLoginUrl(url, auth, config.baseUrl),
            recover: auth.type === 'form' ? logIn : savedSessionExpired,
          },
        }),
  };
}

/** A storage state cannot log in again: it only holds the session that has just been lost. */
function savedSessionExpired(): Promise<void> {
  return Promise.reject(
    new LookoverError(
      'E_AUTH_FAILED',
      'The saved session expired during the run',
      'Save the storage state again and re-run',
    ),
  );
}

function firstViewport(config: LookoverConfig): Viewport {
  const [viewport] = config.viewports;
  if (viewport === undefined) {
    throw new LookoverError(
      'E_CONFIG_INVALID',
      `${CONFIG_FILENAME} lists no viewports, so there is nothing to capture screens at`,
      'Add a viewport to "viewports", such as { "name": "desktop", "width": 1440, "height": 900 }',
    );
  }
  return viewport;
}

/** The browser may only open allowed hosts, so a base URL elsewhere could never be crawled. */
function assertBaseUrlAllowed(config: LookoverConfig): void {
  const host = normaliseHost(new URL(config.baseUrl).hostname);
  if (isAllowedHost(host, config.allowHosts)) {
    return;
  }
  throw new LookoverError(
    'E_NAVIGATION_BLOCKED',
    `baseUrl ${config.baseUrl} is not on an allowed host, so the browser may not open it`,
    `Run again with --allow-host ${host}, or add it to allowHosts in ${CONFIG_FILENAME}`,
  );
}

/**
 * Takes the session's events: writes each to the run log and notes the hosts blocked as unconfirmed
 * backends. The events come from browser callbacks, which cannot wait for a write, so each write is
 * queued; the log writes in call order, so the last write settles after every earlier one.
 */
class SessionRecorder {
  private written: Promise<void> = Promise.resolve();
  private writeFailures: readonly unknown[] = [];
  private blockedHosts: ReadonlySet<string> = new Set();

  constructor(private readonly log: RunLog) {}

  readonly record = (event: SessionEvent): void => {
    this.noteBlockedBackend(event);
    this.written = this.log.append(event).then(
      () => undefined,
      (error: unknown) => {
        this.writeFailures = [...this.writeFailures, error];
      },
    );
  };

  blockedUnconfirmedHosts(): string[] {
    return [...this.blockedHosts].toSorted();
  }

  /** Waits for every queued write and returns the ones that failed. */
  async failedWrites(): Promise<readonly unknown[]> {
    await this.written;
    return this.writeFailures;
  }

  /** Waits for every queued write; throws `E_RUN_FAILED` if one failed. */
  async assertComplete(): Promise<void> {
    const failed = await this.failedWrites();
    if (failed.length > 0) {
      throw new RunLogWriteError(failed);
    }
  }

  private noteBlockedBackend(event: SessionEvent): void {
    if (event.type !== 'request.blocked' || event.reason !== 'unconfirmed-backend') {
      return;
    }
    const url = URL.parse(event.url);
    const host = url === null ? null : networkHost(url);
    if (host !== null) {
      this.blockedHosts = new Set([...this.blockedHosts, host]);
    }
  }
}

/** The run log lost an event although the run itself succeeded, so the run has no complete record. */
class RunLogWriteError extends LookoverError {
  constructor(failedWrites: readonly unknown[]) {
    super('E_RUN_FAILED', `Run log write failed: ${firstLine(failedWrites[0])}`, RUN_LOG_HINT);
  }
}

/**
 * Logs `run.failed` and returns the error to throw: the run's own error, with the blocked unconfirmed
 * backends added to the hint of an auth failure and the run log's failed writes (this one included,
 * if it fails) added to the message. Either addition builds a new error; the original is not changed.
 */
async function recordFailure(log: RunLog, recorder: SessionRecorder, error: unknown): Promise<unknown> {
  const runError = withBlockedBackends(error, recorder.blockedUnconfirmedHosts());
  const failedWrites = await recorder.failedWrites();
  const failure = withFailedWrites(runError, failedWrites);
  try {
    await log.append({ type: 'run.failed', error: { code: codeOf(failure), message: messageOf(failure) } });
    return failure;
  } catch (appendError) {
    return withFailedWrites(runError, [...failedWrites, appendError]);
  }
}

/** A login may have failed because a backend it needed was blocked: the hint names those backends. */
function withBlockedBackends(error: unknown, hosts: readonly string[]): unknown {
  if (hosts.length === 0 || !(error instanceof LookoverError) || error.code !== 'E_AUTH_FAILED') {
    return error;
  }
  const note =
    `Blocked unconfirmed backends: ${hosts.join(', ')}. If they are development or disposable instances, ` +
    `re-run with: ${confirmHostCommand(hosts)} ${EDIT_CONFIG_ALTERNATIVE}`;
  return new LookoverError(
    error.code,
    error.message,
    error.hint === undefined ? note : `${error.hint}\n${note}`,
  );
}

/** The run's error with the failed log writes added to its message; a run log error already says so. */
function withFailedWrites(error: unknown, failedWrites: readonly unknown[]): unknown {
  if (failedWrites.length === 0 || error instanceof RunLogWriteError) {
    return error;
  }
  const count = failedWrites.length;
  const writes = count === 1 ? 'write' : 'writes';
  return new LookoverError(
    codeOf(error),
    `${messageOf(error)}; additionally, ${count} run-log ${writes} failed: ${firstLine(failedWrites[0])}`,
    hintOf(error),
  );
}

function codeOf(error: unknown): ErrorCode {
  return error instanceof LookoverError ? error.code : 'E_RUN_FAILED';
}

function hintOf(error: unknown): string | undefined {
  return error instanceof LookoverError ? error.hint : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Playwright appends a multi-line call log to its messages. */
function firstLine(error: unknown): string {
  return messageOf(error).split('\n', 1)[0]?.trim() ?? '';
}
