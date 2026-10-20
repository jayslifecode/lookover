import { join, resolve } from 'node:path';
import { checkStorageState, type EnsureAuthOptions, ensureAuth, isLoginUrl } from '../browser/auth.js';
import { isAllowedHost, normaliseHost } from '../browser/network-policy.js';
import { BrowserSession, type SessionEvent, type SessionOptions } from '../browser/session.js';
import { CONFIG_FILENAME } from '../config/load.js';
import type { LookoverConfig } from '../config/schema.js';
import { type ErrorCode, LookoverError } from '../errors.js';
import { type CrawlOptions, crawl, DESTRUCTIVE_LINK_PATTERN, resolveSeed } from '../map/crawler.js';
import { discoverNextRoutes } from '../map/next-routes.js';
import { writeAppMap } from '../map/persist.js';
import type { AppMap, RouteInfo, Screen, Viewport } from '../map/types.js';
import type { RunEvent } from './events.js';
import type { RunContext } from './run-context.js';
import type { RunLog } from './run-log.js';

export interface DiscoveryHooks {
  /**
   * Asked once, after the probe, with every backend host the app called that is neither allowed nor
   * already confirmed in the config (sorted). Returns the ones the user confirms are development or
   * disposable instances; the run refuses to go on while any host is left out.
   */
  confirmHosts?: (hosts: string[]) => Promise<string[]>;
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
}

type Auth = LookoverConfig['auth'];

/** What the crawl needs besides the config, worked out before the browser starts. */
interface CrawlPlan {
  routes: RouteInfo[];
  viewport: Viewport;
}

const STATE_DIR = 'state';
const ROOT_SEED = '/';
const DYNAMIC_SEGMENT_MARK = '[';
const PROBE_NAVIGATION_TIMEOUT_MS = 15_000;
const PROBE_SETTLE_MS = 800;
const HOST_LIST_INDENT = '  ';
const UNCONFIRMED_HINT =
  'Run again with --confirm-host <host> for each development or disposable backend, or add it to confirmedBackendHosts';
/** How Playwright names a storage state it cannot read or will not accept. */
const STORAGE_STATE_ERROR = /storage ?state/i;

/**
 * Stage 1 end to end, recorded in the run log from `run.started` to `run.finished`:
 *
 * 1. The routes on disk (Next.js only), each logged as `route.discovered`.
 * 2. One browser session inside the network envelope, at the first viewport; it is logged in as
 *    `config.auth` says (`auth.completed`), and its own events go to the run log.
 * 3. The probe (see `confirmBackends`): the run refuses (`E_HOSTS_UNCONFIRMED`) to go on while a backend
 *    the app called is not confirmed as a development or disposable instance.
 * 4. The bounded crawl from `/` and every static route, logging in again once if the session is lost.
 * 5. The App Map, written to the run directory and as the project's latest.
 *
 * Any failure is logged as `run.failed` (code `E_RUN_FAILED` for errors that are not a `LookoverError`)
 * and rethrown, unless the run log itself failed to record an event: then the run fails with
 * `E_RUN_FAILED` ("Run log write failed"), since it has no complete record. The session is always closed.
 */
