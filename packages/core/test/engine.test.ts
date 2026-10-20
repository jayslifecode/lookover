import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
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
import { BrowserSession } from '../src/browser/session.js';
import { configSchema, type LookoverConfig } from '../src/config/schema.js';
import { LookoverError } from '../src/errors.js';
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

const LOGIN_DIR = fileURLToPath(new URL('./fixtures/login', import.meta.url));
const BROWSER_TIMEOUT_MS = 60_000;
const DEMO_ENV = { LOOKOVER_USERNAME: DEMO_CREDENTIALS.user, LOOKOVER_PASSWORD: DEMO_CREDENTIALS.pass };
/** Called by the dashboard (`/`), the page the probe always opens. */
const SUPABASE_HOST = 'xyz.supabase.co';
/** Called by `/projects` only, which nothing links to: only the probe or a seed reaches it. */
const PROJECTS_API_HOST = 'api.backend.test';
const UNCONFIRMED_HINT =
  'Run again with --confirm-host <host> for each development or disposable backend, or add it to confirmedBackendHosts';
/** The Next.js routes of the project with a root: a login, a destructive and a dynamic route among them. */
const NEXT_ROUTE_DIRS = ['', 'login', 'logout', 'projects', 'projects/[id]'];
const NEXT_PATTERNS = ['/', '/login', '/logout', '/projects', '/projects/[id]'];
const CLEARED_SESSION_COOKIE = `${SESSION_COOKIE.name}=; Path=/; Max-Age=0`;

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

  const url = (path: string): string => `${fixture.url}${path}`;

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
    fixture = await serveFixture(LOGIN_DIR, {
      '/': protectedPage,
      '/home.html': protectedPage,
      '/settings.html': protectedPage,
      '/projects': (req, res, serveStatic) => protectedPage(req, res, () => serveStatic('/projects.html')),
      '/login': submitLogin,
      '/logout': (_req, res) => {
        logoutRequests += 1;
        redirect(res, LOGIN_PATH, { 'set-cookie': CLEARED_SESSION_COOKIE });
      },
    });
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await fixture.close();
    await rm(workDir, { recursive: true, force: true });
  }, BROWSER_TIMEOUT_MS);

  beforeEach(() => {
    // The backends must not be reached from a test: the resolver makes them unresolvable, which leaves
    // their calls observed (the request is made) but never sent. Only the test sets `testResolver`.
    const launch = BrowserSession.launch.bind(BrowserSession);
    launchSpy = vi
      .spyOn(BrowserSession, 'launch')
      .mockImplementation((options) =>
        launch({ ...options, testResolver: { blockedHosts: [SUPABASE_HOST, PROJECTS_API_HOST] } }),
      );
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
    test('refuses to crawl while a backend is unconfirmed and there is no hook to confirm it', async () => {
      const { cwd, ctx } = await newProject();

      const error = await failureOf(runDiscovery(ctx, { cwd, env: DEMO_ENV }));

      expect(error.code).toBe('E_HOSTS_UNCONFIRMED');
      expect(error.message.split('\n')).toContain(`  ${SUPABASE_HOST}`);
      expect(error.hint).toBe(UNCONFIRMED_HINT);
      const events = await logOf(ctx);
      expect(events.at(-1)).toMatchObject({
        type: 'run.failed',
        error: { code: 'E_HOSTS_UNCONFIRMED', message: error.message },
      });
      expect(eventsOf(events, 'screen.discovered')).toEqual([]);
      expect(await exists(join(ctx.dir, APP_MAP_FILE))).toBe(false);
    });

    test('logs in, crawls once the hook confirms the backend, and persists the map', async () => {
      const { cwd, ctx } = await newProject();
      const { hooks, asked } = confirmingHook();

      const result = await runDiscovery(ctx, { cwd, env: DEMO_ENV, hooks });

      expect(asked).toEqual([[SUPABASE_HOST]]);
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

    test('fails with E_RUN_FAILED, writing no map, when the run log loses an event', async () => {
      const { cwd, ctx } = await newProject();
      const append = ctx.log.append.bind(ctx.log);
      vi.spyOn(ctx.log, 'append').mockImplementation((body: RunEventBody) =>
        body.type === 'host.observed' ? Promise.reject(new Error('disk full')) : append(body),
      );

      const error = await failureOf(runDiscovery(ctx, { cwd, env: DEMO_ENV, hooks: confirmingHook().hooks }));

      expect(error.code).toBe('E_RUN_FAILED');
      expect(error.message).toBe('Run log write failed: disk full');
      expect((await logOf(ctx)).at(-1)).toMatchObject({
        type: 'run.failed',
        error: { code: 'E_RUN_FAILED', message: error.message },
      });
      expect(await exists(join(ctx.dir, APP_MAP_FILE))).toBe(false);
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

    test('names only the hosts the hook left unconfirmed', async () => {
      const { cwd, ctx } = await newProject({ auth: formAuth({ loginUrl: '/login' }) }, NEXT_ROUTE_DIRS);
      const { hooks, asked } = confirmingHook((hosts) => hosts.filter((host) => host === SUPABASE_HOST));

      const error = await failureOf(runDiscovery(ctx, { cwd, env: DEMO_ENV, hooks }));

      expect(asked).toEqual([[PROJECTS_API_HOST, SUPABASE_HOST]]);
      expect(error.code).toBe('E_HOSTS_UNCONFIRMED');
      expect(error.message.split('\n')).toContain(`  ${PROJECTS_API_HOST}`);
      expect(error.message).not.toContain(SUPABASE_HOST);
      expect(error.hint).toBe(UNCONFIRMED_HINT);
    });
  });

  describe('with a storage state', () => {
    const STATE_FILE = 'state.json';

    function storageAuth(): Auth {
      return { type: 'storageState', path: STATE_FILE };
    }

    test('launches the session with the file resolved against the project directory', async () => {
      const { cwd, ctx } = await newProject({ auth: storageAuth(), maxScreens: 1 });
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
      expect(relative(process.cwd(), statePath)).not.toBe(STATE_FILE);

      const result = await runDiscovery(ctx, { cwd, hooks: confirmingHook().hooks });

      expect(launchOptions().storageStatePath).toBe(statePath);
      expect(eventsOf(await logOf(ctx), 'auth.completed')).toEqual([
        expect.objectContaining({ method: 'storageState', statePath }),
      ]);
      expect(result.map.screens.map((screen) => screen.title)).toEqual(['Dashboard']);
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
