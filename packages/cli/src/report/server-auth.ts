import type { IncomingMessage } from 'node:http';
import { TOKEN_COOKIE, TOKEN_HEADER } from '@jayslifecode/lookover-report/api';
import { tokenMatches } from './token.js';

/*
 * Who may use the report server: whoever holds the run's token, as the cookie the printed URL sets or as
 * the `X-Lookover-Token` header; and for a write, a page of the server's own origin.
 */

const COOKIE_SEPARATOR = ';';
const COOKIE_ASSIGNMENT = '=';

/** The `Set-Cookie` value that hands the browser the token: never readable from a page, never sent cross-site. */
export function tokenCookie(token: string): string {
  return `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

/** Whether the request carries `token`, in the header or the cookie; compared in constant time. */
export function hasToken(req: IncomingMessage, token: string): boolean {
  const header = req.headers[TOKEN_HEADER];
  if (typeof header === 'string' && tokenMatches(header, token)) return true;
  const cookie = cookieValue(req.headers.cookie, TOKEN_COOKIE);
  return cookie !== null && tokenMatches(cookie, token);
}

/** Whether the request comes from a page of `origin` (a POST must: a cross-site form carries its own). */
export function isSameOrigin(req: IncomingMessage, origin: string): boolean {
  return req.headers.origin === origin;
}

/** The value of the cookie `name` in a `Cookie` header; `null` when it has none. */
function cookieValue(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const pair of header.split(COOKIE_SEPARATOR)) {
    const at = pair.indexOf(COOKIE_ASSIGNMENT);
    if (at !== -1 && pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim();
  }
  return null;
}
