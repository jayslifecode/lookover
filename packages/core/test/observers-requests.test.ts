import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type FixtureRoute,
  type FixtureServer,
  redirect,
  serveFixture,
} from '@jayslifecode/lookover-test-support';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { BrowserSession, type InstrumentedPage } from '../src/browser/session.js';
import { configSchema } from '../src/config/schema.js';
import { mergeFindings } from '../src/findings/id.js';
import type { Finding, OccurrenceFinding } from '../src/findings/types.js';
import type { Screen, Viewport } from '../src/map/types.js';
import {
  MAX_REQUEST_URL_LENGTH,
  MAX_REQUESTS_PER_SCREEN,
  RequestObserver,
} from '../src/observers/requests.js';
import type { ObserverResult } from '../src/observers/types.js';
import { createRun, type RunContext } from '../src/run/run-context.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/observers', import.meta.url));
const BROWSER_TIMEOUT_MS = 30_000;
const VIEWPORT: Viewport = { name: 'desktop', width: 1280, height: 800 };
const NOTHING_SEEN = { findings: [], worthALook: [], evidence: [] };
const REFUSED = 'net::ERR_CONNECTION_REFUSED';
const BLOCKED = /^net::ERR_BLOCKED_BY_CLIENT/;
const ABORTED = 'net::ERR_ABORTED';
const CHECKOUT = 'https://checkout.stripe.com/pay';
const CUT_OFF_DELAY_MS = 150;
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIz';

interface StoredEntry {
  method: string;
  url: string;
  status: number | null;
  resourceType: string;
  failure: string | null;
  durationMs: number | null;
}

interface StoredRequests {
  screenId: string;
  dropped: number;
  entries: StoredEntry[];
}

function asOccurrence(finding: Finding | undefined): OccurrenceFinding {
  if (finding?.shape !== 'occurrence') throw new Error('expected an occurrence finding');
  return finding;
}

function ruleIds(findings: readonly Finding[]): string[] {
  return findings.map((finding) => finding.rule.id).toSorted();
}

function answer(status: number): FixtureRoute {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end('{}');
  };
}

/** A page that answers with an error itself, with a body, as an app's error page does. */
function brokenPage(status: number): FixtureRoute {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Oops</title><main>Something went wrong</main>');
  };
}

/** The status line, the headers and the start of a page, then the connection drops while the body is still coming. */
const cutOffPage: FixtureRoute = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.write('<!doctype html><title>Partial</title><main>Partial');
  // Long enough for the browser to commit the page first, as it does when the first bytes arrive.
  setTimeout(() => res.destroy(), CUT_OFF_DELAY_MS);
};

