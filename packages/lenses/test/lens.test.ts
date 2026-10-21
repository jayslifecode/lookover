import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type {
  EvidenceRef,
  Finding,
  InstrumentedPage,
  LensContext,
  LensResult,
  Viewport,
} from '@jayslifecode/lookover-core';
import { RULE_IDS, RULES } from '@jayslifecode/lookover-rules';
import { type FixtureServer, serveFixture } from '@jayslifecode/lookover-test-support';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { INTERACTION_RULES, InteractionLens } from '../src/index.js';
import type { StateGallery } from '../src/interaction/states.js';
import { createTestRun, lensContextFor, type TestRun } from './helpers/context.js';
import { launchTestSession, type TestSession } from './helpers/session.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));
const BROWSER_TIMEOUT_MS = 60_000;
const DESKTOP: Viewport = { name: 'desktop', width: 1440, height: 900 };
const MOBILE: Viewport = { name: 'mobile', width: 390, height: 844 };
/** Shorter than ring.html, so the Tab walk scrolls the page to reach its last controls. */
const SHORT: Viewport = { name: 'short', width: 1440, height: 300 };
/** busy.html keeps its main thread busy for 3 s; the lens is given 2 s and must be done well before 4. */
const BUSY_DEADLINE_MS = 2_000;
const BUSY_RETURNS_WITHIN_MS = 4_000;

/** Each finding as `rule id → selector`, the selector of a step finding's element. */
function ruleAndSelector(findings: readonly Finding[]): [string, string | undefined][] {
  return findings.map((finding) => [
    finding.rule.id,
    finding.shape === 'step' ? finding.target?.selector : undefined,
  ]);
}

describe('INTERACTION_RULES', () => {
  test('are the twelve interaction rules of the catalogue, in its order', () => {
    const catalogued = RULES.filter((rule) => rule.source === 'interaction').map((rule) => rule.id);

    expect(INTERACTION_RULES).toHaveLength(12);
    expect(INTERACTION_RULES.every((id) => RULE_IDS.has(id))).toBe(true);
    expect(INTERACTION_RULES).toEqual(catalogued);
  });

  test('are the rules the lens reports', () => {
    const lens = new InteractionLens();

    expect(lens.name).toBe('interaction');
    expect(lens.rules).toEqual(INTERACTION_RULES);
  });
});

