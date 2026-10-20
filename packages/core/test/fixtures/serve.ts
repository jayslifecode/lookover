import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';

/** Serves the fixture file at `pathname` (by default the request's own), as an unrouted request would be. */
export type ServeStatic = (pathname?: string) => void;

/**
 * Handles the requests to one route instead of the static files (redirects, dynamic responses).
 * `serveStatic` lets a handler fall back to a fixture file once it has had its say.
 */
export type FixtureRoute = (req: IncomingMessage, res: ServerResponse, serveStatic: ServeStatic) => void;

export interface FixtureServer {
  /** Origin without a trailing slash, e.g. `http://127.0.0.1:53121`. */
  url: string;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';
const EPHEMERAL_PORT = 0;
const DEFAULT_EVENT_INTERVAL_MS = 200;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

/**
 * Serves `dir` on an ephemeral port. A key of `routes` is a pathname whose `:name` segments match
 * any one non-empty segment (`/orgs/:id`); routes take precedence over files, and an exact key over
 * a pattern. A directory requested without its trailing slash is redirected to it, as static
 * servers do.
 */
export async function serveFixture(
  dir: string,
  routes: Readonly<Record<string, FixtureRoute>> = {},
): Promise<FixtureServer> {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://fixture.invalid').pathname;
    const serveStatic: ServeStatic = (file = pathname) => void serveFile(root, file, res);
    const route = findRoute(routes, pathname);
    if (route) {
      route(req, res, serveStatic);
      return;
    }
    serveStatic();
  });

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(EPHEMERAL_PORT, HOST, () => done());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${HOST}:${port}`,
    close: () =>
      new Promise<void>((done, fail) => {
        server.close((error) => (error ? fail(error) : done()));
        server.closeAllConnections();
      }),
  };
}

/** The cookie that marks a logged-in browser (see `requireSession` and `submitLogin`). */
export const SESSION_COOKIE = { name: 'session', value: 'valid' } as const;
export const LOGIN_PATH = '/login.html';
export const HOME_PATH = '/home.html';
/** What `submitLogin` accepts, as the form fields `user` and `pass`. */
export const DEMO_CREDENTIALS = { user: 'demo', pass: 'demo-password' } as const;

export function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}): void {
  res.writeHead(302, { location, ...headers });
  res.end();
}

export function hasSessionCookie(req: IncomingMessage): boolean {
  const expected = `${SESSION_COOKIE.name}=${SESSION_COOKIE.value}`;
  return (req.headers.cookie ?? '').split(';').some((pair) => pair.trim() === expected);
}

/** A page behind the session cookie: served as the fixture file with it, a 302 to the login page without. */
export const requireSession: FixtureRoute = (req, res, serveStatic) => {
  if (hasSessionCookie(req)) {
    serveStatic();
    return;
  }
  redirect(res, LOGIN_PATH);
};

/**
 * `POST /login`: the right `user` and `pass` (`DEMO_CREDENTIALS`) set the session cookie and redirect
 * to the home page; anything else re-renders the login page with a 200, as many apps do.
 */
export const submitLogin: FixtureRoute = (req, res, serveStatic) => {
  if (req.method !== 'POST') {
    serveStatic();
    return;
  }
  readForm(req).then(
    (form) => {
      const isValid =
        form.get('user') === DEMO_CREDENTIALS.user && form.get('pass') === DEMO_CREDENTIALS.pass;
      if (isValid) {
        redirect(res, HOME_PATH, {
          'set-cookie': `${SESSION_COOKIE.name}=${SESSION_COOKIE.value}; Path=/; HttpOnly`,
        });
        return;
      }
      serveStatic(LOGIN_PATH);
    },
    () => res.destroy(),
  );
};

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** A server-sent event stream that never ends: a `tick` event every `intervalMs` until the client leaves. */
export function eventStream(intervalMs = DEFAULT_EVENT_INTERVAL_MS): FixtureRoute {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': open\n\n');
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      res.write(`data: tick ${ticks}\n\n`);
    }, intervalMs);
    res.on('close', () => clearInterval(timer));
  };
}

function findRoute(
  routes: Readonly<Record<string, FixtureRoute>>,
  pathname: string,
): FixtureRoute | undefined {
  const exact = routes[pathname];
  if (exact) {
    return exact;
  }
  return Object.entries(routes).find(([pattern]) => matchesPattern(pattern, pathname))?.[1];
}

function matchesPattern(pattern: string, pathname: string): boolean {
  const expected = pattern.split('/');
  const actual = pathname.split('/');
  return (
    expected.length === actual.length &&
    expected.every((segment, index) => {
      const value = actual[index] ?? '';
      return segment === value || (segment.startsWith(':') && value !== '');
    })
  );
}

async function serveFile(root: string, pathname: string, res: ServerResponse): Promise<void> {
  const file = fileFor(root, pathname);
  if (file !== null && (await isDirectory(file))) {
    res.writeHead(301, { location: `${pathname}/` });
    res.end();
    return;
  }
  const type = file === null ? undefined : CONTENT_TYPES[extname(file)];
  if (file === null || type === undefined) {
    notFound(res);
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  } catch {
    notFound(res);
  }
}

async function isDirectory(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isDirectory();
  } catch {
    return false;
  }
}

/** The file under `root` for `pathname`, or `null` when it is malformed or escapes `root`. */
function fileFor(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const file = resolve(root, `.${decoded}`);
  const target = decoded.endsWith('/') ? join(file, 'index.html') : file;
  return target.startsWith(`${root}${sep}`) ? target : null;
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}
