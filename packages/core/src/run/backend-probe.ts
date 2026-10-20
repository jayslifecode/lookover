import { isLoginUrl } from '../browser/auth.js';
import { isAllowedHost, normaliseHost } from '../browser/network-policy.js';
import type { BrowserSession } from '../browser/session.js';
import type { LookoverConfig } from '../config/schema.js';
import { LookoverError } from '../errors.js';
import { DESTRUCTIVE_LINK_PATTERN, resolveSeed } from '../map/crawler.js';
import { staticRoutePatterns } from '../map/next-routes.js';
import type { RouteInfo } from '../map/types.js';

/** Asked about the backend hosts that need confirming; returns the ones the user confirms. */
export type ConfirmHosts = (hosts: string[]) => Promise<string[]>;

const ROOT_SEED = '/';
const PROBE_NAVIGATION_TIMEOUT_MS = 15_000;
const PROBE_SETTLE_MS = 800;
const HOST_LIST_INDENT = '  ';

/**
 * The probe: opens the base URL and one more page (see `probeUrls`) so the app makes its usual backend
 * calls, then asks `confirmHosts` about every host it called that is neither allowed nor already
 * confirmed in the config. Throws `E_HOSTS_UNCONFIRMED` naming the hosts left unconfirmed, or all of
 * them without a hook. Returns the config's confirmed hosts plus the ones confirmed now, deduplicated.
 */
export async function confirmBackends(
  session: BrowserSession,
  config: LookoverConfig,
  routes: readonly RouteInfo[],
  confirmHosts: ConfirmHosts | undefined,
): Promise<string[]> {
  await probe(session, probeUrls(config, routes));
  const known = new Set(config.confirmedBackendHosts.map(normaliseHost));
  const pending = session
    .observedHosts()
    .filter((host) => !isAllowedHost(host, config.allowHosts) && !known.has(host));
  const confirmed = pending.length === 0 ? [] : await askToConfirm(pending, confirmHosts);
  return uniqueHosts([...config.confirmedBackendHosts, ...confirmed]);
}

/** Returns `pending` once every host in it is confirmed; any other answer confirms nothing. */
async function askToConfirm(
  pending: readonly string[],
  confirmHosts: ConfirmHosts | undefined,
): Promise<string[]> {
  if (confirmHosts === undefined) {
    throw unconfirmedHosts(pending);
  }
  const answers = new Set((await confirmHosts([...pending])).map(normaliseHost));
  const unconfirmed = pending.filter((host) => !answers.has(host));
  if (unconfirmed.length > 0) {
    throw unconfirmedHosts(unconfirmed);
  }
  return [...pending];
}

/**
 * The base URL, then the first static filesystem route that is another page: not the base URL itself,
 * not the login page, and not a destructive link (the crawl never opens one either).
 */
function probeUrls(config: LookoverConfig, routes: readonly RouteInfo[]): string[] {
  const base = new URL(config.baseUrl);
  const root = resolveSeed(ROOT_SEED, base)?.href;
  const second = staticRoutePatterns(routes)
    .filter((pattern) => !DESTRUCTIVE_LINK_PATTERN.test(pattern))
    .flatMap((pattern) => resolveSeed(pattern, base) ?? [])
    .find((url) => url.href !== root && !isLoginUrl(url, config.auth, config.baseUrl));
  return second === undefined ? [config.baseUrl] : [config.baseUrl, second.href];
}

/**
 * Opens each URL in one short-lived page. Best effort: a navigation that fails is not retried, because
 * whatever the page requested is observed whether or not it finished loading.
 */
async function probe(session: BrowserSession, urls: readonly string[]): Promise<void> {
  const { page, close } = await session.newPage();
  try {
    for (const url of urls) {
      await page
        .goto(url, { waitUntil: 'load', timeout: PROBE_NAVIGATION_TIMEOUT_MS })
        .catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: PROBE_SETTLE_MS }).catch(() => undefined);
    }
  } finally {
    await close();
  }
}

/** Deduplicated as the network policy compares hosts; the first spelling of each is kept. */
function uniqueHosts(hosts: readonly string[]): string[] {
  const keys = hosts.map(normaliseHost);
  return hosts.filter((_host, index) => keys.indexOf(keys[index] ?? '') === index);
}

function unconfirmedHosts(hosts: readonly string[]): LookoverError {
  const lines = [
    'The app called these backends, and none of them is confirmed as a development or disposable instance:',
    ...hosts.map((host) => `${HOST_LIST_INDENT}${host}`),
  ];
  const commands = hosts.map((host) => `lookover run --confirm-host ${host}`).join(', ');
  return new LookoverError(
    'E_HOSTS_UNCONFIRMED',
    lines.join('\n'),
    `For each one that is a development or disposable backend, run again with its flag (${commands}), or add it to confirmedBackendHosts`,
  );
}
