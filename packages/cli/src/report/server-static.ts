import type { ServerResponse } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { REPORT_DIST_DIR, REPORT_INDEX_FILE } from '@jayslifecode/lookover-report';
import { TOKEN_QUERY } from '@jayslifecode/lookover-report/api';
import { tokenCookie } from './server-auth.js';
import { HttpError, IMMUTABLE, NO_STORE, safeSegments, send, sendFile } from './server-http.js';
import { tokenMatches } from './token.js';

/*
 * The built report: `index.html` for `/` (the report routes with the hash, so nothing else falls back to
 * it) and the files under the report's `dist/`, nothing outside it. Opening the printed URL
 * (`/?token=<t>`) with the right token sets the token cookie and redirects to `/`, so the token leaves
 * the address bar; a wrong one is a plain `/`.
 */

const ROOT = '/';
/** Vite names what it puts here by the hash of its content. */
const ASSETS_PREFIX = '/assets/';
const FOUND = 302;
const NOT_FOUND = 'The report has no such file';

/** Answers a GET of `path` (raw, as requested) with the query `query` (without its `?`). */
export async function serveStatic(
  res: ServerResponse,
  path: string,
  query: string,
  token: string,
): Promise<void> {
  if (path === ROOT) {
    const given = new URLSearchParams(query).get(TOKEN_QUERY);
    if (given !== null && tokenMatches(given, token)) {
      send(res, FOUND, { location: ROOT, 'set-cookie': tokenCookie(token) });
      return;
    }
    return sendFile(res, REPORT_INDEX_FILE);
  }
  const file = distFile(path);
  const cacheControl = path.startsWith(ASSETS_PREFIX) ? IMMUTABLE : NO_STORE;
  return sendFile(res, file, { cacheControl, missing: NOT_FOUND });
}

/** Where `path` is in the report's `dist/`; a 404 `HttpError` for one that would lead out of it. */
function distFile(path: string): string {
  const segments = safeSegments(path.slice(ROOT.length));
  if (segments === null) throw new HttpError(404, NOT_FOUND);
  const file = resolve(REPORT_DIST_DIR, join(...segments));
  if (!file.startsWith(`${resolve(REPORT_DIST_DIR)}${sep}`)) throw new HttpError(404, NOT_FOUND);
  return file;
}