export async function runDiscovery(ctx: RunContext, opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const startedAt = performance.now();
  const sessionLog = new SessionEventLog(ctx.log);
  const onEvent = opts.hooks?.onEvent;
  const unsubscribe = onEvent === undefined ? () => undefined : ctx.log.subscribe(onEvent);
  try {
    const result = await discover(ctx, opts, sessionLog);
    await ctx.log.append({
      type: 'run.finished',
      screens: result.map.screens.length,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return result;
  } catch (error) {
    throw await recordFailure(ctx.log, sessionLog, error);
  } finally {
    unsubscribe();
  }
}

async function discover(
  ctx: RunContext,
  opts: DiscoveryOptions,
  sessionLog: SessionEventLog,
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
  const { screens, confirmedBackendHosts } = await explore(ctx, opts, sessionLog, { routes, viewport });
  await sessionLog.assertComplete();
  const map: AppMap = {
    version: 1,
    runId: ctx.runId,
    createdAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    routes,
    screens,
  };
  await writeAppMap(ctx, map);
  return { map, confirmedBackendHosts };
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

/** Steps 2 to 4, in one session that is closed whatever happens. */
async function explore(
  ctx: RunContext,
  opts: DiscoveryOptions,
  sessionLog: SessionEventLog,
  plan: CrawlPlan,
): Promise<{ screens: Screen[]; confirmedBackendHosts: string[] }> {
  const { config } = ctx;
  const auth = resolveAuth(config.auth, opts.cwd);
  const session = await launchSession({
    viewport: plan.viewport,
    allowHosts: config.allowHosts,
    onEvent: sessionLog.append,
    ...(opts.headless === undefined ? {} : { headless: opts.headless }),
    ...(auth.type === 'storageState' ? { storageStatePath: auth.path } : {}),
  });
  return usingSession(session, async () => {
    const logIn = loginStep(ctx, session, auth, opts.env);
    await logIn();
    const confirmedBackendHosts = await confirmBackends(session, config, plan.routes, opts.hooks);
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

/** Logs the session in as `auth` says and records how; the crawl runs it again when the session is lost. */
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

/**
 * The probe: opens the base URL and one more page (see `probeUrls`) so the app makes its usual backend
 * calls, then asks `hooks.confirmHosts` about every host it called that is neither allowed nor already
 * confirmed. Throws `E_HOSTS_UNCONFIRMED` naming the hosts left unconfirmed, or all of them without a
 * hook. Returns the config's confirmed hosts plus the ones confirmed now.
 */
async function confirmBackends(
  session: BrowserSession,
  config: LookoverConfig,
  routes: readonly RouteInfo[],
  hooks: DiscoveryHooks | undefined,
): Promise<string[]> {
  await probe(session, probeUrls(config, routes));
  const known = new Set(config.confirmedBackendHosts.map(normaliseHost));
  const pending = session
    .observedHosts()
    .filter((host) => !isAllowedHost(host, config.allowHosts) && !known.has(host));
  const confirmed = pending.length === 0 ? [] : await askToConfirm(pending, hooks);
  return uniqueHosts([...config.confirmedBackendHosts, ...confirmed]);
}

/** Returns `pending` once every host in it is confirmed; any other answer confirms nothing. */
async function askToConfirm(
  pending: readonly string[],
  hooks: DiscoveryHooks | undefined,
): Promise<string[]> {
  if (hooks?.confirmHosts === undefined) {
    throw unconfirmedHosts(pending);
  }
  const answers = new Set((await hooks.confirmHosts([...pending])).map(normaliseHost));
  const unconfirmed = pending.filter((host) => !answers.has(host));
  if (unconfirmed.length > 0) {
    throw unconfirmedHosts(unconfirmed);
  }
  return [...pending];
}

/**
 * The base URL, then the first static filesystem route that is another page: not the base URL itself,
 * not the login page, and not a destructive link (the crawl never opens one either).
 */
function probeUrls(config: LookoverConfig, routes: readonly RouteInfo[]): string[] {
  const base = new URL(config.baseUrl);
  const root = resolveSeed(ROOT_SEED, base)?.href;
  const second = staticPatterns(routes)
    .filter((pattern) => !DESTRUCTIVE_LINK_PATTERN.test(pattern))
    .flatMap((pattern) => resolveSeed(pattern, base) ?? [])
    .find((url) => url.href !== root && !isLoginUrl(url, config.auth, config.baseUrl));
  return second === undefined ? [config.baseUrl] : [config.baseUrl, second.href];
}

/**
 * Opens each URL in one short-lived page. Best effort: a navigation that fails is not retried, because
 * whatever the page requested is observed whether or not it finished loading.
 */
async function probe(session: BrowserSession, urls: readonly string[]): Promise<void> {
  const { page, close } = await session.newPage();
  try {
    for (const url of urls) {
      await page
        .goto(url, { waitUntil: 'load', timeout: PROBE_NAVIGATION_TIMEOUT_MS })
        .catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: PROBE_SETTLE_MS }).catch(() => undefined);
    }
  } finally {
    await close();
  }
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
    seeds: [...new Set([ROOT_SEED, ...staticPatterns(plan.routes)])],
    routes: plan.routes,
    maxScreens: config.maxScreens,
    maxPerRoute: config.maxPerRoute,
    viewport: plan.viewport,
    ...(auth.type === 'none'
      ? {}
      : { auth: { isLoginUrl: (url: URL) => isLoginUrl(url, auth, config.baseUrl), recover: logIn } }),
  };
}

function staticPatterns(routes: readonly RouteInfo[]): string[] {
  return routes.map((route) => route.pattern).filter((pattern) => !pattern.includes(DYNAMIC_SEGMENT_MARK));
}

/** Deduplicated as the network policy compares hosts; the first spelling of each is kept. */
function uniqueHosts(hosts: readonly string[]): string[] {
  const keys = hosts.map(normaliseHost);
  return hosts.filter((_host, index) => keys.indexOf(keys[index] ?? '') === index);
}

function unconfirmedHosts(hosts: readonly string[]): LookoverError {
  const lines = [
    'The app called these backends, and none of them is confirmed as a development or disposable instance:',
    ...hosts.map((host) => `${HOST_LIST_INDENT}${host}`),
  ];
  return new LookoverError('E_HOSTS_UNCONFIRMED', lines.join('\n'), UNCONFIRMED_HINT);
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
 * Writes the session's events to the run log. They come from browser callbacks, which cannot wait for a
 * write, so each is queued; the log writes in call order, so the last write settles after every earlier
 * one. A failed write is kept: a run whose log lost an event has no complete record, so it fails.
 */
class SessionEventLog {
  private written: Promise<void> = Promise.resolve();
  private lost: LookoverError | null = null;

  constructor(private readonly log: RunLog) {}

  readonly append = (event: SessionEvent): void => {
    this.written = this.log.append(event).then(
      () => undefined,
      (error: unknown) => {
        this.lost ??= runLogError(error);
      },
    );
  };

  /** Waits for every queued write and throws `E_RUN_FAILED` if one failed. */
  async assertComplete(): Promise<void> {
    await this.written;
    if (this.lost !== null) {
      throw this.lost;
    }
  }

  /** Waits for every queued write; the run fails with the log's failure if it lost an event, else `error`. */
  async failureOf(error: unknown): Promise<unknown> {
    await this.written;
    return this.lost ?? error;
  }
}

/** Logs `run.failed` and returns the error to throw (see `runDiscovery`). */
async function recordFailure(log: RunLog, sessionLog: SessionEventLog, error: unknown): Promise<unknown> {
  const failure = await sessionLog.failureOf(error);
  try {
    await log.append({ type: 'run.failed', error: { code: codeOf(failure), message: messageOf(failure) } });
  } catch (appendError) {
    return runLogError(appendError);
  }
  return failure;
}

function runLogError(error: unknown): LookoverError {
  return new LookoverError(
    'E_RUN_FAILED',
    `Run log write failed: ${firstLine(error)}`,
    'Check that the .lookover directory is writable and its disk has room',
  );
}

function codeOf(error: unknown): ErrorCode {
  return error instanceof LookoverError ? error.code : 'E_RUN_FAILED';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Playwright appends a multi-line call log to its messages. */
function firstLine(error: unknown): string {
  return messageOf(error).split('\n', 1)[0]?.trim() ?? '';
}
