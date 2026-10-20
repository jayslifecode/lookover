import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { boxFor, callOnNode, getAXTree, resolveBackendNode } from '../src/browser/cdp.js';
import { BrowserSession, type InstrumentedPage, type SessionEvent } from '../src/browser/session.js';
import { type FixtureServer, serveFixture } from './fixtures/serve.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/session', import.meta.url));
const BROWSER_TIMEOUT_MS = 30_000;
const SOCKET_SETTLE_MS = 5_000;
const WS_POLICY_VIOLATION = 1008;
const UNKNOWN_BACKEND_NODE_ID = 2_147_483_647;
const VIEWPORT = { name: 'desktop', width: 1280, height: 800 };

type FixtureResults = Record<string, string>;

function redirectTo(target: (port: number) => string) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(302, { location: target(req.socket.localPort ?? 0) });
    res.end();
  };
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

  beforeAll(async () => {
    fixture = await serveFixture(FIXTURE_DIR, {
      '/out': redirectTo((port) => `http://foreign.localhost:${port}/landing.html`),
      '/hop': redirectTo((port) => `http://backend.localhost:${port}/ok.json`),
      '/pay': redirectTo(() => 'https://api.stripe.com/v1/redirected'),
    });
    fixturePort = new URL(fixture.url).port;
  });

  afterAll(async () => {
    await fixture.close();
  });

  describe('with the default policy', () => {
    let session: BrowserSession;
    let ipage: InstrumentedPage;
    let events: SessionEvent[];

    beforeEach(async () => {
      events = [];
      session = await BrowserSession.launch({
        viewport: VIEWPORT,
        allowHosts: [],
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
        url: `http://foreign.localhost:${fixturePort}/landing.html`,
        reason: 'host-not-allowed',
      });
      expect(session.observedHosts()).not.toContain('foreign.localhost');
    });

    test('records a backend the app reaches through a redirect', async () => {
      await openFixture();

      await ipage.page.evaluate(() => fetch('/hop').then(String, String));

      await expect.poll(() => session.observedHosts()).toEqual(['127.0.0.1', 'backend.localhost']);
      expect(events).toContainEqual({ type: 'host.observed', host: 'backend.localhost', kind: 'app-call' });
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
});
