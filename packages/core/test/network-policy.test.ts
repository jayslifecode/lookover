import { describe, expect, test } from 'vitest';
import {
  BLOCKED_PROVIDERS,
  classifyRequest,
  hostResolverRules,
  isAllowedHost,
  isBlockedProvider,
  LOCAL_HOSTS,
  launchArgs,
  type RequestKind,
  type Verdict,
} from '../src/browser/network-policy.js';

describe('isAllowedHost', () => {
  test.each<[string, string, string[], boolean]>([
    ['localhost', 'localhost', [], true],
    ['the IPv4 loopback', '127.0.0.1', [], true],
    ['the IPv6 loopback', '::1', [], true],
    ['the IPv6 loopback in URL brackets', '[::1]', [], true],
    ['a .local name', 'app.local', [], true],
    ['a nested .local name', 'a.b.local', [], true],
    ['the bare word local', 'local', [], false],
    ['a .localhost name', 'app.localhost', [], true],
    ['a nested .localhost name with a trailing dot', 'a.b.localhost.', [], true],
    ['a name that only ends with the letters localhost', 'notlocalhost', [], false],
    ['an outside host', 'api.example.com', [], false],
    ['a reserved .test name', 'foreign.test', [], false],
    ['an upper-case local host', 'LOCALHOST', [], true],
    ['a local host with a trailing dot', 'localhost.', [], true],
    ['a subdomain of a glob entry', 'x.ngrok.app', ['*.ngrok.app'], true],
    ['a deeper subdomain of a glob entry', 'a.b.ngrok.app', ['*.ngrok.app'], true],
    ['the apex of a glob entry', 'ngrok.app', ['*.ngrok.app'], false],
    ['an exact entry', 'api.example.com', ['api.example.com'], true],
    ['a subdomain of an exact entry', 'v2.api.example.com', ['api.example.com'], false],
    ['an entry written in upper case with a trailing dot', 'api.example.com', ['API.Example.com.'], true],
  ])('%s (%s, allowHosts %j) → %s', (_name, host, allowHosts, expected) => {
    expect(isAllowedHost(host, allowHosts)).toBe(expected);
  });

  test('allows every LOCAL_HOSTS entry', () => {
    expect(LOCAL_HOSTS).toEqual(['localhost', '127.0.0.1', '::1']);
    for (const host of LOCAL_HOSTS) {
      expect(isAllowedHost(host, [])).toBe(true);
    }
  });
});

describe('isBlockedProvider', () => {
  test.each([
    ['payments', 'api.stripe.com'],
    ['payments', 'www.paypal.com'],
    ['payments', 'api.braintreegateway.com'],
    ['payments', 'checkout-test.adyen.com'],
    ['payments', 'api.checkout.com'],
    ['payments', 'api.tosspayments.com'],
    ['payments', 'kapi.kakaopay.com'],
    ['payments', 'api.iamport.kr'],
    ['payments', 'api.portone.io'],
    ['payments', 'merchant.qpay.mn'],
    ['payments', 'ecommerce.socialpay.mn'],
    ['email', 'smtp.sendgrid.net'],
    ['email', 'api.sendgrid.com'],
    ['email', 'api.mailgun.net'],
    ['email', 'api.postmarkapp.com'],
    ['email', 'api.resend.com'],
    ['email', 'api.sparkpostmail.com'],
    ['email', 'mandrillapp.com'],
    ['email', 'email.us-east-1.amazonaws.com'],
    ['email', 'email.eu-west-1.amazonaws.com'],
    ['sms', 'api.twilio.com'],
    ['sms', 'rest.nexmo.com'],
    ['sms', 'api.nexmo.com'],
    ['sms', 'api.vonage.com'],
    ['sms', 'rest.messagebird.com'],
    ['sms', 'sns.ap-northeast-2.amazonaws.com'],
    ['sms', 'sens.apigw.ntruss.com'],
    ['sms', 'api.coolsms.co.kr'],
    ['sms', 'apis.aligo.in'],
    ['sms', 'api.solapi.com'],
  ])('blocks the %s provider host %s', (_category, host) => {
    expect(isBlockedProvider(host)).toBe(true);
  });

  test.each([
    ['a listed suffix itself', 'stripe.com', true],
    ['a listed suffix in upper case', 'API.STRIPE.COM', true],
    ['a listed suffix with a trailing dot', 'api.stripe.com.', true],
    ['a backend that is not a provider', 'xyz.supabase.co', false],
    ['a host that only ends with the same letters', 'notstripe.com', false],
    ['a host that contains a provider as a subdomain', 'stripe.com.evil.example', false],
    ['an SES-shaped host without a region label', 'email.amazonaws.com', false],
    ['another AWS service', 's3.us-east-1.amazonaws.com', false],
    ['the apex above a listed host (api.sendgrid.com)', 'sendgrid.com', false],
  ])('%s: %s → %s', (_name, host, expected) => {
    expect(isBlockedProvider(host)).toBe(expected);
  });

  test('blocks every listed entry and its subdomains', () => {
    for (const entry of BLOCKED_PROVIDERS) {
      const host = entry.replaceAll('*', 'us-east-1');

      expect(isBlockedProvider(host)).toBe(true);
      expect(isBlockedProvider(`sub.${host}`)).toBe(true);
    }
  });
});

