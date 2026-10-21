const JUNK_PROTOCOLS: ReadonlySet<string> = new Set(['mailto:', 'tel:', 'javascript:', 'data:', 'blob:']);

function parseUrl(href: string, base: URL): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

function stripTrailingSlashes(pathname: string): string {
  const stripped = pathname.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/**
 * Resolves `href` against `base` into a canonical URL for de-duplication:
 * hash dropped, query parameters sorted by key (stable for duplicates), host
 * lowercased by the URL parser, trailing slash removed unless the path is `/`.
 * Returns `null` for non-navigable hrefs (fragment-only, mailto:, tel:,
 * javascript:, data:, blob:) and for hrefs that cannot be parsed.
 */
export function normaliseUrl(href: string, base: URL): URL | null {
  const trimmed = href.trim();
  if (trimmed.startsWith('#')) return null;

  const resolved = parseUrl(trimmed, base);
  if (resolved === null || JUNK_PROTOCOLS.has(resolved.protocol)) return null;

  resolved.hash = '';
  resolved.searchParams.sort();
  resolved.pathname = stripTrailingSlashes(resolved.pathname);
  return resolved;
}

/**
 * True when `url` is on the same origin as `base` and inside the base path,
 * treated as a directory prefix: `/app` matches `/app` and `/app/x`, not
 * `/application`. A base path of `/` matches everything on the origin.
 */
export function isSameApp(url: URL, base: URL): boolean {
  if (url.origin !== base.origin) return false;

  const basePath = base.pathname.replace(/\/+$/, '');
  if (basePath === '') return true;
  return url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
}

export function routeKey(url: URL): string {
  return url.pathname + url.search;
}

/**
 * The part of a same-app URL's path that belongs to the app: the path below the base URL's path,
 * `/` for the app's root; no query. `url` must be in the app (`isSameApp`).
 */
export function appRelativePath(url: URL, base: URL): string {
  const basePath = base.pathname.replace(/\/+$/, '');
  const path = url.pathname.slice(basePath.length);
  return path === '' ? '/' : path;
}

/**
 * Resolves a crawl seed against the app, normalised like every other crawl URL. Seeds are
 * app-relative: a leading `/` means the app's root, so the base URL's path is kept (`/orgs` under
 * `http://host/sub/` is `http://host/sub/orgs`); with a base URL at the origin's root nothing
 * changes. An absolute URL is used as is, and the crawl still checks that it is in the app.
 * `null` for an href that cannot be navigated.
 */
export function resolveSeed(seed: string, baseUrl: URL): URL | null {
  const appRoot = new URL(baseUrl.href);
  appRoot.pathname = appRoot.pathname.endsWith('/') ? appRoot.pathname : `${appRoot.pathname}/`;
  return normaliseUrl(seed.trim().replace(/^\//, ''), appRoot);
}
