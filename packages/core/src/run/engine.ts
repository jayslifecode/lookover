import { join, resolve } from 'node:path';
import { type EnsureAuthOptions, ensureAuth, isLoginUrl } from '../browser/auth.js';
import { isAllowedHost, normaliseHost } from '../browser/network-policy.js';
import type { BrowserSession } from '../browser/session.js';
import { assertAcknowledged, CONFIG_FILENAME } from '../config/load.js';
import type { LookoverConfig } from '../config/schema.js';
import { LookoverError } from '../errors.js';
import type { Lens } from '../findings/lens.js';
import { writeFindings } from '../findings/persist.js';
import type { FindingsFile } from '../findings/types.js';
import { type CrawlOptions, crawl } from '../map/crawler.js';
import { discoverNextRoutes, staticRoutePatterns } from '../map/next-routes.js';
import { writeAppMap } from '../map/persist.js';
import type { AppMap, RouteInfo, Screen, Viewport } from '../map/types.js';
import type { Observer } from '../observers/types.js';
import { type ConfirmHosts, confirmBackends } from './backend-probe.js';
import type { RunEvent } from './events.js';
import { Inspection } from './inspection.js';
import type { RunContext } from './run-context.js';
import { launchSession, usingSession } from './session-launch.js';
import { recordFailure, SessionRecorder } from './session-recorder.js';

export interface ReviewHooks {
  /**
   * Asked once, after the probe, with every backend host the app called during the probe that is
   * neither allowed nor already confirmed in the config (sorted). Returns the ones the user confirms
   * are development or disposable instances; the run refuses to go on while any host is left out.
   * By then `onEvent` has had every `host.observed` event of the probe (each host's kinds).
   */
  confirmHosts?: ConfirmHosts;
  /** Every event of the run as the log writes it, from `run.started` to `run.finished` or `run.failed`. */
  onEvent?: (event: RunEvent) => void;
}

export interface ReviewOptions {
  /** The project directory: `config.root` and a storage state path are resolved against it. */
  cwd: string;
  headless?: boolean;
  /** Where a form login reads its credentials. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  hooks?: ReviewHooks;
  /** Run on every captured screen, in order, after the observers (see `Inspection`). Default none. */
  lenses?: readonly Lens[];
  /** Watch the crawl page and report on every captured screen (see `Inspection`). Default none. */
  observers?: readonly Observer[];
}

export interface ReviewResult {
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
  /** What the observers and lenses found, as written to `findings.json`. */
  findings: FindingsFile;
}

type Auth = LookoverConfig['auth'];

/** What the crawl needs besides the config, worked out before the browser starts. */
interface CrawlPlan {
  routes: RouteInfo[];
  viewport: Viewport;
  inspection: Inspection;
}

const STATE_DIR = 'state';
const ROOT_SEED = '/';

/**
 * Stage 1 (the App Map) and Stage 3 (the inspection of each screen) end to end, recorded in the run log
 * from `run.started` to `run.finished`:
 *
 * 0. The checks that need no browser: the disposable-data acknowledgement of a `full` config
 *    (`E_ACK_REQUIRED`, the same gate as `loadConfig`), a viewport, and a base URL on an allowed host.
 * 1. The routes on disk (Next.js only), each logged as `route.discovered`.
 * 2. One browser session inside the network envelope, at the first viewport; its events go to the
 *    run log.
 * 3. The probe, before logging in (see `confirmBackends`): the run refuses (`E_HOSTS_UNCONFIRMED`) to go
 *    on while a backend the app called is not confirmed as a development or disposable instance.
 *    From then on the session blocks every other backend (`unconfirmed-backend`), login included.
 * 4. The login as `config.auth` says (`auth.completed`).
 * 5. The bounded crawl from `/` and every static route. A form login logs in again once if the session
 *    is lost; a storage state with a `loginUrl` cannot, so losing it fails the run (`E_AUTH_FAILED`).
 *    5b. Each captured screen is inspected as soon as it is captured, on the page still showing it: the
 *    observers, then the lenses (see `Inspection`). Each new candidate is logged as `finding.candidate`,
 *    each inspected screen as `screen.inspected`; an observer or lens error that is not a
 *    `LookoverError` fails only that screen's inspection.
 * 6. The App Map, then the findings (`findings.json`), each written to the run directory and as the
 *    project's latest.
 *
 * Any failure is logged as `run.failed` (code `E_RUN_FAILED` for errors that are not a `LookoverError`)
 * and rethrown; see `recordFailure` for what is added to it. A run that otherwise succeeded but whose
 * log lost an event fails with `E_RUN_FAILED` ("Run log write failed"), since it has no complete
 * record. The session is always closed.
 */
