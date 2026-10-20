/**
 * The network half of the safety envelope.
 *
 * - The explorer navigates only to allowed hosts: `LOCAL_HOSTS`, any `*.local` name, and the
 *   user's `allowHosts` (exact names or `*.suffix` globs).
 * - The app's own calls (fetch, XHR, websockets, subresources) to other hosts go through but are
 *   observed, so the user can confirm each backend is a development or disposable instance.
 * - Payment, email and SMS providers (`BLOCKED_PROVIDERS`) are blocked for every kind of request
 *   unless the host is in `allowHosts`. `hostResolverRules` repeats that block at DNS level for
 *   the browser, which also covers requests the route handler never sees (redirect hops).
 *
 * Known gap: a redirect from an allowed host to a non-provider, non-allowed host is not blocked in
 * a fetch or subresource, only recorded as an observed host; a main-frame navigation that lands on
 * such a host is contained after the fact. Blocking the hop itself needs response-level
 * interception and is deferred.
 */

export type RequestKind = 'navigation' | 'fetch' | 'subresource';

export type Verdict =
  | { kind: 'allow' }
  | { kind: 'observe'; host: string }
  | { kind: 'block'; reason: 'provider' | 'host-not-allowed' };

export interface NetworkPolicy {
  allowHosts: readonly string[];
}

export const LOCAL_HOSTS: readonly string[] = Object.freeze(['localhost', '127.0.0.1', '::1']);

/** Host suffixes; an entry containing `*` is a pattern where `*` stands for one or more labels. */
export const BLOCKED_PROVIDERS: readonly string[] = Object.freeze([
  // Payments
  'stripe.com',
  'paypal.com',
  'braintreegateway.com',
  'adyen.com',
  'checkout.com',
  'tosspayments.com',
  'kakaopay.com',
  'iamport.kr',
  'portone.io',
  'qpay.mn',
  'socialpay.mn',
  // Email
  'sendgrid.net',
  'api.sendgrid.com',
  'mailgun.net',
  'postmarkapp.com',
  'resend.com',
  'sparkpostmail.com',
  'mandrillapp.com',
  'email.us-east-1.amazonaws.com',
  'email.*.amazonaws.com',
  // SMS
  'twilio.com',
  'nexmo.com',
  'vonage.com',
  'messagebird.com',
  'sns.*.amazonaws.com',
  'sens.apigw.ntruss.com',
  'coolsms.co.kr',
  'apis.aligo.in',
  'solapi.com',
]);

const LOCAL_SUFFIX = 'local';
const GLOB_PREFIX = '*.';
/** Requests on other schemes (data:, blob:, about:, chrome-error:) never reach a host. */
const NETWORK_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:']);
/** A DNS name or IPv4 address, optionally as a `*.` glob; anything else could corrupt the rule list. */
const RESOLVER_PATTERN = /^(?:\*\.)?[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;
const RESOLVER_BLOCK_TARGET = '~NOTFOUND';
const RULE_SEPARATOR = ', ';

type HostMatcher = (host: string) => boolean;

const PROVIDER_MATCHERS: readonly HostMatcher[] = BLOCKED_PROVIDERS.map(providerMatcher);

/** Lower-cased, without IPv6 brackets or trailing dots, so every spelling of a host compares equal. */
export function normaliseHost(host: string): string {
  const lower = host.trim().toLowerCase().replace(/\.+$/, '');
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

/** The normalised host of a request URL, or `null` for schemes that do not reach a host. */
export function networkHost(url: URL): string | null {
  if (!NETWORK_PROTOCOLS.has(url.protocol)) {
    return null;
  }
  const host = normaliseHost(url.hostname);
  return host === '' ? null : host;
}

export function isAllowedHost(host: string, allowHosts: readonly string[]): boolean {
  const normalised = normaliseHost(host);
  if (LOCAL_HOSTS.includes(normalised) || isSubdomainOf(normalised, LOCAL_SUFFIX)) {
    return true;
  }
  return allowHosts.some((entry) => matchesAllowEntry(normalised, normaliseHost(entry)));
}

export function isBlockedProvider(host: string): boolean {
  const normalised = normaliseHost(host);
  return PROVIDER_MATCHERS.some((matches) => matches(normalised));
}

export function classifyRequest(url: URL, kind: RequestKind, policy: NetworkPolicy): Verdict {
  const host = networkHost(url);
  if (host === null || isAllowedHost(host, policy.allowHosts)) {
    return { kind: 'allow' };
  }
  if (isBlockedProvider(host)) {
    return { kind: 'block', reason: 'provider' };
  }
  if (kind === 'navigation') {
    return { kind: 'block', reason: 'host-not-allowed' };
  }
  return { kind: 'observe', host };
}

/**
 * Chromium `--host-resolver-rules` that make every provider unresolvable, bare and wildcarded,
 * except hosts the user allowlisted. Every well-formed `allowHosts` entry is excluded, not only
 * provider entries, so DNS agrees with `classifyRequest` exactly (an exclusion of a host that no
 * rule maps is a no-op). Entries that are not host names are dropped so they cannot inject rules.
 */
export function hostResolverRules(allowHosts: readonly string[]): string {
  const exclusions = allowHosts
    .map(normaliseHost)
    .filter((entry) => RESOLVER_PATTERN.test(entry))
    .map((entry) => `EXCLUDE ${entry}`);
  const blocks = BLOCKED_PROVIDERS.flatMap((entry) => [
    `MAP ${entry} ${RESOLVER_BLOCK_TARGET}`,
    `MAP ${GLOB_PREFIX}${entry} ${RESOLVER_BLOCK_TARGET}`,
  ]);
  return [...new Set([...exclusions, ...blocks])].join(RULE_SEPARATOR);
}

function matchesAllowEntry(host: string, entry: string): boolean {
  return entry.startsWith(GLOB_PREFIX)
    ? isSubdomainOf(host, entry.slice(GLOB_PREFIX.length))
    : host === entry;
}

function isSubdomainOf(host: string, suffix: string): boolean {
  return suffix !== '' && host.endsWith(`.${suffix}`) && host.length > suffix.length + 1;
}

function providerMatcher(entry: string): HostMatcher {
  if (!entry.includes('*')) {
    return (host) => host === entry || host.endsWith(`.${entry}`);
  }
  const body = entry.split('*').map(escapeRegExp).join('[^.]+(?:\\.[^.]+)*');
  const pattern = new RegExp(`^(?:[^.]+\\.)*${body}$`);
  return (host) => pattern.test(host);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
