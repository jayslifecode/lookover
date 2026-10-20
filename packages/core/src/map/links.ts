/**
 * Links discovery never follows: logging out or deleting something would change what the rest of
 * the crawl sees. Tested against a URL's app-relative path (below the base URL's path) and its
 * query, so a base path such as `/reset/` does not make every URL look destructive.
 */
export const DESTRUCTIVE_LINK_PATTERN =
  /(^|\/)(logout|log-out|log_out|logoff|signout|sign-out|sign_out|delete|remove|destroy|reset)(\/|$|\?)|[?&](action|op)=(delete|remove|destroy)/i;

/**
 * True when following `url` could end the session or change data: `DESTRUCTIVE_LINK_PATTERN`
 * tested against the part of `url` that belongs to the app. `url` must be in the app (`isSameApp`).
 */
export function isDestructiveLink(url: URL, base: URL): boolean {
  return DESTRUCTIVE_LINK_PATTERN.test(appRelativeKey(url, base));
}

/**
 * The part of a same-app URL that belongs to the app: its path below the base URL's path (`/` for
 * the app's root), then its query.
 */
function appRelativeKey(url: URL, base: URL): string {
  const basePath = base.pathname.replace(/\/+$/, '');
  const path = url.pathname.slice(basePath.length);
  return `${path === '' ? '/' : path}${url.search}`;
}