export async function runReview(ctx: RunContext, opts: ReviewOptions): Promise<ReviewResult> {
  const startedAt = performance.now();
  const recorder = new SessionRecorder(ctx.log);
  const onEvent = opts.hooks?.onEvent;
  const unsubscribe = onEvent === undefined ? () => undefined : ctx.log.subscribe(onEvent);
  try {
    const result = await review(ctx, opts, recorder);
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

async function review(
  ctx: RunContext,
  opts: ReviewOptions,
  recorder: SessionRecorder,
): Promise<ReviewResult> {
  const { config } = ctx;
  await ctx.log.append({
    type: 'run.started',
    baseUrl: config.baseUrl,
    interaction: config.interaction,
    viewports: config.viewports,
  });
  assertAcknowledged(config);
  const viewport = firstViewport(config);
  assertBaseUrlAllowed(config);
  const routes = await discoverRoutes(ctx, opts.cwd);
  const inspection = new Inspection(ctx, {
    lenses: opts.lenses ?? [],
    observers: opts.observers ?? [],
    viewports: config.viewports,
    interaction: config.interaction,
  });
  const plan: CrawlPlan = { routes, viewport, inspection };
  const { screens, confirmedBackendHosts } = await explore(ctx, opts, recorder, plan);
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
  const findings = inspection.file();
  await writeFindings(ctx, findings);
  return {
    map,
    confirmedBackendHosts,
    blockedUnconfirmedHosts: recorder.blockedUnconfirmedHosts(),
    findings,
  };
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
  opts: ReviewOptions,
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
      afterRecorded(recorder, opts.hooks?.confirmHosts),
    );
    session.enforceConfirmedHosts(confirmedBackendHosts);
    const logIn = loginStep(ctx, session, auth, opts.env);
    await logIn();
    const screens = await crawl(session, ctx, crawlOptions(config, plan, auth, logIn));
    return { screens, confirmedBackendHosts };
  });
}

/** `confirmHosts`, asked only once the run log (and so `onEvent`) has every event recorded before it. */
function afterRecorded(
  recorder: SessionRecorder,
  confirmHosts: ConfirmHosts | undefined,
): ConfirmHosts | undefined {
  if (confirmHosts === undefined) {
    return undefined;
  }
  return async (hosts) => {
    await recorder.settled();
    return confirmHosts(hosts);
  };
}

/** A storage state path is relative to the project directory, not to wherever the process runs. */
function resolveAuth(auth: Auth, cwd: string): Auth {
  return auth.type === 'storageState' ? { ...auth, path: resolve(cwd, auth.path) } : auth;
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
    onPage: (ipage) => plan.inspection.attach(ipage),
    inspect: (screen, ipage) => plan.inspection.inspect(screen, ipage),
    ...lostSessionHook(auth, config.baseUrl, logIn),
  };
}

/**
 * How the crawl spots and handles a lost session: a form login logs in again; a storage state cannot,
 * so with a `loginUrl` to recognise the login page by, losing it fails the run. Without a login page to
 * recognise (no auth, or a storage state without `loginUrl`) there is no hook.
 */
function lostSessionHook(
  auth: Auth,
  baseUrl: string,
  logIn: () => Promise<void>,
): Pick<CrawlOptions, 'auth'> {
  if (auth.type === 'none' || (auth.type === 'storageState' && auth.loginUrl === undefined)) {
    return {};
  }
  return {
    auth: {
      isLoginUrl: (url: URL) => isLoginUrl(url, auth, baseUrl),
      recover: auth.type === 'form' ? logIn : savedSessionExpired,
    },
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
