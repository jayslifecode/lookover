import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from 'vitest';
import { ensureAuth } from '../src/browser/auth.js';
import { BrowserSession } from '../src/browser/session.js';
import { configSchema, type LookoverConfig } from '../src/config/schema.js';
import { LookoverError } from '../src/errors.js';
import { crawl } from '../src/map/crawler.js';
import { APP_MAP_FILE } from '../src/map/persist.js';
import type { AppMap } from '../src/map/types.js';
import { type DiscoveryHooks, runDiscovery } from '../src/run/engine.js';
import type { RunEvent, RunEventBody } from '../src/run/events.js';
import { createRun, type RunContext } from '../src/run/run-context.js';
import { RunLog } from '../src/run/run-log.js';
import {
  DEMO_CREDENTIALS,
  type FixtureRoute,
  type FixtureServer,
  HOME_PATH,
  hasSessionCookie,
  LOGIN_PATH,
  redirect,
  requireSession,
  SESSION_COOKIE,
  serveFixture,
  submitLogin,
} from './fixtures/serve.js';

// The real login and crawl, wrapped so a test can shorten the login timeout or see the crawl's options.
vi.mock('../src/browser/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/browser/auth.js')>();
  return { ...original, ensureAuth: vi.fn(original.ensureAuth) };
});
vi.mock('../src/map/crawler.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/map/crawler.js')>();
  return { ...original, crawl: vi.fn(original.crawl) };
});

const LOGIN_DIR = fileURLToPath(new URL('./fixtures/login', import.meta.url));
const BROWSER_TIMEOUT_MS = 60_000;
/** Long enough for a login that works, short enough that a login that cannot work fails quickly. */
const SHORT_LOGIN_TIMEOUT_MS = 2_000;
const DEMO_ENV = { LOOKOVER_USERNAME: DEMO_CREDENTIALS.user, LOOKOVER_PASSWORD: DEMO_CREDENTIALS.pass };
/** Called by the public dashboard (`/`), the page the probe always opens. */
const SUPABASE_HOST = 'xyz.supabase.co';
/** Called by the public `/projects` only, which nothing links to: only the probe or a seed reaches it. */
const PROJECTS_API_HOST = 'api.backend.test';
/** Called by `/settings.html` only, which only the crawl reaches; resolved to the fixture server. */
const LATE_HOST = 'late.backend.test';
/** The auth backend `/login-api.html` signs in through; resolved to the fixture server. */
const AUTH_API_HOST = 'auth.backend.test';
const API_LOGIN_PATH = '/login-api.html';
/** Called by `/login-backend.html` on load: only a probe of the login page itself sees it. */
const LOGIN_PAGE_HOST = 'config.backend.test';
const BACKEND_LOGIN_PATH = '/login-backend.html';
/** The Next.js routes of the project with a root: a login, a destructive and a dynamic route among them. */
const NEXT_ROUTE_DIRS = ['', 'login', 'logout', 'projects', 'projects/[id]'];
const NEXT_PATTERNS = ['/', '/login', '/logout', '/projects', '/projects/[id]'];
const CLEARED_SESSION_COOKIE = `${SESSION_COOKIE.name}=; Path=/; Max-Age=0`;
const OR_EDIT_CONFIG = '(or add them to confirmedBackendHosts in lookover.config.json)';
/** Longer than the probe takes to finish once its last host is observed. */
const SLOW_LOG_WRITE_MS = 1_500;

/** The `E_HOSTS_UNCONFIRMED` hint for `hosts`: one command, the flag repeated per host. */
function confirmHint(...hosts: string[]): string {
  const flags = hosts.map((host) => `--confirm-host ${host}`).join(' ');
  return `Run: lookover run ${flags} — only for development or disposable backends ${OR_EDIT_CONFIG}`;
}

type Auth = LookoverConfig['auth'];

/** The form login of the login fixture; the login page itself is `/login.html` unless overridden. */
function formAuth(overrides: Record<string, unknown> = {}): Auth {
  return configSchema.parse({
    baseUrl: 'http://localhost:3000',
    interaction: 'safe',
    auth: {
      type: 'form',
      loginUrl: LOGIN_PATH,
      usernameSelector: 'input[name="user"]',
      passwordSelector: 'input[name="pass"]',
      submitSelector: 'button[type="submit"]',
      successUrl: HOME_PATH,
      ...overrides,
    },
  }).auth;
}

