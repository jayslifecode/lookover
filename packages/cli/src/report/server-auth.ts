import type { IncomingMessage } from 'node:http';
import { TOKEN_HEADER, tokenCookieName } from '@jayslifecode/lookover-report/api';
import { tokenMatches } from './token.js';

/*
 * Who may use the report server: a request addressed to it by its own name (not another site's name
 * rebound to 127.0.0.1), from whoever holds the run's token, as the server's own cookie the printed URL
 * sets or as the `X-Lookover-Token` header; and for a write, a page of one of the server's own origins
 * (`http://127.0.0.1:<port>`, `http://localhost:<port>`).
 */

const COOKIE_SEPARATOR = ';';
const COOKIE_ASSIGNMENT = '=';
/** The names a request may give the server in its `Host` header, with the server's port. */
const OWN_HOST_NAMES = ['127.0.0.1', 'localhost'] as const;

/**
 * The `Set-Cookie` value that hands the browser the token: never readable from a page, never sent
 * cross-site, and named after the server's `port`, so another server on 127.0.0.1 keeps its own.
 */
export function tokenCookie(token: string, port: number): string {
  return `${tokenCookieName(port)}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

/**
 * Whether the request carries `token`, in the header or in a cookie named for the server on `port` (no
 * other cookie is looked at); compared in constant time.
 */
export function hasToken(req: IncomingMessage, token: string, port: number): boolean {
  const header = req.headers[TOKEN_HEADER];
  if (typeof header === 'string' && tokenMatches(header, token)) return true;
  // Any of them: a page of another port (the same site) can set a cookie of this name ahead of ours.
  return cookieValues(req.headers.cookie, tokenCookieName(port)).some((value) => tokenMatches(value, token));
}

/**
 * Whether the request's `Host` names this server: `127.0.0.1:<port>` or `localhost:<port>`. A page of
 * another site whose name was rebound to 127.0.0.1 (DNS rebinding) sends that name, and is refused.
 */
export function isOwnHost(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host?.toLowerCase();
  return OWN_HOST_NAMES.some((name) => host === `${name}:${port}`);
}

/**
 * Whether the request comes from a page of the server on `port`, opened as 127.0.0.1 or as localhost
 * (a POST must: a page of any other origin, a cross-site form included, carries its own).
 */
export function isSameOrigin(req: IncomingMessage, port: number): boolean {
  return OWN_HOST_NAMES.some((name) => req.headers.origin === `http://${name}:${port}`);
}

/** The values of every cookie `name` in a `Cookie` header, in order; none when it has none. */
function cookieValues(header: string | undefined, name: string): string[] {
  if (header === undefined) return [];
  return header.split(COOKIE_SEPARATOR).flatMap((pair) => {
    const at = pair.indexOf(COOKIE_ASSIGNMENT);
    return at !== -1 && pair.slice(0, at).trim() === name ? [pair.slice(at + 1).trim()] : [];
  });
}