describe('classifyRequest', () => {
  const none = { allowHosts: [] };

  test.each<[string, string, RequestKind, { allowHosts: string[] }, Verdict]>([
    [
      'a navigation to another host',
      'https://example.com',
      'navigation',
      none,
      { kind: 'block', reason: 'host-not-allowed' },
    ],
    [
      'a fetch to a payment provider',
      'https://api.stripe.com/v1/charges',
      'fetch',
      none,
      { kind: 'block', reason: 'provider' },
    ],
    [
      'a fetch to a hosted backend',
      'https://xyz.supabase.co/rest/v1/orgs',
      'fetch',
      none,
      { kind: 'observe', host: 'xyz.supabase.co' },
    ],
    ['a fetch to the local app', 'http://localhost:3000/api', 'fetch', none, { kind: 'allow' }],
    [
      'a fetch to a provider that is allowlisted',
      'https://api.stripe.com',
      'fetch',
      { allowHosts: ['api.stripe.com'] },
      { kind: 'allow' },
    ],
    [
      'a navigation to a provider that is not allowlisted',
      'https://checkout.stripe.com/pay',
      'navigation',
      none,
      { kind: 'block', reason: 'provider' },
    ],
    [
      'a subresource from another host',
      'https://fonts.example.net/inter.woff2',
      'subresource',
      none,
      { kind: 'observe', host: 'fonts.example.net' },
    ],
    [
      'a subresource from a provider',
      'https://js.stripe.com/v3',
      'subresource',
      none,
      { kind: 'block', reason: 'provider' },
    ],
    ['a navigation to the local app', 'http://localhost:3000/orgs', 'navigation', none, { kind: 'allow' }],
    ['a navigation to the IPv6 loopback', 'http://[::1]:3000/', 'navigation', none, { kind: 'allow' }],
    [
      'a provider written with a trailing dot',
      'https://api.stripe.com./v1/charges',
      'fetch',
      none,
      { kind: 'block', reason: 'provider' },
    ],
    [
      'a provider written in upper case',
      'https://API.Stripe.COM/v1/charges',
      'fetch',
      none,
      { kind: 'block', reason: 'provider' },
    ],
    [
      'a hosted backend written in upper case with a trailing dot',
      'https://XYZ.Supabase.co./rest/v1',
      'fetch',
      none,
      { kind: 'observe', host: 'xyz.supabase.co' },
    ],
    [
      'a navigation to a glob-allowlisted host',
      'https://x.ngrok.app/',
      'navigation',
      { allowHosts: ['*.ngrok.app'] },
      { kind: 'allow' },
    ],
    [
      'a websocket to the local app',
      'ws://localhost:3000/_next/webpack-hmr',
      'fetch',
      none,
      { kind: 'allow' },
    ],
    [
      'a websocket to an SMS provider',
      'wss://api.twilio.com/x',
      'fetch',
      none,
      { kind: 'block', reason: 'provider' },
    ],
    [
      'a websocket to a hosted backend',
      'wss://xyz.supabase.co/realtime/v1',
      'fetch',
      none,
      { kind: 'observe', host: 'xyz.supabase.co' },
    ],
    ['a data URL', 'data:text/plain,hi', 'subresource', none, { kind: 'allow' }],
    ['a blob URL', 'blob:http://localhost:3000/0f8fad5b', 'fetch', none, { kind: 'allow' }],
    ['about:blank', 'about:blank', 'navigation', none, { kind: 'allow' }],
    ['the Chromium error page', 'chrome-error://chromewebdata/', 'navigation', none, { kind: 'allow' }],
  ])('%s', (_name, href, kind, policy, expected) => {
    expect(classifyRequest(new URL(href), kind, policy)).toEqual(expected);
  });
});

