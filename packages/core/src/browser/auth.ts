import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errors, type Page } from 'playwright';
import { z } from 'zod';
import type { LookoverConfig } from '../config/schema.js';
import { LookoverError } from '../errors.js';
import { resolveSeed } from '../map/crawler.js';
import { normaliseUrl, routeKey } from '../util/url.js';
import type { BrowserSession } from './session.js';

type Auth = LookoverConfig['auth'];
type FormAuth = Extract<Auth, { type: 'form' }>;

export interface EnsureAuthOptions {
  /** The app's root; the form's `loginUrl` and `successUrl` are resolved against it like crawl seeds. */
  baseUrl: string;
  /** Where the form login saves the session's storage state (created if missing). */
  stateDir: string;
  /** Where the credentials are read from. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** How long each step of the form login may take. Default 15000. */
  timeoutMs?: number;
}

export interface EnsureAuthResult {
  method: Auth['type'];
  /** The storage state file: the configured one, or the one the form login saved. */
  statePath?: string;
}

interface Credentials {
  username: string;
  password: string;
}

/** What `Page.waitForURL` accepts here: a glob or a predicate. */
type UrlMatcher = string | ((url: URL) => boolean);

const LOGIN_TIMEOUT_MS = 15_000;
const MS_PER_SECOND = 1_000;
const FORM_STATE_FILENAME = 'form.json';
/** A storage state holds live session cookies, so only its owner may read it. */
const STATE_FILE_MODE = 0o600;

const storageStateSchema = z.object({ cookies: z.array(z.unknown()) });

/**
 * Makes the session's browser context logged in as `auth` says and reports how.
 *
 * - `none` does nothing.
 * - `storageState` only checks that the file is a Playwright storage state; the engine must have
 *   launched `session` with it as `storageStatePath` (a context cannot load one afterwards).
 * - `form` logs in inside `session`'s own context, so the context is logged in afterwards and
 *   needs no relaunch. The state is also saved to `<stateDir>/form.json` for later runs, readable by
 *   its owner only. The credentials are read from the environment variables the config names and
 *   never appear in an error, in a log or on disk (the saved state holds cookies, not passwords).
 *
 * `loginUrl` and `successUrl` are app-relative like crawl seeds (`/` is the base URL itself). A
 * `successUrl` is matched exactly (path and query, trailing slash ignored), unless it contains
 * `*`, which makes it a Playwright glob.
 *
 * Every failure to log in is an `E_AUTH_FAILED` with a hint; a `successUrl` or `loginUrl` that
 * cannot be navigated is an `E_CONFIG_INVALID`.
 */
export async function ensureAuth(
  session: BrowserSession,
  auth: Auth,
  opts: EnsureAuthOptions,
): Promise<EnsureAuthResult> {
  switch (auth.type) {
    case 'none':
      return { method: 'none' };
    case 'storageState':
      await checkStorageState(auth.path);
      return { method: 'storageState', statePath: auth.path };
    case 'form':
      return { method: 'form', statePath: await loginWithForm(session, auth, opts) };
  }
}

/**
 * True when `url` is the login page of a form login: same origin as the base URL, and the path of
 * `loginUrl` (query and trailing slash ignored). The crawler's caller uses it to spot a lost
 * session. Always false for other auth types, and for a login page on another origin than the app.
 */
export function isLoginUrl(url: URL, auth: Auth, baseUrl: string): boolean {
  if (auth.type !== 'form') {
    return false;
  }
  const base = new URL(baseUrl);
  const login = resolveSeed(auth.loginUrl, base);
  const current = normaliseUrl(url.href, base);
  return (
    login !== null &&
    current !== null &&
    current.origin === base.origin &&
    login.origin === base.origin &&
    current.pathname === login.pathname
  );
}