function eventsOf<T extends RunEvent['type']>(
  events: readonly RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

async function failureOf(promise: Promise<unknown>): Promise<LookoverError> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof LookoverError)) {
    throw new Error(`expected a LookoverError, got ${String(outcome)}`);
  }
  return outcome;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** A `confirmHosts` hook confirming what `confirm` picks (every host by default); records each question. */
function confirmingHook(confirm: (hosts: string[]) => string[] = (hosts) => hosts): {
  hooks: DiscoveryHooks;
  asked: string[][];
} {
  const asked: string[][] = [];
  return {
    asked,
    hooks: {
      confirmHosts: async (hosts) => {
        asked.push(hosts);
        return confirm(hosts);
      },
    },
  };
}

describe('runDiscovery', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let workDir: string;
  let launchSpy: MockInstance<typeof BrowserSession.launch>;
  /** Fixture flag: the next protected page ends the session server-side (clears the cookie, redirects). */
  let shouldEndSession = false;
  let logoutRequests = 0;
  /** Requests that reached the late backend and the auth backend, which the session should block. */
  let lateCalls = 0;
  let apiLoginCalls = 0;

  const url = (path: string): string => `${fixture.url}${path}`;
  const backendUrl = (host: string, path: string): string =>
    `http://${host}:${new URL(fixture.url).port}${path}`;

  const protectedPage: FixtureRoute = (req, res, serveStatic) => {
    if (shouldEndSession && hasSessionCookie(req)) {
      shouldEndSession = false;
      redirect(res, LOGIN_PATH, { 'set-cookie': CLEARED_SESSION_COOKIE });
      return;
    }
    requireSession(req, res, serveStatic);
  };

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lookover-engine-'));
    // `/` and `/projects` are public, so the probe (before login) sees their backends.
    fixture = await serveFixture(LOGIN_DIR, {
      '/home.html': protectedPage,
      '/settings.html': protectedPage,
      '/projects': (_req, _res, serveStatic) => serveStatic('/projects.html'),
      '/login': submitLogin,
      '/logout': (_req, res) => {
        logoutRequests += 1;
        redirect(res, LOGIN_PATH, { 'set-cookie': CLEARED_SESSION_COOKIE });
      },
      '/late-call': (_req, res) => {
        lateCalls += 1;
        res.writeHead(204);
        res.end();
      },
      '/api-login': (_req, res) => {
        apiLoginCalls += 1;
        res.writeHead(204);
        res.end();
      },
    });
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await fixture.close();
    await rm(workDir, { recursive: true, force: true });
  }, BROWSER_TIMEOUT_MS);

  beforeEach(() => {
    // The backends must not be reached from a test: the resolver makes two unresolvable, which leaves
    // their calls observed (the request is made) but never sent, and points two at the fixture server,
    // which counts what gets through. Only the test sets `testResolver`.
    const launch = BrowserSession.launch.bind(BrowserSession);
    launchSpy = vi.spyOn(BrowserSession, 'launch').mockImplementation((options) =>
      launch({
        ...options,
        testResolver: {
          blockedHosts: [SUPABASE_HOST, PROJECTS_API_HOST, LOGIN_PAGE_HOST],
          loopbackHosts: [LATE_HOST, AUTH_API_HOST],
        },
      }),
    );
    lateCalls = 0;
    apiLoginCalls = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    shouldEndSession = false;
  });

  /** A project directory with a run started in it; `nextRouteDirs` become `app/<dir>/page.tsx` files. */
  async function newProject(
    overrides: Record<string, unknown> = {},
    nextRouteDirs: readonly string[] = [],
  ): Promise<{ cwd: string; ctx: RunContext }> {
    const cwd = await mkdtemp(join(workDir, 'project-'));
    for (const dir of nextRouteDirs) {
      await mkdir(join(cwd, 'app', dir), { recursive: true });
      await writeFile(join(cwd, 'app', dir, 'page.tsx'), 'export default function Page() { return null; }\n');
    }
    const config = configSchema.parse({
      baseUrl: fixture.url,
      interaction: 'safe',
      auth: formAuth(),
      maxScreens: 10,
      ...overrides,
    });
    return { cwd, ctx: await createRun({ cwd, config }) };
  }

  async function logOf(ctx: RunContext): Promise<RunEvent[]> {
    return RunLog.read(ctx.log.file);
  }

  function launchOptions(): Parameters<typeof BrowserSession.launch>[0] {
    expect(launchSpy).toHaveBeenCalledTimes(1);
    const [options] = launchSpy.mock.calls[0] ?? [];
    if (options === undefined) {
      throw new Error('expected the session to be launched');
    }
    return options;
  }

  describe('on an app without a Next.js root', () => {
    test('refuses to log in or crawl while a backend is unconfirmed and no hook can confirm it', async () => {
      const { cwd, ctx } = await newProject();

      const error = await failureOf(runDiscovery(ctx, { cwd, env: DEMO_ENV }));

      expect(error.code).toBe('E_HOSTS_UNCONFIRMED');
      expect(error.message.split('\n')).toContain(`  ${SUPABASE_HOST}`);
      expect(error.hint).toBe(confirmHint(SUPABASE_HOST));
      const events = await logOf(ctx);
      expect(events.at(-1)).toMatchObject({
        type: 'run.failed',
        error: { code: 'E_HOSTS_UNCONFIRMED', message: error.message },
      });
      expect(eventsOf(events, 'auth.completed')).toEqual([]);
      expect(eventsOf(events, 'screen.discovered')).toEqual([]);
      expect(await exists(join(ctx.dir, APP_MAP_FILE))).toBe(false);
    });

    test('confirms the backends before logging in, then crawls and persists the map', async () => {
      const { cwd, ctx } = await newProject();
      const asked: string[][] = [];
      let loginsBeforeQuestion: number | undefined;
      const hooks: DiscoveryHooks = {
        confirmHosts: async (hosts) => {
          asked.push(hosts);
          loginsBeforeQuestion = eventsOf(await logOf(ctx), 'auth.completed').length;
          return hosts;
        },
      };

      const result = await runDiscovery(ctx, { cwd, env: DEMO_ENV, hooks });

      expect(asked).toEqual([[SUPABASE_HOST]]);
      expect(loginsBeforeQuestion).toBe(0);
      expect(result.confirmedBackendHosts).toEqual([SUPABASE_HOST]);
      expect(result.map).toMatchObject({ version: 1, runId: ctx.runId, baseUrl: fixture.url, routes: [] });
      expect(result.map.screens.map((screen) => [screen.url, screen.title])).toEqual([
        [url('/'), 'Dashboard'],
        [url('/home.html'), 'Home'],
        [url('/settings.html'), 'Settings'],
      ]);
      for (const path of [join(ctx.dir, APP_MAP_FILE), join(ctx.lookoverDir, APP_MAP_FILE)]) {
        const saved = JSON.parse(await readFile(path, 'utf8')) as AppMap;
        expect(saved.screens.length).toBeGreaterThanOrEqual(3);
        expect(saved.runId).toBe(ctx.runId);
      }

      const events = await logOf(ctx);
      expect(events[0]).toMatchObject({
        type: 'run.started',
        baseUrl: fixture.url,
        interaction: 'safe',
        viewports: ctx.config.viewports,
      });
      expect(eventsOf(events, 'auth.completed')).toEqual([
        expect.objectContaining({ method: 'form', statePath: join(ctx.lookoverDir, 'state', 'form.json') }),
      ]);
      expect(eventsOf(events, 'route.discovered')).toEqual([]);
      expect(eventsOf(events, 'host.observed')).toContainEqual(
        expect.objectContaining({ host: SUPABASE_HOST, kind: 'app-call' }),
      );
      expect(events.at(-1)).toMatchObject({
        type: 'run.finished',
        screens: result.map.screens.length,
        durationMs: expect.any(Number),
      });
      const firstScreen = eventsOf(events, 'screen.discovered')[0];
      expect(eventsOf(events, 'auth.completed')[0]?.seq).toBeLessThan(firstScreen?.seq ?? 0);
    });

    test('asks about the hosts only once onEvent has had every host the probe observed', async () => {
      const { cwd, ctx } = await newProject({ maxScreens: 1 });
      // Host events reach the log late, as on a slow disk: the question must still wait for them.
      const append = ctx.log.append.bind(ctx.log);
      vi.spyOn(ctx.log, 'append').mockImplementation((body: RunEventBody) =>
        body.type === 'host.observed' ? delay(SLOW_LOG_WRITE_MS).then(() => append(body)) : append(body),
      );
      let seenHosts: ReadonlySet<string> = new Set();
      let unseenWhenAsked: string[] | undefined;
      const hooks: DiscoveryHooks = {
        onEvent: (event) => {
          if (event.type === 'host.observed') {
            seenHosts = new Set([...seenHosts, event.host]);
          }
        },
        confirmHosts: async (hosts) => {
          unseenWhenAsked = hosts.filter((host) => !seenHosts.has(host));
          return hosts;
        },
      };

      await runDiscovery(ctx, { cwd, env: DEMO_ENV, hooks });

      expect(unseenWhenAsked).toEqual([]);
    });

    test('blocks a backend first called during the crawl and reports it, finishing the run', async () => {
      const { cwd, ctx } = await newProject();

      const result = await runDiscovery(ctx, { cwd, env: DEMO_ENV, hooks: confirmingHook().hooks });

      const lateCall = backendUrl(LATE_HOST, '/late-call');
      expect(result.blockedUnconfirmedHosts).toEqual([LATE_HOST]);
      expect(result.confirmedBackendHosts).not.toContain(LATE_HOST);
      expect(lateCalls).toBe(0);
      const events = await logOf(ctx);
      expect(eventsOf(events, 'request.blocked')).toContainEqual(
        expect.objectContaining({ url: lateCall, reason: 'unconfirmed-backend' }),
      );
      expect(result.map.screens.map((screen) => screen.title)).toContain('Settings');
      expect(events.at(-1)?.type).toBe('run.finished');
    });

    test('blocks a login that posts to an unconfirmed backend and names it in the hint', async () => {
      const { cwd, ctx } = await newProject({ auth: formAuth({ loginUrl: API_LOGIN_PATH }) });
      const { ensureAuth: realEnsureAuth } =
        await vi.importActual<typeof import('../src/browser/auth.js')>('../src/browser/auth.js');
      vi.mocked(ensureAuth).mockImplementationOnce((session, auth, options) =>
        realEnsureAuth(session, auth, { ...options, timeoutMs: SHORT_LOGIN_TIMEOUT_MS }),
      );

      const error = await failureOf(runDiscovery(ctx, { cwd, env: DEMO_ENV, hooks: confirmingHook().hooks }));

      expect(error.code).toBe('E_AUTH_FAILED');
      expect(error.hint).toContain(
        `Blocked unconfirmed backends: ${AUTH_API_HOST}. If they are development or disposable instances, ` +
          `re-run with: lookover run --confirm-host ${AUTH_API_HOST} ${OR_EDIT_CONFIG}`,
      );
      expect(apiLoginCalls).toBe(0);
      const events = await logOf(ctx);
      expect(eventsOf(events, 'request.blocked')).toContainEqual(
        expect.objectContaining({
          url: backendUrl(AUTH_API_HOST, '/api-login'),
          reason: 'unconfirmed-backend',
        }),
      );
      expect(events.at(-1)).toMatchObject({ type: 'run.failed', error: { code: 'E_AUTH_FAILED' } });
    });

    test('probes the login page too, so the backends it loads are asked about before login', async () => {
      const { cwd, ctx } = await newProject({
        auth: formAuth({ loginUrl: BACKEND_LOGIN_PATH }),
        maxScreens: 1,
      });
      const { hooks, asked } = confirmingHook();

      const result = await runDiscovery(ctx, { cwd, env: DEMO_ENV, hooks });

      expect(asked).toEqual([[LOGIN_PAGE_HOST, SUPABASE_HOST]]);
      expect(result.confirmedBackendHosts).toEqual([LOGIN_PAGE_HOST, SUPABASE_HOST]);
      expect(result.blockedUnconfirmedHosts).toEqual([]);
      expect(eventsOf(await logOf(ctx), 'auth.completed')).toEqual([
        expect.objectContaining({ method: 'form' }),
      ]);
    });

    test('launches one session at the first viewport, inside the configured allowlist', async () => {
      const allowHosts = ['staging.example.test'];
      const { cwd, ctx } = await newProject({ allowHosts, maxScreens: 1 });

      await runDiscovery(ctx, { cwd, env: DEMO_ENV, hooks: confirmingHook().hooks });

      const options = launchOptions();
      expect(options.viewport).toEqual(ctx.config.viewports[0]);
      expect(options.allowHosts).toEqual(allowHosts);
      expect(options).not.toHaveProperty('testResolver');
      expect(options).not.toHaveProperty('storageStatePath');
    });

    test('logs in again once when the server ends the session after the second page', async () => {
      const { cwd, ctx } = await newProject();
      const seen: RunEvent[] = [];
      let captured = 0;
      const onEvent = (event: RunEvent): void => {
        seen.push(event);
        if (event.type === 'screen.captured') {
          captured += 1;
          shouldEndSession = captured === 2;
        }
      };

      const result = await runDiscovery(ctx, {
        cwd,
        env: DEMO_ENV,
        hooks: { ...confirmingHook().hooks, onEvent },
      });

      const events = await logOf(ctx);
      const authEvents = events.filter((event) => event.type.startsWith('auth.'));
      expect(authEvents.map((event) => event.type)).toEqual([
        'auth.completed',
        'auth.lost',
        'auth.completed',
      ]);
      expect(authEvents[1]).toMatchObject({ url: url('/settings.html') });
      expect(result.map.screens.map((screen) => screen.title)).toEqual(['Dashboard', 'Home', 'Settings']);
      expect(events.at(-1)?.type).toBe('run.finished');
      expect(seen.map((event) => event.seq)).toEqual(events.map((event) => event.seq));
    });

    test('rethrows what the hook throws, logged as E_RUN_FAILED', async () => {
      const { cwd, ctx } = await newProject();
      const thrown = new Error('the prompt was closed');

      const running = runDiscovery(ctx, {
        cwd,
        env: DEMO_ENV,
        hooks: { confirmHosts: () => Promise.reject(thrown) },
      });

      await expect(running).rejects.toBe(thrown);
      expect((await logOf(ctx)).at(-1)).toMatchObject({
        type: 'run.failed',
        error: { code: 'E_RUN_FAILED', message: 'the prompt was closed' },
      });
    });

    describe('when the run log loses an event', () => {
      function failHostEvents(ctx: RunContext): void {
        const append = ctx.log.append.bind(ctx.log);
        vi.spyOn(ctx.log, 'append').mockImplementation((body: RunEventBody) =>
          body.type === 'host.observed' ? Promise.reject(new Error('disk full')) : append(body),
        );
      }

      test('fails an otherwise good run with E_RUN_FAILED, writing no map', async () => {
        const { cwd, ctx } = await newProject();
        failHostEvents(ctx);

        const error = await failureOf(
          runDiscovery(ctx, { cwd, env: DEMO_ENV, hooks: confirmingHook().hooks }),
        );

        expect(error.code).toBe('E_RUN_FAILED');
        expect(error.message).toBe('Run log write failed: disk full');
        expect((await logOf(ctx)).at(-1)).toMatchObject({
          type: 'run.failed',
          error: { code: 'E_RUN_FAILED', message: error.message },
        });
        expect(await exists(join(ctx.dir, APP_MAP_FILE))).toBe(false);
      });

      test("keeps a failed run's own error, adding the lost writes to its message", async () => {
        const { cwd, ctx } = await newProject();
        failHostEvents(ctx);

        const error = await failureOf(runDiscovery(ctx, { cwd, env: DEMO_ENV }));

        expect(error.code).toBe('E_HOSTS_UNCONFIRMED');
        expect(error.message).toMatch(/^The app called these backends/);
        expect(error.message).toMatch(/; additionally, \d+ run-log writes? failed: disk full$/);
        expect(error.hint).toBe(confirmHint(SUPABASE_HOST));
        expect((await logOf(ctx)).at(-1)).toMatchObject({
          type: 'run.failed',
          error: { code: 'E_HOSTS_UNCONFIRMED', message: error.message },
        });
      });
    });
  });

  describe('on an app with a Next.js root', () => {
    test('logs its routes, probes the first static page but the login page, seeds the crawl', async () => {
      const { cwd, ctx } = await newProject(
        { auth: formAuth({ loginUrl: '/login' }), confirmedBackendHosts: [SUPABASE_HOST] },
        NEXT_ROUTE_DIRS,
      );
      const { hooks, asked } = confirmingHook();

      const result = await runDiscovery(ctx, { cwd, env: DEMO_ENV, hooks });

      const events = await logOf(ctx);
      expect(eventsOf(events, 'route.discovered').map((event) => event.route.pattern)).toEqual(NEXT_PATTERNS);
      expect(result.map.routes.map((route) => route.pattern)).toEqual(NEXT_PATTERNS);
      // `/` is the base URL and `/login` the login page, `/logout` is destructive: `/projects` is probed.
      expect(asked).toEqual([[PROJECTS_API_HOST]]);
      expect(result.confirmedBackendHosts).toEqual([SUPABASE_HOST, PROJECTS_API_HOST]);
      expect(logoutRequests).toBe(0);
      // Static routes are seeds, so `/projects` is captured though no page links to it.
      expect(result.map.screens.map((screen) => [screen.url, screen.route])).toEqual([
        [url('/'), '/'],
        [url('/login'), '/login'],
        [url('/projects'), '/projects'],
        [url('/home.html'), '/home.html'],
        [url('/settings.html'), '/settings.html'],
      ]);
    });

    test('names only the hosts the hook left unconfirmed, in the message and the hint', async () => {
      const { cwd, ctx } = await newProject({ auth: formAuth({ loginUrl: '/login' }) }, NEXT_ROUTE_DIRS);
      const { hooks, asked } = confirmingHook((hosts) => hosts.filter((host) => host === SUPABASE_HOST));

      const error = await failureOf(runDiscovery(ctx, { cwd, env: DEMO_ENV, hooks }));

      expect(asked).toEqual([[PROJECTS_API_HOST, SUPABASE_HOST]]);
      expect(error.code).toBe('E_HOSTS_UNCONFIRMED');
      expect(error.message.split('\n')).toContain(`  ${PROJECTS_API_HOST}`);
      expect(error.message).not.toContain(SUPABASE_HOST);
      expect(error.hint).toBe(confirmHint(PROJECTS_API_HOST));
    });

    test('hints at one command repeating --confirm-host for each unconfirmed host', async () => {
      const { cwd, ctx } = await newProject({ auth: formAuth({ loginUrl: '/login' }) }, NEXT_ROUTE_DIRS);

      const error = await failureOf(runDiscovery(ctx, { cwd, env: DEMO_ENV }));

      expect(error.code).toBe('E_HOSTS_UNCONFIRMED');
      expect(error.hint).toBe(confirmHint(PROJECTS_API_HOST, SUPABASE_HOST));
    });
  });

  describe('with a storage state', () => {
    const STATE_FILE = 'state.json';

    function storageAuth(overrides: { loginUrl?: string } = {}): Auth {
      return { type: 'storageState', path: STATE_FILE, ...overrides };
    }

    /** An `onEvent` hook that has the server end the session on the next protected page, once one screen is captured. */
    function endSessionAfterFirstScreen(): (event: RunEvent) => void {
      let captured = 0;
      return (event) => {
        if (event.type === 'screen.captured') {
          captured += 1;
          shouldEndSession = captured === 1;
        }
      };
    }

    async function writeSessionState(cwd: string): Promise<string> {
      const statePath = join(cwd, STATE_FILE);
      const cookie = {
        ...SESSION_COOKIE,
        domain: new URL(fixture.url).hostname,
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      };
      await writeFile(statePath, JSON.stringify({ cookies: [cookie], origins: [] }));
      return statePath;
    }

    test('launches the session with the file resolved against the project directory', async () => {
      const { cwd, ctx } = await newProject({ auth: storageAuth(), maxScreens: 2 });
      const statePath = await writeSessionState(cwd);
      expect(relative(process.cwd(), statePath)).not.toBe(STATE_FILE);

      const result = await runDiscovery(ctx, { cwd, hooks: confirmingHook().hooks });

      expect(launchOptions().storageStatePath).toBe(statePath);
      expect(eventsOf(await logOf(ctx), 'auth.completed')).toEqual([
        expect.objectContaining({ method: 'storageState', statePath }),
      ]);
      // `/home.html` needs the session cookie: without the state it would be the login page.
      expect(result.map.screens.map((screen) => screen.title)).toEqual(['Dashboard', 'Home']);
    });

    test('fails with E_AUTH_FAILED when the server ends the saved session, given its loginUrl', async () => {
      const { cwd, ctx } = await newProject({ auth: storageAuth({ loginUrl: LOGIN_PATH }) });
      await writeSessionState(cwd);
      const hooks = { ...confirmingHook().hooks, onEvent: endSessionAfterFirstScreen() };

      const error = await failureOf(runDiscovery(ctx, { cwd, hooks }));

      expect(error.code).toBe('E_AUTH_FAILED');
      expect(error.message).toBe('The saved session expired during the run');
      expect(error.hint).toBe('Save the storage state again and re-run');
      const events = await logOf(ctx);
      const authEvents = events.filter((event) => event.type.startsWith('auth.'));
      expect(authEvents.map((event) => event.type)).toEqual(['auth.completed', 'auth.lost']);
      expect(authEvents[1]).toMatchObject({ url: url('/home.html') });
      expect(eventsOf(events, 'screen.captured').map((event) => event.screen.title)).toEqual(['Dashboard']);
      expect(events.at(-1)).toMatchObject({
        type: 'run.failed',
        error: { code: 'E_AUTH_FAILED', message: error.message },
      });
      expect(await exists(join(ctx.dir, APP_MAP_FILE))).toBe(false);
    });

    test('without a loginUrl attaches no lost-session hook, so a lost session is captured as is', async () => {
      const { cwd, ctx } = await newProject({ auth: storageAuth(), maxScreens: 2 });
      await writeSessionState(cwd);
      vi.mocked(crawl).mockClear();
      const hooks = { ...confirmingHook().hooks, onEvent: endSessionAfterFirstScreen() };

      const result = await runDiscovery(ctx, { cwd, hooks });

      expect(vi.mocked(crawl)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(crawl).mock.calls[0]?.[2]).not.toHaveProperty('auth');
      // The documented limitation: `/home.html` is the login page now, and nothing notices.
      expect(result.map.screens.map((screen) => [screen.url, screen.title])).toEqual([
        [url('/'), 'Dashboard'],
        [url('/home.html'), 'Sign in'],
      ]);
      expect(eventsOf(await logOf(ctx), 'auth.lost')).toEqual([]);
    });

    test('fails with E_AUTH_FAILED naming the file when it does not exist', async () => {
      const { cwd, ctx } = await newProject({ auth: storageAuth() });

      const error = await failureOf(runDiscovery(ctx, { cwd, hooks: confirmingHook().hooks }));

      expect(error.code).toBe('E_AUTH_FAILED');
      expect(error.hint).toContain(join(cwd, STATE_FILE));
      expect((await logOf(ctx)).at(-1)).toMatchObject({
        type: 'run.failed',
        error: { code: 'E_AUTH_FAILED' },
      });
    });

    test('fails with E_AUTH_FAILED naming the file when the browser rejects it', async () => {
      const { cwd, ctx } = await newProject({ auth: storageAuth() });
      await writeFile(
        join(cwd, STATE_FILE),
        JSON.stringify({ cookies: [{ value: 'no name' }], origins: [] }),
      );

      const error = await failureOf(runDiscovery(ctx, { cwd, hooks: confirmingHook().hooks }));

      expect(error.code).toBe('E_AUTH_FAILED');
      expect(`${error.message}\n${error.hint ?? ''}`).toContain(join(cwd, STATE_FILE));
    });
  });

  describe('before opening a browser', () => {
    test.each([
      [
        'interaction is full without the disposable-data acknowledgement',
        { interaction: 'full' },
        'E_ACK_REQUIRED',
      ],
      ['no viewport is configured', { viewports: [] }, 'E_CONFIG_INVALID'],
      [
        'the base URL is not on an allowed host',
        { baseUrl: 'http://app.example.test:3000' },
        'E_NAVIGATION_BLOCKED',
      ],
    ])('fails when %s', async (_label, overrides, code) => {
      const { cwd, ctx } = await newProject({ auth: { type: 'none' }, ...overrides });

      const error = await failureOf(runDiscovery(ctx, { cwd, hooks: confirmingHook().hooks }));

      expect(error.code).toBe(code);
      expect(launchSpy).not.toHaveBeenCalled();
      const events = await logOf(ctx);
      expect(events.map((event) => event.type)).toEqual(['run.started', 'run.failed']);
    });

    test('hints at --allow-host for a base URL off the allowed hosts', async () => {
      const { cwd, ctx } = await newProject({
        auth: { type: 'none' },
        baseUrl: 'http://app.example.test:3000',
      });

      const error = await failureOf(runDiscovery(ctx, { cwd }));

      expect(error.hint).toContain('--allow-host app.example.test');
    });
  });
});
