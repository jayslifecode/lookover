/**
 * The network half of the safety envelope.
 *
 * - The explorer navigates only to allowed hosts: `LOCAL_HOSTS`, any `*.local` or `*.localhost`
 *   name (`*.localhost` always resolves to loopback, RFC 6761), and the user's `allowHosts` (exact
 *   names or `*.suffix` globs).
 * - The app's own calls (fetch, XHR, websockets, subresources) to other hosts go through but are
 *   observed, so the user can confirm each backend is a development or disposable instance. Once
 *   the policy holds the confirmed hosts (`confirmedHosts`), a call to any other such host is blocked
 *   as `unconfirmed-backend` instead.
 * - Payment, email and SMS providers (`BLOCKED_PROVIDERS`) are blocked for every kind of request
 *   unless the host is in `allowHosts`. `launchArgs` repeats that block at DNS level for the
 *   browser (`hostResolverRules`, with the proxy disabled so the browser resolves every name
 *   itself), which also covers requests the route handler never sees (redirect hops).
 *
 * Known gap: a redirect from an allowed host to a non-provider, non-allowed host is not blocked in
 * a fetch or subresource, confirmed or not (only recorded as an observed host); a frame that lands
 * on such a host is contained after the fact (sent to `about:blank`), so its request has already
 * gone out. Blocking the hop itself needs response-level interception and is deferred.
 */

export type RequestKind = 'navigation' | 'fetch' | 'subresource';

export type Verdict =
  | { kind: 'allow' }
  | { kind: 'observe'; host: string }
  | { kind: 'block'; reason: 'provider' | 'host-not-allowed' | 'unconfirmed-backend' };

export interface NetworkPolicy {
  allowHosts: readonly string[];
  /**
   * The backends the user confirmed as development or disposable instances. While it is absent every
   * call to a host that is neither allowed nor a provider is observed; once set, such a call is let
   * through only to these hosts and blocked as `unconfirmed-backend` everywhere else.
   */
  confirmedHosts?: readonly string[];
}

/** Test-only resolver overrides for `launchArgs`; never set from configuration. */
export interface ResolverTestHooks {
  /** Extra suffixes made unresolvable like providers, at DNS level only (not by `classifyRequest`). */
  blockedHosts?: readonly string[];
  /** Host names resolved to the IPv4 loopback, so a fixture server can stand in for another host. */
  loopbackHosts?: readonly string[];
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

/** Every subdomain of these is local; the bare words are not host names anyone serves on. */
const LOCAL_SUFFIXES: readonly string[] = Object.freeze(['local', 'localhost']);
const GLOB_PREFIX = '*.';
/** Requests on other schemes (data:, blob:, about:, chrome-error:) never reach a host. */
const NETWORK_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:']);
/** A DNS name or IPv4 address, optionally as a `*.` glob; anything else could corrupt the rule list. */
const RESOLVER_PATTERN = /^(?:\*\.)?[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;
const RESOLVER_BLOCK_TARGET = '~NOTFOUND';
const LOOPBACK_ADDRESS = '127.0.0.1';
const RULE_SEPARATOR = ', ';
/** Chromium keeps a trailing dot in the host it resolves, and its rule patterns match it literally. */
const FQDN_DOT = '.';
/** Without it a system or PAC proxy would resolve names itself and the DNS rules would not apply. */
const NO_PROXY_ARG = '--no-proxy-server';
const RESOLVER_RULES_ARG = '--host-resolver-rules=';

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
  if (
    LOCAL_HOSTS.includes(normalised) ||
    LOCAL_SUFFIXES.some((suffix) => isSubdomainOf(normalised, suffix))
  ) {
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
  if (isUnconfirmedBackend(host, policy)) {
    return { kind: 'block', reason: 'unconfirmed-backend' };
  }
  return { kind: 'observe', host };
}

/** True once the policy holds the confirmed hosts and `host` (normalised) is not one of them. */
function isUnconfirmedBackend(host: string, policy: NetworkPolicy): boolean {
  const confirmed = policy.confirmedHosts;
  return confirmed !== undefined && !confirmed.some((entry) => normaliseHost(entry) === host);
}

/** Chromium `--host-resolver-rules` that make every provider unresolvable except allowlisted hosts. */
export function hostResolverRules(allowHosts: readonly string[]): string {
  return resolverRules(BLOCKED_PROVIDERS, allowHosts);
}

/** The Chromium arguments that put the DNS half of the envelope in place. */
export function launchArgs(allowHosts: readonly string[], testHooks: ResolverTestHooks = {}): string[] {
  const blocked = [...BLOCKED_PROVIDERS, ...resolverPatterns(testHooks.blockedHosts ?? [])];
  const loopback = resolverPatterns(testHooks.loopbackHosts ?? []).map(
    (host) => `MAP ${host} ${LOOPBACK_ADDRESS}`,
  );
  const rules = [resolverRules(blocked, allowHosts), ...loopback].join(RULE_SEPARATOR);
  return [NO_PROXY_ARG, `${RESOLVER_RULES_ARG}${rules}`];
}

/**
 * Every provider bare and wildcarded, each with and without a trailing dot, mapped to NOTFOUND.
 * Every well-formed `allowHosts` entry is excluded (with and without the dot), not only provider
 * entries, so DNS agrees with `classifyRequest` exactly; an exclusion no rule maps is a no-op.
 * Entries that are not host names are dropped so they cannot inject rules.
 */
function resolverRules(providers: readonly string[], allowHosts: readonly string[]): string {
  const exclusions = resolverPatterns(allowHosts).flatMap((entry) => withFqdnDot(entry).map(exclude));
  const blocks = providers
    .flatMap((entry) => [entry, `${GLOB_PREFIX}${entry}`])
    .flatMap(withFqdnDot)
    .map((pattern) => `MAP ${pattern} ${RESOLVER_BLOCK_TARGET}`);
  return [...new Set([...exclusions, ...blocks])].join(RULE_SEPARATOR);
}

function resolverPatterns(entries: readonly string[]): string[] {
  return entries.map(normaliseHost).filter((entry) => RESOLVER_PATTERN.test(entry));
}

function withFqdnDot(pattern: string): string[] {
  return [pattern, `${pattern}${FQDN_DOT}`];
}

function exclude(pattern: string): string {
  return `EXCLUDE ${pattern}`;
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