async function checkStorageState(path: string): Promise<void> {
  const hint = `auth.path must be a Playwright storage state (JSON with a "cookies" array): ${path}`;
  const fail = (problem: string): LookoverError =>
    new LookoverError('E_AUTH_FAILED', `${problem}: ${path}`, hint);

  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    throw fail(isMissingFile(error) ? 'Storage state file not found' : 'Cannot read the storage state file');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw fail('Storage state file is not valid JSON');
  }
  if (!storageStateSchema.safeParse(parsed).success) {
    throw fail('Storage state file has no cookies array');
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function loginWithForm(
  session: BrowserSession,
  auth: FormAuth,
  opts: EnsureAuthOptions,
): Promise<string> {
  const base = new URL(opts.baseUrl);
  const loginUrl = requireNavigable(auth.loginUrl, base, 'loginUrl');
  const successMatcher = matcherForSuccess(auth.successUrl, base);
  const credentials = readCredentials(auth, opts.env ?? process.env);
  const timeoutMs = opts.timeoutMs ?? LOGIN_TIMEOUT_MS;

  const ipage = await session.newPage();
  try {
    await openLoginPage(ipage.page, loginUrl, timeoutMs);
    await submitForm(ipage.page, auth, credentials, timeoutMs);
    await awaitSuccess(ipage.page, auth.successUrl, successMatcher, timeoutMs);
  } finally {
    await ipage.close();
  }
  return saveState(session, opts.stateDir);
}

function readCredentials(auth: FormAuth, env: NodeJS.ProcessEnv): Credentials {
  const username = env[auth.usernameEnv];
  const password = env[auth.passwordEnv];
  if (username && password) {
    return { username, password };
  }
  const missing = [...(username ? [] : [auth.usernameEnv]), ...(password ? [] : [auth.passwordEnv])];
  throw new LookoverError(
    'E_AUTH_FAILED',
    `Login credentials are missing: ${missing.join(', ')} not set`,
    `Set ${missing.join(' and ')} in the environment`,
  );
}

async function openLoginPage(page: Page, loginUrl: URL, timeoutMs: number): Promise<void> {
  try {
    await page.goto(loginUrl.href, { waitUntil: 'load', timeout: timeoutMs });
  } catch (error) {
    const reason = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
    throw new LookoverError(
      'E_AUTH_FAILED',
      `Could not load the login page ${loginUrl.href}: ${reason}`,
      'Check loginUrl in lookover.config.json and that the app is running',
    );
  }
}

async function submitForm(
  page: Page,
  auth: FormAuth,
  credentials: Credentials,
  timeoutMs: number,
): Promise<void> {
  const { usernameSelector, passwordSelector, submitSelector } = auth;
  await onLoginPage(usernameSelector, timeoutMs, () =>
    page.locator(usernameSelector).fill(credentials.username, { timeout: timeoutMs }),
  );
  await onLoginPage(passwordSelector, timeoutMs, () =>
    page.locator(passwordSelector).fill(credentials.password, { timeout: timeoutMs }),
  );
  await onLoginPage(submitSelector, timeoutMs, () =>
    page.locator(submitSelector).click({ timeout: timeoutMs }),
  );
}

/** Runs one action on the login page; its timeout (an element that never shows up) names `selector`. */
async function onLoginPage(selector: string, timeoutMs: number, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) {
      throw error;
    }
    throw new LookoverError(
      'E_AUTH_FAILED',
      `Could not use ${selector} on the login page within ${seconds(timeoutMs)} s (missing, hidden or disabled?)`,
      'Check the selectors in lookover.config.json',
    );
  }
}

async function awaitSuccess(
  page: Page,
  successUrl: string,
  matcher: UrlMatcher,
  timeoutMs: number,
): Promise<void> {
  try {
    await page.waitForURL(matcher, { timeout: timeoutMs });
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) {
      throw error;
    }
    throw new LookoverError(
      'E_AUTH_FAILED',
      `Login did not reach ${successUrl} within ${seconds(timeoutMs)} s (still on ${page.url()})`,
      'Check the selectors and credentials in lookover.config.json',
    );
  }
}

async function saveState(session: BrowserSession, stateDir: string): Promise<string> {
  const statePath = join(stateDir, FORM_STATE_FILENAME);
  await mkdir(stateDir, { recursive: true });
  await session.context.storageState({ path: statePath });
  await chmod(statePath, STATE_FILE_MODE);
  return statePath;
}

/** An exact match on origin, path and query for a plain URL; a glob (Playwright's) when it has a `*`. */
function matcherForSuccess(successUrl: string, base: URL): UrlMatcher {
  if (successUrl.includes('*')) {
    return globFor(successUrl, base);
  }
  const target = requireNavigable(successUrl, base, 'successUrl');
  return (url) => {
    const current = normaliseUrl(url.href, url);
    return current !== null && current.origin === target.origin && routeKey(current) === routeKey(target);
  };
}

/** `resolveSeed` would escape the glob's characters, so an app-relative glob (`/...`) is only prefixed. */
function globFor(glob: string, base: URL): string {
  if (!glob.startsWith('/')) {
    return glob;
  }
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}${glob}`;
}

function requireNavigable(value: string, base: URL, field: 'loginUrl' | 'successUrl'): URL {
  const resolved = resolveSeed(value, base);
  if (resolved === null) {
    throw new LookoverError(
      'E_CONFIG_INVALID',
      `auth.${field} "${value}" is not a URL the browser can open`,
      `Set auth.${field} in lookover.config.json to a path such as /login or a full URL`,
    );
  }
  return resolved;
}

function seconds(ms: number): number {
  return ms / MS_PER_SECOND;
}