describe('hostResolverRules', () => {
  function rulesOf(allowHosts: string[]): string[] {
    return hostResolverRules(allowHosts).split(', ');
  }

  test('maps every provider suffix to NOTFOUND, bare and wildcarded', () => {
    const rules = rulesOf([]);

    for (const entry of BLOCKED_PROVIDERS) {
      expect(rules).toContain(`MAP ${entry} ~NOTFOUND`);
      expect(rules).toContain(`MAP *.${entry} ~NOTFOUND`);
    }
    expect(rules).toContain('MAP stripe.com ~NOTFOUND');
    expect(rules).toContain('MAP *.stripe.com ~NOTFOUND');
    expect(rules).toContain('MAP email.*.amazonaws.com ~NOTFOUND');
    expect(rules).toContain('MAP sns.*.amazonaws.com ~NOTFOUND');
  });

  test('also maps every provider pattern with a trailing dot, which Chromium resolves literally', () => {
    const rules = rulesOf([]);

    for (const entry of BLOCKED_PROVIDERS) {
      expect(rules).toContain(`MAP ${entry}. ~NOTFOUND`);
      expect(rules).toContain(`MAP *.${entry}. ~NOTFOUND`);
    }
    expect(rules).toContain('MAP stripe.com. ~NOTFOUND');
    expect(rules).toContain('MAP *.stripe.com. ~NOTFOUND');
    expect(rules).toContain('MAP email.*.amazonaws.com. ~NOTFOUND');
  });

  test('has no exclusions without allowHosts', () => {
    expect(rulesOf([]).filter((rule) => rule.startsWith('EXCLUDE'))).toEqual([]);
  });

  test('excludes an allowlisted provider host, with and without a trailing dot', () => {
    const rules = rulesOf(['api.stripe.com']);

    expect(rules).toContain('EXCLUDE api.stripe.com');
    expect(rules).toContain('EXCLUDE api.stripe.com.');
  });

  test('excludes allowlisted globs and normalises entries', () => {
    const rules = rulesOf(['*.stripe.com', 'API.Twilio.com.']);

    expect(rules).toContain('EXCLUDE *.stripe.com');
    expect(rules).toContain('EXCLUDE *.stripe.com.');
    expect(rules).toContain('EXCLUDE api.twilio.com');
    expect(rules).toContain('EXCLUDE api.twilio.com.');
  });

  test('drops entries that are not host names, so they cannot inject rules', () => {
    const rules = rulesOf(['evil.example, EXCLUDE *', 'https://x.example', 'x.example:3000', '*', '']);

    expect(rules.filter((rule) => rule.startsWith('EXCLUDE'))).toEqual([]);
  });

  test('every rule is a NOTFOUND mapping or an exclusion', () => {
    for (const rule of rulesOf(['api.stripe.com', '*.ngrok.app'])) {
      expect(rule).toMatch(/^(MAP \S+ ~NOTFOUND|EXCLUDE \S+)$/);
    }
  });
});

describe('launchArgs', () => {
  const RESOLVER_RULES_ARG = '--host-resolver-rules=';

  function resolverRulesOf(args: string[]): string[] {
    const rulesArgs = args.filter((arg) => arg.startsWith(RESOLVER_RULES_ARG));
    expect(rulesArgs).toHaveLength(1);
    return (rulesArgs[0] ?? '').slice(RESOLVER_RULES_ARG.length).split(', ');
  }

  test('turns the proxy off, so the browser resolves every name itself', () => {
    expect(launchArgs([])).toContain('--no-proxy-server');
  });

  test('passes the host-resolver rules for the allowlist', () => {
    const args = launchArgs(['api.stripe.com']);

    expect(args).toEqual([
      '--no-proxy-server',
      `${RESOLVER_RULES_ARG}${hostResolverRules(['api.stripe.com'])}`,
    ]);
  });

  test('adds test-only blocked hosts as provider-style rules', () => {
    const rules = resolverRulesOf(launchArgs([], { blockedHosts: ['blocked.localhost'] }));

    expect(rules).toEqual(
      expect.arrayContaining([
        'MAP blocked.localhost ~NOTFOUND',
        'MAP blocked.localhost. ~NOTFOUND',
        'MAP *.blocked.localhost ~NOTFOUND',
        'MAP *.blocked.localhost. ~NOTFOUND',
        'MAP stripe.com ~NOTFOUND',
      ]),
    );
  });

  test('maps test-only loopback hosts to 127.0.0.1', () => {
    const rules = resolverRulesOf(launchArgs([], { loopbackHosts: ['foreign.test'] }));

    expect(rules).toContain('MAP foreign.test 127.0.0.1');
  });

  test('drops test-only entries that are not host names', () => {
    const rules = resolverRulesOf(
      launchArgs([], { blockedHosts: ['x, EXCLUDE *'], loopbackHosts: ['y.test 10.0.0.1, MAP *'] }),
    );

    for (const rule of rules) {
      expect(rule).toMatch(/^MAP \S+ ~NOTFOUND$/);
    }
    expect(rules.some((rule) => rule.includes('y.test'))).toBe(false);
  });
});