/** A loopback port that nothing listens on: one that was just free. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

describe('RequestObserver', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let session: BrowserSession;
  let workDir: string;
  let deadPort: number;
  let ctx: RunContext;
  let ipage: InstrumentedPage;
  let observer: RequestObserver;

  const url = (path: string): string => `${fixture.url}${path}`;
  const host = (): string => new URL(fixture.url).host;

  function screenAt(id: string, path: string): Screen {
    return {
      id,
      url: url(path),
      route: path.split('?')[0] ?? path,
      title: 'Fixture',
      status: 'captured',
      error: null,
      viewport: VIEWPORT,
      screenshot: null,
      elements: [],
      forms: [],
      tokens: [],
      links: [],
      redirectedFrom: null,
      discoveredFrom: null,
      capturedAt: '2026-10-21T12:00:00.000Z',
    };
  }

  /** Loads `path` and waits until the page's requests have all been answered, and the observer told. */
  async function open(path: string): Promise<void> {
    await ipage.page.goto(url(path), { waitUntil: 'networkidle' });
  }

  async function settleNetwork(): Promise<void> {
    await ipage.page.waitForLoadState('networkidle');
  }

  async function storedEvidence(result: ObserverResult): Promise<StoredRequests> {
    const [item] = result.evidence;
    if (item === undefined) throw new Error('expected a piece of evidence');
    return JSON.parse(await readFile(ctx.evidence.resolve(item.ref), 'utf8')) as StoredRequests;
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lookover-observers-requests-'));
    deadPort = await closedPort();
    fixture = await serveFixture(FIXTURE_DIR, {
      '/api/ok': answer(200),
      '/api/boom': answer(500),
      '/api/items/:id': answer(500),
      '/broken.html': brokenPage(500),
      '/gone.html': brokenPage(404),
      '/old': (_req, res) => redirect(res, '/broken.html'),
      '/partial.html': cutOffPage,
      // Never answered: the page that asks for it cancels the request first.
      '/api/slow': () => undefined,
    });
    session = await BrowserSession.launch({ viewport: VIEWPORT, allowHosts: [], onEvent: () => {} });
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await session.close();
    await fixture.close();
    await rm(workDir, { recursive: true, force: true });
  }, BROWSER_TIMEOUT_MS);

  beforeEach(async () => {
    const cwd = await mkdtemp(join(workDir, 'run-'));
    ctx = await createRun({ cwd, config: configSchema.parse({ baseUrl: fixture.url, interaction: 'safe' }) });
    ipage = await session.newPage();
    observer = new RequestObserver(ctx);
    observer.attach(ipage);
  });

  afterEach(async () => {
    await ipage.close();
  });

  test('is the requests observer', () => {
    expect(observer.name).toBe('requests');
  });

  test('4xx and 5xx answers and a connection failure are candidates; 200, favicon and Lookover-blocked requests are not', async () => {
    await open(`/requests.html?dead=${deadPort}`);

    const result = await observer.collect(screenAt('screen-1', `/requests.html?dead=${deadPort}`));

    expect(ruleIds(result.findings)).toEqual([
      'observers.request-client-error',
      'observers.request-network-error',
      'observers.request-server-error',
    ]);
    expect(result.worthALook).toEqual([]);
    const byRule = Object.fromEntries(
      result.findings.map((finding) => [finding.rule.id, asOccurrence(finding)]),
    );
    const client = byRule['observers.request-client-error'];
    const server = byRule['observers.request-server-error'];
    const network = byRule['observers.request-network-error'];
    expect(client).toMatchObject({
      source: 'observers',
      status: 'candidate',
      judgement: null,
      severity: 'medium',
      key: `GET ${host()}/api/missing → 404`,
      observed: 'GET /api/missing answered 404',
    });
    expect(client?.occurrences).toEqual([
      {
        screenId: 'screen-1',
        route: '/requests.html',
        url: url(`/requests.html?dead=${deadPort}`),
        viewport: VIEWPORT,
        selector: null,
        measured: {
          method: 'GET',
          url: url('/api/missing'),
          status: 404,
          failure: null,
          resourceType: 'fetch',
        },
      },
    ]);
    expect(server).toMatchObject({
      severity: 'high',
      key: `GET ${host()}/api/boom → 500`,
      observed: 'GET /api/boom answered 500',
    });
    expect(network).toMatchObject({
      severity: 'high',
      key: `GET 127.0.0.1:${deadPort}/api/dead → ${REFUSED}`,
      observed: `GET /api/dead failed: ${REFUSED}`,
    });
    expect(network?.occurrences[0]?.measured).toEqual({
      method: 'GET',
      url: `http://127.0.0.1:${deadPort}/api/dead`,
      status: null,
      failure: REFUSED,
      resourceType: 'fetch',
    });
    expect(server?.fixPrompt).toContain(
      `In /requests.html (${url(`/requests.html?dead=${deadPort}`)}), GET /api/boom answered 500.`,
    );
  });

  test('writes every request of the screen as evidence, the ones that are not findings included', async () => {
    await open(`/requests.html?dead=${deadPort}`);

    const result = await observer.collect(screenAt('screen-1', '/requests.html'));

    expect(result.evidence).toHaveLength(1);
    const [item] = result.evidence;
    if (item === undefined) throw new Error('expected a piece of evidence');
    expect(item).toMatchObject({
      kind: 'requests',
      label: 'Network requests on /requests.html',
      ref: { kind: 'json' },
    });
    expect(item.ref.path).toMatch(/^evidence\/requests-screen-1-[0-9a-f]{16}\.json$/);
    expect(result.findings.map((finding) => finding.evidence)).toEqual([[item], [item], [item]]);
    const stored = await storedEvidence(result);
    expect(stored).toMatchObject({ screenId: 'screen-1', dropped: 0 });
    const byUrl = (path: string): StoredEntry | undefined =>
      stored.entries.find((entry) => entry.url === url(path));
    expect(byUrl(`/requests.html?dead=${deadPort}`)).toMatchObject({
      method: 'GET',
      status: 200,
      resourceType: 'document',
    });
    expect(byUrl('/api/ok')).toMatchObject({ status: 200, failure: null, durationMs: expect.any(Number) });
    expect(byUrl('/favicon.ico?v=2')).toMatchObject({ status: 404 });
    expect(byUrl('/.well-known/security.txt')).toMatchObject({ status: 404 });
    expect(stored.entries.find((entry) => entry.url.startsWith('https://api.stripe.com'))).toMatchObject({
      status: null,
      failure: expect.stringMatching(BLOCKED),
    });
  });

  test('reports no finding for a page whose requests all succeeded, but still records them as evidence', async () => {
    await open('/console-clean.html');

    const result = await observer.collect(screenAt('screen-1', '/console-clean.html'));

    expect(result.findings).toEqual([]);
    expect(result.worthALook).toEqual([]);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      kind: 'requests',
      label: 'Network requests on /console-clean.html',
    });
    const stored = await storedEvidence(result);
    expect(stored).toMatchObject({ screenId: 'screen-1', dropped: 0 });
    expect(stored.entries.map((entry) => [entry.url, entry.status])).toEqual([
      [url('/console-clean.html'), 200],
    ]);
    expect(await ctx.evidence.list()).toHaveLength(1);
  });

  test('two screens hitting GET /api/items/1 and /api/items/2 with 500 share one finding (pattern key)', async () => {
    await open('/request-items.html?id=1');
    const first = await observer.collect(screenAt('screen-1', '/request-items.html?id=1'));
    await open('/request-items.html?id=2');
    const second = await observer.collect(screenAt('screen-2', '/request-items.html?id=2'));

    const merged = mergeFindings([...first.findings, ...second.findings]);

    expect(merged).toHaveLength(1);
    const [finding] = merged.map(asOccurrence);
    expect(finding?.rule.id).toBe('observers.request-server-error');
    expect(finding?.key).toBe(`GET ${host()}/api/items/[param] → 500`);
    expect(finding?.occurrences.map((seen) => [seen.screenId, seen.measured.url])).toEqual([
      ['screen-1', url('/api/items/1')],
      ['screen-2', url('/api/items/2')],
    ]);
  });

  test('a page that answers 500 itself is reported, though its answer arrives before the navigation commits', async () => {
    await open('/broken.html');

    const { findings } = await observer.collect(screenAt('screen-1', '/broken.html'));

    expect(ruleIds(findings)).toEqual(['observers.request-server-error']);
    const [finding] = findings.map(asOccurrence);
    expect(finding?.observed).toBe('GET /broken.html answered 500');
    expect(finding?.occurrences[0]?.measured).toMatchObject({ status: 500, resourceType: 'document' });
  });

  test('a page reached through a redirect is reported by the answer that landed, not the redirect', async () => {
    await open('/old');

    const result = await observer.collect(screenAt('screen-1', '/broken.html'));

    expect(result.findings.map((finding) => finding.key)).toEqual([`GET ${host()}/broken.html → 500`]);
    const stored = await storedEvidence(result);
    expect(stored.entries.map((entry) => entry.status)).toEqual([500]);
  });

  test('a request the page cancels and a frame navigation Lookover aborts are no findings', async () => {
    const failed = (part: string) =>
      ipage.page.waitForEvent('requestfailed', (request) => request.url().includes(part));
    await Promise.all([failed('/api/slow'), failed('checkout.stripe.com'), open('/aborts.html')]);

    const result = await observer.collect(screenAt('screen-1', '/aborts.html'));

    expect(result.findings).toEqual([]);
    const stored = await storedEvidence(result);
    // Both were seen, in whichever order they failed, and left out of the findings.
    const failures = stored.entries.filter((entry) => entry.failure !== null);
    expect(failures).toHaveLength(2);
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: url('/api/slow'), failure: ABORTED, resourceType: 'fetch' }),
        expect.objectContaining({ url: CHECKOUT, failure: ABORTED, resourceType: 'document' }),
      ]),
    );
  });

  test('a navigation of the page itself that Lookover aborts is no finding, and the page stays', async () => {
    await open('/console-clean.html');
    await Promise.all([
      ipage.page.waitForEvent('requestfailed', (request) => request.url() === CHECKOUT),
      ipage.page.evaluate((target) => location.assign(target), CHECKOUT),
    ]);

    const result = await observer.collect(screenAt('screen-1', '/console-clean.html'));

    expect(result.findings).toEqual([]);
    expect(ipage.page.url()).toBe(url('/console-clean.html'));
  });

  test('a page that is not found itself is a client error', async () => {
    await open('/gone.html');

    const { findings } = await observer.collect(screenAt('screen-1', '/gone.html'));

    expect(findings.map((finding) => finding.key)).toEqual([`GET ${host()}/gone.html → 404`]);
  });

  test('a page that fails after it committed is reported as a network error', async () => {
    // The answer (200) and the commit come first; the failure of the body comes after both.
    await Promise.all([
      ipage.page.waitForEvent('requestfailed', (request) => request.isNavigationRequest()),
      ipage.page.goto(url('/partial.html'), { waitUntil: 'commit' }),
    ]);

    const result = await observer.collect(screenAt('screen-1', '/partial.html'));

    const [finding] = result.findings.map(asOccurrence);
    expect(ruleIds(result.findings)).toEqual(['observers.request-network-error']);
    expect(finding?.key).toBe(`GET ${host()}/partial.html → net::ERR_INCOMPLETE_CHUNKED_ENCODING`);
    expect(finding?.observed).toBe('GET /partial.html failed: net::ERR_INCOMPLETE_CHUNKED_ENCODING');
    expect(finding?.occurrences[0]?.measured).toMatchObject({ status: null, resourceType: 'document' });
    const stored = await storedEvidence(result);
    expect(stored.entries.map((entry) => [entry.status, entry.failure])).toEqual([
      [200, null],
      [null, 'net::ERR_INCOMPLETE_CHUNKED_ENCODING'],
    ]);
  });

  test("never carries one screen's requests into the next, whatever happened to the page in between", async () => {
    await open('/request-items.html?id=1');
    // A lens reloads the screen's own URL, and no collect runs for it.
    await ipage.page.reload({ waitUntil: 'networkidle' });
    await open('/console-clean.html');

    const result = await observer.collect(screenAt('screen-2', '/console-clean.html'));

    expect(result.findings).toEqual([]);
    const stored = await storedEvidence(result);
    expect(stored.entries.map((entry) => entry.url)).toEqual([url('/console-clean.html')]);
  });

  test('a reload replaces what the page requested before it', async () => {
    await open('/request-items.html?id=1');
    await ipage.page.reload({ waitUntil: 'networkidle' });

    const result = await observer.collect(screenAt('screen-1', '/request-items.html?id=1'));

    const stored = await storedEvidence(result);
    expect(stored.entries.filter((entry) => entry.url === url('/api/items/1'))).toHaveLength(1);
  });

  test('reports what was seen once: the next collect starts empty', async () => {
    await open('/request-items.html?id=1');
    await observer.collect(screenAt('screen-1', '/request-items.html?id=1'));

    const again = await observer.collect(screenAt('screen-1', '/request-items.html?id=1'));

    expect(again).toEqual(NOTHING_SEEN);
  });

  test('keeps at most 500 requests a screen, counts the ones it dropped, and starts the next screen clean', async () => {
    await open('/console-clean.html');
    await observer.collect(screenAt('screen-0', '/console-clean.html'));
    await ipage.page.evaluate(async (count) => {
      await Promise.allSettled(
        Array.from({ length: count }, () => fetch('/api/boom').then((response) => response.text())),
      );
    }, MAX_REQUESTS_PER_SCREEN + 100);
    await settleNetwork();

    const first = await observer.collect(screenAt('screen-1', '/console-clean.html'));

    const stored = await storedEvidence(first);
    expect(stored.entries).toHaveLength(MAX_REQUESTS_PER_SCREEN);
    expect(stored.dropped).toBe(100);
    expect(first.findings.map(asOccurrence)).toHaveLength(1);

    await ipage.page.evaluate(() => fetch('/api/boom').then((response) => response.text()));
    await settleNetwork();
    const second = await storedEvidence(await observer.collect(screenAt('screen-2', '/console-clean.html')));
    expect(second.dropped).toBe(0);
    expect(second.entries).toHaveLength(1);
  });

  test('redacts a URL before cutting it to 2000 characters, so a secret that straddles the cut does not survive', async () => {
    await open('/console-clean.html');
    await observer.collect(screenAt('screen-0', '/console-clean.html'));
    const prefix = `${url('/api/boom')}?q=`;
    const token = '&t=';
    // The cut falls between the header and the payload of the token.
    const padding = 'p'.repeat(MAX_REQUEST_URL_LENGTH - prefix.length - token.length - 'eyJhbGciOiJ'.length);
    await ipage.page.evaluate(
      (target) => fetch(target).then((response) => response.text()),
      `${prefix}${padding}${token}${JWT}`,
    );
    await settleNetwork();

    const result = await observer.collect(screenAt('screen-1', '/console-clean.html'));

    const [entry] = (await storedEvidence(result)).entries;
    expect(entry?.url).toMatch(/\?q=p+&t=\[jwt\]$/);
    expect(JSON.stringify(result.findings)).not.toContain('eyJ');
  });

  test('redacts secrets in the URLs it stores', async () => {
    await open('/console-clean.html');
    await observer.collect(screenAt('screen-0', '/console-clean.html'));
    await ipage.page.evaluate(() =>
      fetch('/api/boom?token=abc123secret&user=jay@example.com').then((response) => response.text()),
    );
    await settleNetwork();

    const result = await observer.collect(screenAt('screen-1', '/console-clean.html'));

    const [entry] = (await storedEvidence(result)).entries;
    expect(entry?.url).toBe(`${url('/api/boom')}?token=[redacted]&user=[email]`);
    const [finding] = result.findings.map(asOccurrence);
    expect(JSON.stringify(finding)).not.toMatch(/abc123secret|jay@example\.com/);
  });
});
