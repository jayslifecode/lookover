import { fileURLToPath } from 'node:url';
import { type FixtureServer, serveFixture } from '@jayslifecode/lookover-test-support';
import type { Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { getAXTree } from '../src/browser/cdp.js';
import { BrowserSession, type SessionEvent } from '../src/browser/session.js';
import type { Viewport } from '../src/map/types.js';

const SITE_DIR = fileURLToPath(new URL('./fixtures/site', import.meta.url));
const BROWSER_TIMEOUT_MS = 30_000;
const SESSION_VIEWPORT: Viewport = { name: 'desktop', width: 1280, height: 800 };
const ISOLATED_VIEWPORT: Viewport = { name: 'narrow-desktop', width: 1200, height: 700 };
/** Not allowed by the policy; the test resolver hook points it at the fixture server. */
const BACKEND_HOST = 'backend.test';
const PROVIDER_URL = 'https://checkout.stripe.com/pay';
const SEEN_COOKIE = 'seen=1';
const NOT_SET = '';

/** Fetches `url` in the page as `no-cors`: `'sent'` once it is answered, `'failed'` if it is refused. */
function sendOutcome(page: Page, url: string): Promise<string> {
  return page.evaluate(
    (target) =>
      fetch(target, { mode: 'no-cors' }).then(
        () => 'sent',
        () => 'failed',
      ),
    url,
  );
}

describe('BrowserSession isolated pages', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let fixturePort: string;
  /** The `call` of every request that reached `/count`, in order. */
  let countedCalls: string[] = [];
  let session: BrowserSession;
  let crawlPage: Page;
  let events: SessionEvent[];

  beforeAll(async () => {
    fixture = await serveFixture(SITE_DIR, {
      // A page of its own, so that a cookie in an isolated page can only have come from the session.
      '/set-cookie': (_req, res) => {
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'set-cookie': `${SEEN_COOKIE}; Path=/`,
        });
        res.end('ok');
      },
      '/count': (req, res) => {
        const call = new URL(req.url ?? '/', 'http://fixture.invalid').searchParams.get('call') ?? '';
        countedCalls = [...countedCalls, call];
        res.writeHead(204);
        res.end();
      },
    });
    fixturePort = new URL(fixture.url).port;
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(async () => {
    events = [];
    countedCalls = [];
    session = await BrowserSession.launch({
      viewport: SESSION_VIEWPORT,
      allowHosts: [],
      testResolver: { loopbackHosts: [BACKEND_HOST] },
      onEvent: (event) => {
        events = [...events, event];
      },
    });
    crawlPage = (await session.newPage()).page;
  }, BROWSER_TIMEOUT_MS);

  afterEach(async () => {
    await session.close();
  }, BROWSER_TIMEOUT_MS);

  async function visitCounter(page: Page): Promise<{ count: string | null; cookie: string | null }> {
    await page.goto(`${fixture.url}/counter.html`);
    return { count: await page.textContent('#count'), cookie: await page.textContent('#cookie') };
  }

  async function takeCookie(): Promise<void> {
    await crawlPage.goto(`${fixture.url}/set-cookie`);
  }

  test('an isolated page carries the session cookies but not the page state', async () => {
    await takeCookie();
    await visitCounter(crawlPage);
    expect((await visitCounter(crawlPage)).count).toBe('2');

    const isolated = await session.newIsolatedPage(ISOLATED_VIEWPORT);
    const seen = await visitCounter(isolated.page);

    expect(seen).toEqual({ count: '1', cookie: SEEN_COOKIE });
    expect(await crawlPage.textContent('#count')).toBe('2');
  });

  test('an isolated page takes its storage state when it is opened, not when the session started', async () => {
    const before = await session.newIsolatedPage(ISOLATED_VIEWPORT);
    expect((await visitCounter(before.page)).cookie).toBe(NOT_SET);

    await takeCookie();
    await crawlPage.evaluate(() => localStorage.setItem('theme', 'dark'));
    const after = await session.newIsolatedPage(ISOLATED_VIEWPORT);

    expect((await visitCounter(after.page)).cookie).toBe(SEEN_COOKIE);
    expect(await after.page.evaluate(() => localStorage.getItem('theme'))).toBe('dark');
  });

  test('an isolated page has the requested viewport and a CDP session of its own', async () => {
    const isolated = await session.newIsolatedPage(ISOLATED_VIEWPORT);
    await visitCounter(isolated.page);

    const nodes = await getAXTree(isolated.cdp);

    expect(isolated.page.viewportSize()).toEqual({
      width: ISOLATED_VIEWPORT.width,
      height: ISOLATED_VIEWPORT.height,
    });
    expect(nodes.map((node) => node.name)).toContain('Counter');
  });

  test('an isolated page is inside the network envelope: a provider call is blocked and reported', async () => {
    const isolated = await session.newIsolatedPage(ISOLATED_VIEWPORT);
    await visitCounter(isolated.page);

    const outcome = await sendOutcome(isolated.page, PROVIDER_URL);

    expect(outcome).toBe('failed');
    expect(events).toContainEqual({ type: 'request.blocked', url: PROVIDER_URL, reason: 'provider' });
  });

  test('an isolated page is kept on the app: a navigation to another host is blocked', async () => {
    const isolated = await session.newIsolatedPage(ISOLATED_VIEWPORT);
    await visitCounter(isolated.page);
    const before = isolated.page.url();

    await isolated.page.evaluate(() => {
      const link = document.createElement('a');
      link.href = 'https://example.com/';
      link.id = 'external';
      link.textContent = 'Example';
      document.body.append(link);
    });
    await isolated.page.click('#external');

    await expect
      .poll(() => events)
      .toContainEqual({ type: 'request.blocked', url: 'https://example.com/', reason: 'host-not-allowed' });
    expect(isolated.page.url()).toBe(before);
  });

  test('an isolated page respects confirmed hosts', async () => {
    const backendCall = (call: string): string => `http://${BACKEND_HOST}:${fixturePort}/count?call=${call}`;
    const isolated = await session.newIsolatedPage(ISOLATED_VIEWPORT);
    await visitCounter(isolated.page);

    const before = await sendOutcome(isolated.page, backendCall('before'));
    session.enforceConfirmedHosts([]);
    const after = await sendOutcome(isolated.page, backendCall('after'));

    expect([before, after]).toEqual(['sent', 'failed']);
    expect(countedCalls).toEqual(['before']);
    expect(events).toContainEqual({
      type: 'request.blocked',
      url: backendCall('after'),
      reason: 'unconfirmed-backend',
    });
  });

  test('closing the isolated page closes its context, and the session still works', async () => {
    const isolated = await session.newIsolatedPage(ISOLATED_VIEWPORT);
    const isolatedContext = isolated.page.context();
    const browser = session.context.browser();
    expect(browser?.contexts()).toHaveLength(2);
    expect(browser?.contexts()).toContain(isolatedContext);

    await isolated.close();

    expect(isolated.page.isClosed()).toBe(true);
    expect(browser?.contexts()).toEqual([session.context]);
    expect((await visitCounter(crawlPage)).count).toBe('1');
    const next = await session.newIsolatedPage(ISOLATED_VIEWPORT);
    expect((await visitCounter(next.page)).count).toBe('1');
  });

  test('browserVersion names chromium', () => {
    expect(session.browserVersion()).toMatch(/^chromium \d+/);
  });
});
