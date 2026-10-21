import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FixtureServer, serveFixture } from '@jayslifecode/lookover-test-support';
import type { Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { boxFor, callOnNode, getAXTree, resolveBackendNode } from '../src/browser/cdp.js';
import { BrowserSession, type InstrumentedPage, type SessionEvent } from '../src/browser/session.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/session', import.meta.url));
const BROWSER_TIMEOUT_MS = 30_000;
const SOCKET_SETTLE_MS = 5_000;
/** How long the page waits for a fetch the session may hold paused before calling it timed out. */
const FETCH_WAIT_MS = 1_000;
const WS_POLICY_VIOLATION = 1008;
const UNKNOWN_BACKEND_NODE_ID = 2_147_483_647;
const VIEWPORT = { name: 'desktop', width: 1280, height: 800 };
/** Not allowed by the policy; the test resolver hook points them at the fixture server. */
const FOREIGN_HOST = 'foreign.test';
const BACKEND_HOST = 'backend.test';
const NAME_NOT_RESOLVED = 'net::ERR_NAME_NOT_RESOLVED';

type FixtureResults = Record<string, string>;

function redirectTo(target: (port: number) => string) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(302, { location: target(req.socket.localPort ?? 0) });
    res.end();
  };
}

/** Fetches `url` in the page: `'ok'` for any response, `'failed'` for a network error. */
function fetchOutcome(page: Page, url: string): Promise<string> {
  return page.evaluate(
    ({ target, timeoutMs }) =>
      fetch(target, { signal: AbortSignal.timeout(timeoutMs) }).then(
        () => 'ok',
        (error: Error) => (error.name === 'TimeoutError' ? 'timed out' : 'failed'),
      ),
    { target: url, timeoutMs: FETCH_WAIT_MS },
  );
}

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

/** Opens a websocket to `url` in the page: `'closed <code>'` once it closes, `'still open'` after a while. */
function socketOutcome(page: Page, url: string): Promise<string> {
  return page.evaluate(
    ({ target, settleMs }) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(target);
        socket.addEventListener('close', (event) => resolve(`closed ${event.code}`));
        setTimeout(() => resolve('still open'), settleMs);
      }),
    { target: url, settleMs: SOCKET_SETTLE_MS },
  );
}

function defined<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`expected ${what}`);
  }
  return value;
}

