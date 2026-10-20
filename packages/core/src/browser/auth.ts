import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errors, type Page } from 'playwright';
import { z } from 'zod';
import type { LookoverConfig } from '../config/schema.js';
import { LookoverError } from '../errors.js';
import { isMissingFile, writeFileAtomic } from '../util/fs.js';
import { normaliseUrl, resolveSeed, routeKey } from '../util/url.js';
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
const STATE_DIR_MODE = 0o700;
const SELECTOR_HINT =
  'Check the selectors in lookover.config.json: each must match exactly one element of the right kind';

const storageStateSchema = z.object({ cookies: z.array(z.unknown()) });

/**
 * Makes the session's browser context logged in as `auth` says and reports how.
 *
 * - `none` does nothing.
 * - `storageState` only checks that the file is a Playwright storage state; the engine must have
 *   launched `session` with it as `storageStatePath` (a context cannot load one afterwards).
 * - `form` logs in inside `session`'s own context, so the context is logged in afterwards and
 *   needs no relaunch. The state is also saved to `<stateDir>/form.json` for later runs: written to
 *   a temporary file readable by its owner only, then renamed into place, so a reader never sees a
 *   partial file. The credentials are read from the environment variables the config names and
 *   never appear in an error, in a log or on disk (the saved state holds cookies, not passwords):
 *   Playwright's own messages are not passed on where they can repeat a typed value or the query of
 *   a form that submits by GET.
 *
 * `loginUrl` and `successUrl` are app-relative like crawl seeds (`/` is the base URL itself). A
 * `successUrl` is matched exactly (path and query, trailing slash ignored), unless it contains
 * `*`, which makes it a Playwright glob.
 *
 * Every failure to log in is an `E_AUTH_FAILED` with a hint, including a `successUrl` that matches
 * the login page itself; a `successUrl` or `loginUrl` that cannot be navigated is an
 * `E_CONFIG_INVALID`.
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
 * True when `url` is the app's login page: same origin as the base URL, and the path of the auth's
 * `loginUrl` (query and trailing slash ignored). The crawler's caller uses it to spot a lost
 * session. Always false without a `loginUrl` (no auth, or a storage state that names none), and for
 * a login page on another origin than the app.
 */
export function isLoginUrl(url: URL, auth: Auth, baseUrl: string): boolean {
  const loginUrl = auth.type === 'none' ? undefined : auth.loginUrl;
  if (loginUrl === undefined) {
    return false;
  }
  const base = new URL(baseUrl);
  const login = resolveSeed(loginUrl, base);
  const current = normaliseUrl(url.href, base);
  return (
    login !== null &&
    current !== null &&
    current.origin === base.origin &&
    login.origin === base.origin &&
    current.pathname === login.pathname
  );
}

/**
 * Checks that `path` is a Playwright storage state (JSON with a `cookies` array); every problem is an
 * `E_AUTH_FAILED` naming the file. The engine runs it before it launches a session with the file.
 */
export async function checkStorageState(path: string): Promise<void> {
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
    await awaitSuccess(ipage.page, auth, successMatcher, { baseUrl: opts.baseUrl, timeoutMs });
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
  await onLoginPage('fill username', usernameSelector, timeoutMs, () =>
    page.locator(usernameSelector).fill(credentials.username, { timeout: timeoutMs }),
  );
  await onLoginPage('fill password', passwordSelector, timeoutMs, () =>
    page.locator(passwordSelector).fill(credentials.password, { timeout: timeoutMs }),
  );
  await onLoginPage('click submit', submitSelector, timeoutMs, () =>
    page.locator(submitSelector).click({ timeout: timeoutMs }),
  );
}

/**
 * Runs one step on the login page; any error from it becomes an `E_AUTH_FAILED` that names the step
 * and the selector. Playwright's message is dropped on purpose: the call log of a `fill` repeats the
 * value being typed.
 */
async function onLoginPage(
  step: string,
  selector: string,
  timeoutMs: number,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    const problem =
      error instanceof errors.TimeoutError
        ? `${selector} matched no visible, enabled element within ${seconds(timeoutMs)} s`
        : `${selector} cannot be used for this step`;
    throw new LookoverError(
      'E_AUTH_FAILED',
      `Could not ${step} on the login page: ${problem}`,
      SELECTOR_HINT,
    );
  }
}

/**
 * Waits for the page to reach `auth.successUrl`. Playwright's message is not passed on: it can name
 * the URL with its query, and a form that submits by GET puts the credentials there. A page that
 * is still the login page once the wait is over means `successUrl` matched it, so nothing proves
 * the login worked.
 */
async function awaitSuccess(
  page: Page,
  auth: FormAuth,
  matcher: UrlMatcher,
  opts: { baseUrl: string; timeoutMs: number },
): Promise<void> {
  const { successUrl } = auth;
  try {
    await page.waitForURL(matcher, { timeout: opts.timeoutMs });
  } catch (error) {
    const outcome =
      error instanceof errors.TimeoutError
        ? `did not reach ${successUrl} within ${seconds(opts.timeoutMs)} s`
        : `failed while waiting for ${successUrl}`;
    throw new LookoverError(
      'E_AUTH_FAILED',
      `Login ${outcome} (still on ${locationOf(page.url())})`,
      'Check the selectors and credentials in lookover.config.json',
    );
  }
  const current = URL.parse(page.url());
  if (current !== null && isLoginUrl(current, auth, opts.baseUrl)) {
    throw new LookoverError(
      'E_AUTH_FAILED',
      `Login did not leave the login page (still on ${locationOf(page.url())}) although it matched ${successUrl}`,
      'successUrl must not match the login page',
    );
  }
}

/** `rawUrl` without its query, fragment and credentials, for messages. */
function locationOf(rawUrl: string): string {
  const url = URL.parse(rawUrl);
  if (url === null) {
    return 'an unknown page';
  }
  return Object.assign(url, { search: '', hash: '', username: '', password: '' }).href;
}

/** Writes the context's state, readable by its owner only, atomically onto `<stateDir>/form.json`. */
async function saveState(session: BrowserSession, stateDir: string): Promise<string> {
  const statePath = join(stateDir, FORM_STATE_FILENAME);
  await mkdir(stateDir, { recursive: true, mode: STATE_DIR_MODE });
  const state = await session.context.storageState();
  await writeFileAtomic(statePath, JSON.stringify(state, null, 2), { mode: STATE_FILE_MODE });
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