describe('InteractionLens', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let browser: TestSession;
  let run: TestRun;

  beforeAll(async () => {
    fixture = await serveFixture(FIXTURE_DIR);
    browser = await launchTestSession(DESKTOP);
    run = await createTestRun(fixture.url);
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await browser.close();
    await fixture.close();
    await run.dispose();
  }, BROWSER_TIMEOUT_MS);

  async function readJson(ref: EvidenceRef): Promise<unknown> {
    return JSON.parse(await readFile(run.ctx.evidence.resolve(ref), 'utf8'));
  }

  /** The screen of `file` as the crawler captures it: at the first of the viewports. */
  async function open(
    ipage: InstrumentedPage,
    file: string,
    viewports: readonly [Viewport, ...Viewport[]],
  ): Promise<LensContext> {
    const [{ width, height }] = viewports;
    await ipage.page.setViewportSize({ width, height });
    await ipage.page.goto(`${fixture.url}/${file}`);
    return lensContextFor(ipage, run.ctx, { viewports });
  }

  describe('on ring.html at desktop and mobile', () => {
    let ipage: InstrumentedPage;
    let context: LensContext;
    let result: LensResult;

    beforeAll(async () => {
      ipage = await browser.newPage();
      context = await open(ipage, 'states/ring.html', [DESKTOP, MOBILE]);
      result = await new InteractionLens().inspect(context);
    }, BROWSER_TIMEOUT_MS);

    afterAll(async () => {
      await ipage.close();
    });

    test('reports the missing and the faint focus ring, and keeps the missing hover states apart', () => {
      expect(ruleAndSelector(result.findings)).toEqual([
        ['interaction.focus-visible-missing', '#none'],
        ['interaction.focus-indicator-contrast', '#faint'],
      ]);
      expect(ruleAndSelector(result.worthALook)).toEqual([
        ['interaction.hover-state-missing', '#nohover'],
        ['interaction.hover-state-missing', '#link-bare'],
      ]);
    });

    test('writes the gallery once, with every control in its states and the focus order of the Tab walk', async () => {
      if (result.gallery === null) throw new Error('expected a gallery');
      expect(result.gallery.kind).toBe('json');
      expect(result.gallery.path).toMatch(/^evidence\/gallery-screen-1-[0-9a-f]{16}\.json$/);

      const gallery = (await readJson(result.gallery)) as StateGallery;

      expect(gallery).toMatchObject({ screenId: 'screen-1', viewport: DESKTOP });
      expect(gallery.entries.map((entry) => entry.selector)).toEqual(
        context.screen.elements.map((element) => element.selector),
      );
      expect(gallery.focusOrder.map((stop) => stop.selector)).toEqual(
        context.screen.elements.filter((element) => element.focusable).map((element) => element.selector),
      );
    });

    test('merges what each step left out, keeping their reasons apart', () => {
      expect(result.skipped).toEqual([
        // The states step's: the browser's own focus ring is not judged for contrast.
        { reason: 'focus-indicator-ua-ring', count: 9 },
        // The static step's: the disabled button's text is exempt from contrast.
        { reason: 'disabled', count: 1 },
      ]);
    });

    test('leaves the page at the first viewport', () => {
      expect(ipage.page.viewportSize()).toEqual({ width: DESKTOP.width, height: DESKTOP.height });
    });
  });

  describe('after the Tab walk, with no further viewport to reload the page at', () => {
    /** Where focus and the scroll position are once the lens has inspected `file` at `viewport` alone. */
    async function leftBehind(
      file: string,
      viewport: Viewport,
    ): Promise<{ active: string; scrollY: number }> {
      const ipage = await browser.newPage();
      try {
        await new InteractionLens().inspect(await open(ipage, file, [viewport]));
        return await ipage.page.evaluate(() => ({
          active: document.activeElement?.localName ?? 'none',
          scrollY: window.scrollY,
        }));
      } finally {
        await ipage.close();
      }
    }

    test('scrolls back to the top of a page the walk scrolled down', async () => {
      expect(await leftBehind('states/ring.html', SHORT)).toEqual({ active: 'body', scrollY: 0 });
    });

    test('moves focus off the control the walk was stuck on', async () => {
      expect(await leftBehind('tab/trap.html', DESKTOP)).toEqual({ active: 'body', scrollY: 0 });
    });
  });

  test('on busy.html, stops at the deadline: the steps after it are skipped whole', async () => {
    const ipage = await browser.newPage();
    try {
      // Building the screen waits out the spin that follows the load; a second one starts as the lens does.
      const base = await open(ipage, 'viewports/busy.html', [DESKTOP, MOBILE]);
      await ipage.page.evaluate(() => (window as unknown as { spinSoon(): void }).spinSoon());
      const started = performance.now();

      const result = await new InteractionLens().inspect({ ...base, deadline: started + BUSY_DEADLINE_MS });

      expect(performance.now() - started).toBeLessThan(BUSY_RETURNS_WITHIN_MS);
      expect(result.findings).toEqual([]);
      expect(result.worthALook).toEqual([]);
      expect(result.skipped).toEqual([
        // The states step had started: it stops itself, before its first control.
        { reason: 'time-budget', count: base.screen.elements.length },
        { reason: 'time-budget:static', count: 1 },
        { reason: 'time-budget:tab-walk', count: 1 },
        { reason: 'time-budget:viewports', count: 1 },
      ]);
      if (result.gallery === null) throw new Error('expected a gallery');
      expect(await readJson(result.gallery)).toMatchObject({ entries: [], focusOrder: [] });
    } finally {
      await ipage.close();
    }
  });
});
