import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { ensureAuth, isLoginUrl } from '../src/browser/auth.js';
import { BrowserSession } from '../src/browser/session.js';
import { configSchema, type LookoverConfig } from '../src/config/schema.js';
import { LookoverError } from '../src/errors.js';
import {
  DEMO_CREDENTIALS,
  type FixtureServer,
  HOME_PATH,
  LOGIN_PATH,
  requireSession,
  SESSION_COOKIE,
  serveFixture,
  submitLogin,
} from './fixtures/serve.js';

const LOGIN_DIR = fileURLToPath(new URL('./fixtures/login', import.meta.url));
const BROWSER_TIMEOUT_MS = 30_000;
/** Long enough for a redirect to land, short enough that the tests of a login that fails stay quick. */
const SHORT_TIMEOUT_MS = 1_500;
const VIEWPORT = { name: 'desktop', width: 1280, height: 800 };
const DEMO_ENV = { LOOKOVER_USERNAME: DEMO_CREDENTIALS.user, LOOKOVER_PASSWORD: DEMO_CREDENTIALS.pass };
const FORM_STATE_FILE = 'form.json';

type Auth = LookoverConfig['auth'];

/** A form login for the login fixture; `overrides` replace any of its fields. */
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

describe('ensureAuth', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let workDir: string;
  let session: BrowserSession;

  const url = (path: string): string => `${fixture.url}${path}`;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lookover-auth-'));
    fixture = await serveFixture(LOGIN_DIR, {
      '/home.html': requireSession,
      '/login': submitLogin,
      '/broken': (req) => req.socket.destroy(),
    });
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await fixture.close();
    await rm(workDir, { recursive: true, force: true });
  }, BROWSER_TIMEOUT_MS);

  beforeEach(async () => {
    session = await newSession();
  }, BROWSER_TIMEOUT_MS);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await session.close();
  }, BROWSER_TIMEOUT_MS);

  function newSession(storageStatePath?: string): Promise<BrowserSession> {
    return BrowserSession.launch({
      viewport: VIEWPORT,
      allowHosts: [],
      onEvent: () => {},
      ...(storageStatePath === undefined ? {} : { storageStatePath }),
    });
  }

  /** A state directory that does not exist yet, so a test sees whether `ensureAuth` creates it. */
  async function freshStateDir(): Promise<string> {
    return join(await mkdtemp(join(workDir, 'run-')), 'auth');
  }

  async function login(
    auth: Auth,
    overrides: { env?: NodeJS.ProcessEnv; stateDir?: string; timeoutMs?: number } = {},
  ): ReturnType<typeof ensureAuth> {
    return ensureAuth(session, auth, {
      baseUrl: fixture.url,
      stateDir: overrides.stateDir ?? (await freshStateDir()),
      env: overrides.env ?? DEMO_ENV,
      ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
    });
  }

  /** The path the session lands on when it opens `path`, in a page of its own. */
  async function landingPath(target: BrowserSession, path: string): Promise<string> {
    const ipage = await target.newPage();
    try {
      await ipage.page.goto(url(path), { waitUntil: 'load' });
      return new URL(ipage.page.url()).pathname;
    } finally {
      await ipage.close();
    }
  }

  describe('with no authentication', () => {
    test('does nothing', async () => {
      const stateDir = await freshStateDir();

      const result = await login({ type: 'none' }, { stateDir });

      expect(result).toEqual({ method: 'none' });
      expect(await exists(stateDir)).toBe(false);
      expect(session.context.pages()).toHaveLength(0);
    });
  });

  describe('with a storage state', () => {
    test('returns the path of a file that holds cookies', async () => {
      const path = join(workDir, 'valid-state.json');
      await writeFile(path, JSON.stringify({ cookies: [], origins: [] }));

      const result = await login({ type: 'storageState', path });

      expect(result).toEqual({ method: 'storageState', statePath: path });
    });

    test('fails when the file does not exist, naming it in the hint', async () => {
      const path = join(workDir, 'missing-state.json');

      const error = await failureOf(login({ type: 'storageState', path }));

      expect(error.code).toBe('E_AUTH_FAILED');
      expect(error.hint).toContain(path);
    });

    test.each([
      ['is not JSON', 'not json at all'],
      ['has no cookies array', JSON.stringify({ origins: [] })],
      ['is a JSON array', JSON.stringify([])],
    ])('fails when the file %s', async (_label, content) => {
      const path = join(workDir, 'broken-state.json');
      await writeFile(path, content);

      const error = await failureOf(login({ type: 'storageState', path }));

      expect(error.code).toBe('E_AUTH_FAILED');
      expect(error.hint).toContain(path);
    });
  });

  describe('with a form login', () => {
    test('logs the session in and saves its storage state to <stateDir>/form.json', async () => {
      const stateDir = await freshStateDir();

      const result = await login(formAuth(), { stateDir });

      expect(result).toEqual({ method: 'form', statePath: join(stateDir, FORM_STATE_FILE) });
      const saved = JSON.parse(await readFile(join(stateDir, FORM_STATE_FILE), 'utf8')) as {
        cookies: { name: string }[];
      };
      expect(saved.cookies.map((cookie) => cookie.name)).toContain(SESSION_COOKIE.name);
      expect(await landingPath(session, HOME_PATH)).toBe(HOME_PATH);
      expect(session.context.pages()).toHaveLength(0);
    });

    test('lets a fresh session launched with the saved state open a protected page', async () => {
      const anonymous = await newSession();
      try {
        expect(await landingPath(anonymous, HOME_PATH)).toBe(LOGIN_PATH);
      } finally {
        await anonymous.close();
      }
      const { statePath } = await login(formAuth());

      const restored = await newSession(statePath);
      try {
        expect(await landingPath(restored, HOME_PATH)).toBe(HOME_PATH);
      } finally {
        await restored.close();
      }
    });

    test('reads the credentials from the environment variables the config names', async () => {
      const auth = formAuth({ usernameEnv: 'APP_USER', passwordEnv: 'APP_PASS' });

      const result = await login(auth, {
        env: { APP_USER: DEMO_CREDENTIALS.user, APP_PASS: DEMO_CREDENTIALS.pass },
      });

      expect(result.method).toBe('form');
    });

    test('reads process.env when no environment is given', async () => {
      vi.stubEnv('LOOKOVER_USERNAME', DEMO_CREDENTIALS.user);
      vi.stubEnv('LOOKOVER_PASSWORD', DEMO_CREDENTIALS.pass);

      const result = await ensureAuth(session, formAuth(), {
        baseUrl: fixture.url,
        stateDir: await freshStateDir(),
      });

      expect(result.method).toBe('form');
    });

    test.each([
      ['not set', { LOOKOVER_USERNAME: DEMO_CREDENTIALS.user }],
      ['empty', { LOOKOVER_USERNAME: DEMO_CREDENTIALS.user, LOOKOVER_PASSWORD: '' }],
    ])('fails before opening a page when the password variable is %s', async (_label, env) => {
      const error = await failureOf(login(formAuth(), { env }));

      expect(error.code).toBe('E_AUTH_FAILED');
      expect(error.hint).toContain('LOOKOVER_PASSWORD');
      expect(error.hint).not.toContain('LOOKOVER_USERNAME');
    });

    test('names every variable that is missing', async () => {
      const error = await failureOf(login(formAuth(), { env: {} }));

      expect(error.hint).toContain('LOOKOVER_USERNAME');
      expect(error.hint).toContain('LOOKOVER_PASSWORD');
    });

    test('fails with E_AUTH_FAILED, leaving no state behind, when the password is wrong', async () => {
      const stateDir = await freshStateDir();
      const wrongPassword = 'not-the-password';

      const error = await failureOf(
        login(formAuth(), {
          stateDir,
          env: { LOOKOVER_USERNAME: DEMO_CREDENTIALS.user, LOOKOVER_PASSWORD: wrongPassword },
          timeoutMs: SHORT_TIMEOUT_MS,
        }),
      );

      expect(error.code).toBe('E_AUTH_FAILED');
      expect(error.message).toContain(`Login did not reach ${HOME_PATH} within 1.5 s`);
      expect(error.message).toContain('still on');
      expect(error.message).toContain('/login');
      expect(error.hint).toBe('Check the selectors and credentials in lookover.config.json');
      expect(`${error.message} ${error.hint}`).not.toContain(wrongPassword);
      expect(await exists(stateDir)).toBe(false);
      expect(session.context.pages()).toHaveLength(0);
    });

    test.each([
      ['an app-relative path', () => HOME_PATH],
      ['an absolute URL', () => url(HOME_PATH)],
      ['a glob', () => '/ho*.html'],
    ])('accepts a successUrl written as %s', async (_label, successUrl) => {
      const result = await login(formAuth({ successUrl: successUrl() }));

      expect(result.method).toBe('form');
    });

    test('matches an app-relative successUrl exactly, not as a prefix', async () => {
      const error = await failureOf(login(formAuth({ successUrl: '/' }), { timeoutMs: SHORT_TIMEOUT_MS }));

      expect(error.code).toBe('E_AUTH_FAILED');
      expect(error.message).toContain('Login did not reach / within');
    });

    test.each([
      ['username', { usernameSelector: '#no-such-field' }, '#no-such-field'],
      ['password', { passwordSelector: '#no-such-field' }, '#no-such-field'],
      ['submit', { submitSelector: '#no-such-button' }, '#no-such-button'],
    ])(
      'fails naming the %s selector when the login page has no such element',
      async (_label, overrides, selector) => {
        const error = await failureOf(login(formAuth(overrides), { timeoutMs: SHORT_TIMEOUT_MS }));

        expect(error.code).toBe('E_AUTH_FAILED');
        expect(error.message).toContain(selector);
        expect(session.context.pages()).toHaveLength(0);
      },
    );

    test('fails when the login page cannot be loaded', async () => {
      const error = await failureOf(
        login(formAuth({ loginUrl: '/broken' }), { timeoutMs: SHORT_TIMEOUT_MS }),
      );

      expect(error.code).toBe('E_AUTH_FAILED');
      expect(error.message).toContain('login page');
      expect(session.context.pages()).toHaveLength(0);
    });
  });
});