describe('BrowserSession', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let fixturePort: string;
  /** The `call` of every request that reached `/count`, in order. */
  let countedCalls: string[] = [];

  beforeAll(async () => {
    fixture = await serveFixture(FIXTURE_DIR, {
      '/out': redirectTo((port) => `http://${FOREIGN_HOST}:${port}/landing.html`),
      '/hop-frame': redirectTo((port) => `http://${FOREIGN_HOST}:${port}/landing.html?in=frame`),
      '/hop': redirectTo((port) => `http://${BACKEND_HOST}:${port}/ok.json`),
      '/pay': redirectTo(() => 'https://api.stripe.com/v1/redirected'),
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

  describe('with the default policy and two foreign fixture hosts', () => {
    let session: BrowserSession;
    let ipage: InstrumentedPage;
    let events: SessionEvent[];

    beforeEach(async () => {
      events = [];
      session = await BrowserSession.launch({
        viewport: VIEWPORT,
        allowHosts: [],
        testResolver: { loopbackHosts: [FOREIGN_HOST, BACKEND_HOST] },
        onEvent: (event) => {
          events = [...events, event];
        },
      });
      ipage = await session.newPage();
    }, BROWSER_TIMEOUT_MS);

    afterEach(async () => {
      await session.close();
    }, BROWSER_TIMEOUT_MS);

    async function openFixture(): Promise<void> {
      await ipage.page.goto(`${fixture.url}/index.html`);
      await ipage.page.waitForFunction(() => {
        const results = (window as unknown as { __results?: FixtureResults }).__results ?? {};
        return 'ok' in results && 'stripe' in results;
      });
    }

    function blockedUrls(): string[] {
      return events.flatMap((event) => (event.type === 'request.blocked' ? [event.url] : []));
    }

    test('opens pages at the configured viewport', async () => {
      expect(ipage.page.viewportSize()).toEqual({ width: VIEWPORT.width, height: VIEWPORT.height });
    });

    test('lets the app call its own host and fails a payment-provider fetch in the page', async () => {
      await openFixture();

      const results = await ipage.page.evaluate(
        () => (window as unknown as { __results: FixtureResults }).__results,
      );

      expect(results).toEqual({ ok: 'ok', stripe: 'failed' });
      expect(events).toContainEqual({
        type: 'request.blocked',
        url: 'https://api.stripe.com/v1/x',
        reason: 'provider',
      });
    });

    test('records each host the app reached once per kind', async () => {
      await openFixture();
      await openFixture();

      expect(session.observedHosts()).toEqual(['127.0.0.1']);
      expect(events.filter((event) => event.type === 'host.observed')).toEqual([
        { type: 'host.observed', host: '127.0.0.1', kind: 'navigation' },
        { type: 'host.observed', host: '127.0.0.1', kind: 'app-call' },
      ]);
    });

    test('records a host the page only loads an image and a script from as a subresource', async () => {
      await openFixture();
      const foreignOrigin = `http://${FOREIGN_HOST}:${fixturePort}`;

      await ipage.page.evaluate((origin) => {
        const image = document.createElement('img');
        image.src = `${origin}/pixel.png`;
        const script = document.createElement('script');
        script.src = `${origin}/widget.js`;
        document.body.append(image, script);
      }, foreignOrigin);

      await expect
        .poll(() => events)
        .toContainEqual({ type: 'host.observed', host: FOREIGN_HOST, kind: 'subresource' });
      const foreignKinds = events.flatMap((event) =>
        event.type === 'host.observed' && event.host === FOREIGN_HOST ? [event.kind] : [],
      );
      expect(foreignKinds).toEqual(['subresource']);
      expect(session.observedHosts()).toEqual(['127.0.0.1', FOREIGN_HOST]);
    });

    test('keeps the page on the app when a link leads to another host', async () => {
      await openFixture();
      const before = ipage.page.url();

      await ipage.page.click('#external');

      await expect
        .poll(() => events)
        .toContainEqual({
          type: 'request.blocked',
          url: 'https://example.com/',
          reason: 'host-not-allowed',
        });
      expect(await ipage.page.evaluate(() => location.href)).toBe(before);
      expect(session.observedHosts()).toEqual(['127.0.0.1']);
    });

    test('sends the page to about:blank when a redirect takes it to another host', async () => {
      await openFixture();

      await ipage.page.click('#out');

      await expect.poll(() => ipage.page.url()).toBe('about:blank');
      expect(events).toContainEqual({
        type: 'request.blocked',
        url: `http://${FOREIGN_HOST}:${fixturePort}/landing.html`,
        reason: 'host-not-allowed',
      });
      expect(session.observedHosts()).not.toContain(FOREIGN_HOST);
    });

    test('sends an iframe to about:blank when a redirect takes it to another host', async () => {
      await ipage.page.goto(`${fixture.url}/frame.html`);

      await expect
        .poll(() => events)
        .toContainEqual({
          type: 'request.blocked',
          url: `http://${FOREIGN_HOST}:${fixturePort}/landing.html?in=frame`,
          reason: 'host-not-allowed',
        });
      await expect
        .poll(() =>
          ipage.page.frames().flatMap((frame) => (frame === ipage.page.mainFrame() ? [] : [frame.url()])),
        )
        .toEqual(['about:blank']);
      expect(ipage.page.url()).toBe(`${fixture.url}/frame.html`);
      expect(session.observedHosts()).not.toContain(FOREIGN_HOST);
    });

    test('records a backend the app reaches through a redirect', async () => {
      await openFixture();

      await ipage.page.evaluate(() => fetch('/hop').then(String, String));

      await expect.poll(() => session.observedHosts()).toEqual(['127.0.0.1', BACKEND_HOST]);
      expect(events).toContainEqual({ type: 'host.observed', host: BACKEND_HOST, kind: 'app-call' });
    });

    test('reports a request whose routing throws as blocked, and it never goes out', async () => {
      await openFixture();
      // Registered after the session's own handler, so it runs first and hands the session a URL
      // whose scheme change makes the session's `route.continue()` throw. Playwright then holds the
      // request paused (the route counts as handled), so the page sees it time out, not succeed.
      const swappedUrl = 'ftp://fail-closed.invalid/fail-closed.json';
      await session.context.route('**/fail-closed.json', (route) => route.fallback({ url: swappedUrl }));

      const outcome = await fetchOutcome(ipage.page, '/fail-closed.json');

      expect(outcome).not.toBe('ok');
      await expect
        .poll(() => events)
        .toContainEqual({ type: 'request.blocked', url: swappedUrl, reason: 'host-not-allowed' });
    });

    test('reports a provider the app reaches through a redirect as blocked', async () => {
      await openFixture();

      const outcome = await ipage.page.evaluate(() =>
        fetch('/pay').then(
          () => 'ok',
          () => 'failed',
        ),
      );

      expect(outcome).toBe('failed');
      await expect
        .poll(() => events)
        .toContainEqual({
          type: 'request.blocked',
          url: 'https://api.stripe.com/v1/redirected',
          reason: 'provider',
        });
      expect(session.observedHosts()).not.toContain('api.stripe.com');
    });

    test('lets a websocket to an allowed host through and closes one to a provider', async () => {
      await openFixture();
      const allowedSocket = `${fixture.url.replace('http:', 'ws:')}/socket`;
      const providerSocket = 'wss://api.twilio.com/x';

      const outcomes = await ipage.page.evaluate(
        ({ urls, settleMs }) =>
          Promise.all(
            urls.map(
              (url) =>
                new Promise<string>((resolve) => {
                  const socket = new WebSocket(url);
                  socket.addEventListener('close', (event) => resolve(`closed ${event.code}`));
                  setTimeout(() => resolve('still open'), settleMs);
                }),
            ),
          ),
        { urls: [allowedSocket, providerSocket], settleMs: SOCKET_SETTLE_MS },
      );

      expect(events).toContainEqual({ type: 'request.blocked', url: providerSocket, reason: 'provider' });
      expect(outcomes[1]).toBe(`closed ${WS_POLICY_VIOLATION}`);
      expect(blockedUrls()).not.toContain(allowedSocket);
      expect(outcomes[0]).not.toBe(`closed ${WS_POLICY_VIOLATION}`);
    });

    describe('once confirmed hosts are enforced', () => {
      const backendCall = (call: string): string =>
        `http://${BACKEND_HOST}:${fixturePort}/count?call=${call}`;

      function unconfirmedBlocks(): string[] {
        return events.flatMap((event) =>
          event.type === 'request.blocked' && event.reason === 'unconfirmed-backend' ? [event.url] : [],
        );
      }

      beforeEach(() => {
        countedCalls = [];
      });

      test('blocks a backend it let through before, still recording the host', async () => {
        await openFixture();

        const before = await sendOutcome(ipage.page, backendCall('before'));
        session.enforceConfirmedHosts([FOREIGN_HOST]);
        const after = await sendOutcome(ipage.page, backendCall('after'));

        expect([before, after]).toEqual(['sent', 'failed']);
        expect(countedCalls).toEqual(['before']);
        expect(unconfirmedBlocks()).toEqual([backendCall('after')]);
        expect(session.observedHosts()).toContain(BACKEND_HOST);
      });

      test('lets a confirmed backend through, compared as a normalised host', async () => {
        await openFixture();
        session.enforceConfirmedHosts([`${BACKEND_HOST.toUpperCase()}.`]);

        const outcome = await sendOutcome(ipage.page, backendCall('confirmed'));

        expect(outcome).toBe('sent');
        expect(countedCalls).toEqual(['confirmed']);
        expect(unconfirmedBlocks()).toEqual([]);
      });

      test('closes a websocket to a backend that is not confirmed', async () => {
        await openFixture();
        session.enforceConfirmedHosts([]);
        const socketUrl = `ws://${BACKEND_HOST}:${fixturePort}/socket`;

        const outcome = await socketOutcome(ipage.page, socketUrl);

        expect(outcome).toBe(`closed ${WS_POLICY_VIOLATION}`);
        // The page can see the close before the session has reported it.
        await expect.poll(unconfirmedBlocks).toEqual([socketUrl]);
        expect(session.observedHosts()).toContain(BACKEND_HOST);
      });

      test('still lets the app call its own host', async () => {
        session.enforceConfirmedHosts([]);

        await openFixture();

        const results = await ipage.page.evaluate(
          () => (window as unknown as { __results: FixtureResults }).__results,
        );
        expect(results.ok).toBe('ok');
        expect(unconfirmedBlocks()).toEqual([]);
      });
    });

    test('closes an instrumented page', async () => {
      await ipage.close();

      expect(ipage.page.isClosed()).toBe(true);
    });

    describe('cdp helpers', () => {
      async function saveButton() {
        await openFixture();
        await ipage.page.waitForLoadState('load');
        const nodes = await getAXTree(ipage.cdp);
        return defined(
          nodes.find((node) => node.role === 'button' && node.name === 'Save'),
          'a Save button in the accessibility tree',
        );
      }

      async function saveButtonBackendId(): Promise<number> {
        return defined((await saveButton()).backendDOMNodeId, 'a backend node id for the Save button');
      }

      async function backendIdOf(selector: string): Promise<number> {
        const { root } = await ipage.cdp.send('DOM.getDocument');
        const { nodeId } = await ipage.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
        const { node } = await ipage.cdp.send('DOM.describeNode', { nodeId });
        return node.backendNodeId;
      }

      test('getAXTree returns the button with its role, name and properties', async () => {
        const save = await saveButton();

        expect(save.ignored).toBe(false);
        expect(save.nodeId).toEqual(expect.any(String));
        expect(save.backendDOMNodeId).toEqual(expect.any(Number));
        expect(save.properties).toMatchObject({ focusable: true });
      });

      test('getAXTree links each node to its children', async () => {
        const save = await saveButton();
        const nodes = await getAXTree(ipage.cdp);

        const parents = nodes.filter((node) => node.childIds.includes(save.nodeId));
        const children = nodes.filter((node) => save.childIds.includes(node.nodeId));

        expect(parents).toHaveLength(1);
        expect(children.map((node) => node.name)).toContain('Save');
      });

      test('boxFor measures the button with a positive area', async () => {
        const backendId = await saveButtonBackendId();

        const box = await boxFor(ipage.cdp, backendId);

        expect(box).not.toBeNull();
        expect(box?.width).toBeGreaterThan(0);
        expect(box?.height).toBeGreaterThan(0);
        expect(box?.x).toBeGreaterThanOrEqual(0);
        expect(box?.y).toBeGreaterThanOrEqual(0);
      });

      test('boxFor is null for an element without area and for an unknown node', async () => {
        await openFixture();

        expect(await boxFor(ipage.cdp, await backendIdOf('#empty'))).toBeNull();
        expect(await boxFor(ipage.cdp, UNKNOWN_BACKEND_NODE_ID)).toBeNull();
      });

      test('resolveBackendNode and callOnNode run a function on the element', async () => {
        const objectId = await resolveBackendNode(ipage.cdp, await saveButtonBackendId());

        const text = await callOnNode<string>(
          ipage.cdp,
          objectId,
          'function () { return this.textContent; }',
        );
        const tagged = await callOnNode<string>(
          ipage.cdp,
          objectId,
          'function (suffix) { return this.tagName + suffix; }',
          ['!'],
        );

        expect(text).toBe('Save');
        expect(tagged).toBe('BUTTON!');
      });

      test('callOnNode rejects when the function throws', async () => {
        const objectId = await resolveBackendNode(ipage.cdp, await saveButtonBackendId());

        await expect(
          callOnNode(ipage.cdp, objectId, 'function () { throw new Error("boom"); }'),
        ).rejects.toThrow(/boom/);
      });

      test('resolveBackendNode rejects for an unknown node', async () => {
        await openFixture();

        await expect(resolveBackendNode(ipage.cdp, UNKNOWN_BACKEND_NODE_ID)).rejects.toThrow();
      });
    });
  });

  test('loads cookies from a storage state file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lookover-session-'));
    const storageStatePath = join(dir, 'state.json');
    const cookie = {
      name: 'session',
      value: 'fixture-session',
      domain: '127.0.0.1',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    };
    await writeFile(storageStatePath, JSON.stringify({ cookies: [cookie], origins: [] }));

    const session = await BrowserSession.launch({
      viewport: VIEWPORT,
      allowHosts: [],
      storageStatePath,
      onEvent: () => {},
    });
    try {
      const cookies = await session.context.cookies(fixture.url);

      expect(cookies.map(({ name, value }) => ({ name, value }))).toEqual([
        { name: 'session', value: 'fixture-session' },
      ]);
    } finally {
      await session.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses requests and contains frames when the policy check throws', async () => {
    let isArmed = false;
    // Stands in for a bug in the policy code: an allowHosts entry that throws once armed. Local
    // hosts are decided before allowHosts is read, so only the foreign hosts below reach it.
    const trap = {
      trim: () => {
        if (isArmed) {
          throw new Error('policy bug');
        }
        return 'never.example';
      },
    } as unknown as string;
    let events: SessionEvent[] = [];
    const session = await BrowserSession.launch({
      viewport: VIEWPORT,
      allowHosts: [trap],
      testResolver: { loopbackHosts: [BACKEND_HOST, FOREIGN_HOST] },
      onEvent: (event) => {
        events = [...events, event];
      },
    });
    try {
      const { page } = await session.newPage();
      await page.goto(`${fixture.url}/landing.html`);
      const target = `http://${BACKEND_HOST}:${fixturePort}/ok.json`;
      const landed = `http://${FOREIGN_HOST}:${fixturePort}/landing.html`;
      isArmed = true;

      const outcome = await fetchOutcome(page, target);
      // The redirect hop is never routed, so only frame containment can catch where it lands.
      await page.evaluate(() => location.assign('/out'));

      expect(outcome).toBe('failed');
      await expect.poll(() => page.url()).toBe('about:blank');
      expect(events).toEqual(
        expect.arrayContaining([
          { type: 'request.blocked', url: target, reason: 'host-not-allowed' },
          { type: 'request.blocked', url: landed, reason: 'host-not-allowed' },
        ]),
      );
      expect(session.observedHosts()).not.toContain(BACKEND_HOST);
    } finally {
      await session.close();
    }
  });

  test('the DNS layer makes blocked names unresolvable with or without a trailing dot', async () => {
    // `*.localhost` is allowed by the policy and always resolves to loopback, so every request below
    // passes the route handler and only the host-resolver rules decide the outcome.
    const session = await BrowserSession.launch({
      viewport: VIEWPORT,
      allowHosts: ['ok.blocked.localhost'],
      testResolver: { blockedHosts: ['blocked.localhost'] },
      onEvent: () => {},
    });
    try {
      const { page } = await session.newPage();
      const outcomes = new Map<string, string>();
      page.on('requestfailed', (request) =>
        outcomes.set(request.url(), request.failure()?.errorText ?? 'failed'),
      );
      page.on('requestfinished', (request) => outcomes.set(request.url(), 'finished'));
      await page.goto(`${fixture.url}/landing.html`);
      // A plain-text 404: any response proves the name resolved, and unlike JSON it is not withheld
      // from a no-cors fetch by Chromium's opaque-response blocking.
      const urlFor = (host: string): string => `http://${host}:${fixturePort}/dns-probe`;
      const blocked = [
        'a.blocked.localhost',
        'a.blocked.localhost.',
        'blocked.localhost',
        'blocked.localhost.',
      ].map(urlFor);
      const excluded = ['ok.blocked.localhost', 'ok.blocked.localhost.'].map(urlFor);

      await page.evaluate(
        (urls) => Promise.all(urls.map((url) => fetch(url, { mode: 'no-cors' }).then(String, String))),
        [...blocked, ...excluded],
      );

      await expect
        .poll(() => [...blocked, ...excluded].map((url) => [url, outcomes.get(url)]))
        .toEqual([
          ...blocked.map((url) => [url, NAME_NOT_RESOLVED]),
          ...excluded.map((url) => [url, 'finished']),
        ]);
    } finally {
      await session.close();
    }
  });
});
