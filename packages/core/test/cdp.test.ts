import { fileURLToPath } from 'node:url';
import { type FixtureServer, serveFixture } from '@jayslifecode/lookover-test-support';
import type { CDPSession } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { callOnNode, forcePseudoState, pushNodes, resolveSelector } from '../src/browser/cdp.js';
import { BrowserSession, type InstrumentedPage } from '../src/browser/session.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/cdp', import.meta.url));
const BROWSER_TIMEOUT_MS = 30_000;
const VIEWPORT = { name: 'desktop', width: 1280, height: 800 };
const REST_BACKGROUND = 'rgb(255, 255, 255)';
const HOVER_BACKGROUND = 'rgb(255, 0, 0)';
/** No element has this backend id in a fixture this small. */
const UNKNOWN_BACKEND_ID = 999_999;
const READ_ID_SOURCE = 'function () { return this.id; }';

describe('CDP helpers', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let session: BrowserSession;
  let ipage: InstrumentedPage;

  beforeAll(async () => {
    fixture = await serveFixture(FIXTURE_DIR);
    session = await BrowserSession.launch({ viewport: VIEWPORT, allowHosts: [], onEvent: () => {} });
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await session.close();
    await fixture.close();
  }, BROWSER_TIMEOUT_MS);

  beforeEach(async () => {
    ipage = await session.newPage();
    await ipage.page.goto(`${fixture.url}/`);
  });

  afterEach(async () => {
    await ipage.close();
  });

  /** A CDP session of its own, so looking ids up never requests the document on the one under test. */
  async function backendIdsOf(selectors: readonly string[]): Promise<number[]> {
    const lookup = await session.context.newCDPSession(ipage.page);
    try {
      const { root } = await lookup.send('DOM.getDocument', { depth: 0 });
      return await Promise.all(
        selectors.map(async (selector) => {
          const { nodeId } = await lookup.send('DOM.querySelector', { nodeId: root.nodeId, selector });
          const { node } = await lookup.send('DOM.describeNode', { nodeId });
          return node.backendNodeId;
        }),
      );
    } finally {
      await lookup.detach();
    }
  }

  function computed(selector: string, property: 'backgroundColor' | 'outlineStyle'): Promise<string> {
    return ipage.page.evaluate(
      ([target, name]) => {
        const element = document.querySelector(target);
        if (element === null) throw new Error(`no element matches ${target}`);
        return getComputedStyle(element)[name];
      },
      [selector, property] as const,
    );
  }

  async function nodeIdOf(cdp: CDPSession, selector: string): Promise<number> {
    const [backendId] = await backendIdsOf([selector]);
    const [nodeId] = await pushNodes(cdp, [backendId ?? UNKNOWN_BACKEND_ID]);
    if (nodeId === undefined || nodeId === 0) throw new Error(`could not push ${selector}`);
    return nodeId;
  }

  describe('resolveSelector', () => {
    test('resolves the element a selector matches to a remote object', async () => {
      const objectId = await resolveSelector(ipage.cdp, '#a');

      expect(objectId).not.toBeNull();
      expect(await callOnNode(ipage.cdp, objectId ?? '', READ_ID_SOURCE)).toBe('a');
    });

    test('returns null when nothing matches', async () => {
      expect(await resolveSelector(ipage.cdp, '#nope')).toBeNull();
    });
  });

  describe('pushNodes', () => {
    test('returns one node id per backend id, in order, 0 for a node that is not in the document', async () => {
      const [a, b] = await backendIdsOf(['#a', '#b']);

      const nodeIds = await pushNodes(ipage.cdp, [b ?? 0, UNKNOWN_BACKEND_ID, a ?? 0]);

      expect(nodeIds).toHaveLength(3);
      expect(nodeIds[0]).toBeGreaterThan(0);
      expect(nodeIds[1]).toBe(0);
      expect(nodeIds[2]).toBeGreaterThan(0);
      expect(nodeIds[0]).not.toBe(nodeIds[2]);
    });

    test('requests the document itself on a session that never did, and again after a reload', async () => {
      const [a] = await backendIdsOf(['#a']);
      expect(await pushNodes(ipage.cdp, [a ?? 0])).toEqual([expect.any(Number)]);

      await ipage.page.reload();
      const [reloaded] = await backendIdsOf(['#a']);
      const [nodeId] = await pushNodes(ipage.cdp, [reloaded ?? 0]);

      expect(nodeId).toBeGreaterThan(0);
    });

    test('leaves the ids an earlier call returned valid', async () => {
      const first = await nodeIdOf(ipage.cdp, '#a');
      await nodeIdOf(ipage.cdp, '#b');

      await forcePseudoState(ipage.cdp, first, ['hover']);

      expect(await computed('#a', 'backgroundColor')).toBe(HOVER_BACKGROUND);
      await forcePseudoState(ipage.cdp, first, []);
    });
  });

  describe('forcePseudoState', () => {
    test('forces :hover and clears it again with an empty list', async () => {
      const nodeId = await nodeIdOf(ipage.cdp, '#a');
      expect(await computed('#a', 'backgroundColor')).toBe(REST_BACKGROUND);

      await forcePseudoState(ipage.cdp, nodeId, ['hover']);
      expect(await computed('#a', 'backgroundColor')).toBe(HOVER_BACKGROUND);

      await forcePseudoState(ipage.cdp, nodeId, []);
      expect(await computed('#a', 'backgroundColor')).toBe(REST_BACKGROUND);
    });

    test('forces :focus-visible together with :focus', async () => {
      const nodeId = await nodeIdOf(ipage.cdp, '#b');
      expect(await computed('#b', 'outlineStyle')).toBe('none');

      await forcePseudoState(ipage.cdp, nodeId, ['focus', 'focus-visible']);
      expect(await computed('#b', 'outlineStyle')).toBe('solid');

      await forcePseudoState(ipage.cdp, nodeId, []);
      expect(await computed('#b', 'outlineStyle')).toBe('none');
    });

    test('enables the CSS domain on each new CDP session it is used with', async () => {
      const other = await session.context.newCDPSession(ipage.page);
      try {
        const nodeId = await nodeIdOf(other, '#a');

        await forcePseudoState(other, nodeId, ['hover']);
        expect(await computed('#a', 'backgroundColor')).toBe(HOVER_BACKGROUND);
        await forcePseudoState(other, nodeId, []);
      } finally {
        await other.detach();
      }
    });
  });
});