describe('isLoginUrl', () => {
  const baseUrl = 'http://localhost:3000';

  test.each([
    ['the login path', 'http://localhost:3000/login'],
    ['the login path with a trailing slash', 'http://localhost:3000/login/'],
    ['the login path with a query', 'http://localhost:3000/login?next=%2Fdashboard'],
  ])('is true for %s', (_label, href) => {
    expect(isLoginUrl(new URL(href), formAuth({ loginUrl: '/login' }), baseUrl)).toBe(true);
  });

  test.each([
    ['another path', 'http://localhost:3000/dashboard'],
    ['a path below the login path', 'http://localhost:3000/login/help'],
    ['another origin', 'http://localhost:4000/login'],
    ['another host', 'https://example.com/login'],
  ])('is false for %s', (_label, href) => {
    expect(isLoginUrl(new URL(href), formAuth({ loginUrl: '/login' }), baseUrl)).toBe(false);
  });

  test('resolves an app-relative login URL below the base path', () => {
    const auth = formAuth({ loginUrl: '/login' });

    expect(isLoginUrl(new URL('http://localhost:3000/app/login'), auth, 'http://localhost:3000/app/')).toBe(
      true,
    );
    expect(isLoginUrl(new URL('http://localhost:3000/login'), auth, 'http://localhost:3000/app/')).toBe(
      false,
    );
  });

  test('accepts an absolute login URL', () => {
    const auth = formAuth({ loginUrl: 'http://localhost:3000/sign-in' });

    expect(isLoginUrl(new URL('http://localhost:3000/sign-in'), auth, baseUrl)).toBe(true);
  });

  test('is false when the login URL is on another origin than the base URL', () => {
    const auth = formAuth({ loginUrl: 'https://sso.example.com/login' });

    expect(isLoginUrl(new URL('https://sso.example.com/login'), auth, baseUrl)).toBe(false);
    expect(isLoginUrl(new URL('http://localhost:3000/login'), auth, baseUrl)).toBe(false);
  });

  test.each([
    ['no authentication', { type: 'none' }],
    ['a storage state', { type: 'storageState', path: 'state.json' }],
  ] satisfies [string, Auth][])('is false for %s', (_label, auth) => {
    expect(isLoginUrl(new URL('http://localhost:3000/login'), auth, baseUrl)).toBe(false);
  });
});
