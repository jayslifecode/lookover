import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type {
  EvidenceRef,
  Finding,
  InstrumentedPage,
  LensContext,
  OccurrenceFinding,
  Viewport,
} from '@jayslifecode/lookover-core';
import {
  type FixtureRoute,
  type FixtureServer,
  redirect,
  serveFixture,
} from '@jayslifecode/lookover-test-support';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { sweepViewports } from '../src/interaction/viewports.js';
import { createTestRun, type LensContextOptions, lensContextFor, type TestRun } from './helpers/context.js';
import { launchTestSession, type TestSession } from './helpers/session.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/viewports', import.meta.url));
const BROWSER_TIMEOUT_MS = 60_000;
const OVERFLOW = 'interaction.horizontal-overflow';
const CLIPPED = 'interaction.text-clipped';
const DESKTOP: Viewport = { name: 'desktop', width: 1440, height: 900 };
const TABLET: Viewport = { name: 'tablet', width: 768, height: 1024 };
const MOBILE: Viewport = { name: 'mobile', width: 390, height: 844 };
/** Set on the page before the sweep: a reload puts the fixture's own title back. */
const MARKED_TITLE = 'marked before the sweep';
/** Where a PNG's IHDR chunk keeps the width. */
const PNG_WIDTH_OFFSET = 16;

function asOccurrence(finding: Finding | undefined): OccurrenceFinding {
  if (finding?.shape !== 'occurrence') throw new Error('expected an occurrence finding');
  return finding;
}

function forRule(findings: readonly Finding[], ruleId: string): OccurrenceFinding {
  return asOccurrence(findings.find((finding) => finding.rule.id === ruleId));
}

/**
 * A route that serves `file` for its first `served` requests and then redirects to `to`: the page a
 * lens reloads lands somewhere else from request `served + 1` on.
 */
function redirectsAfter(served: number, file: string, to: string): FixtureRoute {
  let requests = 0;
  return (_req, res, serveStatic) => {
    requests += 1;
    if (requests <= served) serveStatic(file);
    else redirect(res, to);
  };
}

describe('sweepViewports', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let browser: TestSession;
  let run: TestRun;
  let ipage: InstrumentedPage;

  beforeAll(async () => {
    fixture = await serveFixture(FIXTURE_DIR, {
      // The first load is fine.html; the sweep's reload lands on overflow.html, which must not be measured.
      '/moves-on-reload.html': redirectsAfter(1, '/fine.html', '/overflow.html'),
      // The first load and the reload at 390 px are overflow.html; the reload back at 1440 px lands elsewhere.
      '/moves-on-restore.html': redirectsAfter(2, '/overflow.html', '/fine.html'),
    });
    browser = await launchTestSession(DESKTOP);
    run = await createTestRun(fixture.url);
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await browser.close();
    await fixture.close();
    await run.dispose();
  }, BROWSER_TIMEOUT_MS);

  beforeEach(async () => {
    ipage = await browser.newPage();
  });

  afterEach(async () => {
    await ipage.close();
  });

  /** The screen of `file` captured at the first viewport, its title then marked to tell a reload. */
  async function open(file: string, options: LensContextOptions = {}): Promise<LensContext> {
    await ipage.page.goto(`${fixture.url}/${file}`);
    const context = await lensContextFor(ipage, run.ctx, { viewports: [DESKTOP, MOBILE], ...options });
    await ipage.page.evaluate((title) => {
      document.title = title;
    }, MARKED_TITLE);
    return context;
  }

  async function pngWidth(ref: EvidenceRef): Promise<number> {
    const png = await readFile(run.ctx.evidence.resolve(ref));
    return png.readUInt32BE(PNG_WIDTH_OFFSET);
  }

  describe('on overflow.html', () => {
    test('reports the page scrolling sideways at 390 px, with the banner as the element that overflows', async () => {
      const context = await open('overflow.html');
      const { url } = context.screen;

      const { findings, screenshots, skipped } = await sweepViewports(context);

      expect(findings.map((finding) => finding.rule.id)).toEqual([OVERFLOW, CLIPPED]);
      const overflow = forRule(findings, OVERFLOW);
      expect(overflow).toMatchObject({
        key: '/overflow.html|mobile',
        source: 'interaction',
        severity: 'high',
        status: 'candidate',
        observed: 'the page scrolls sideways at mobile 390×844: it is 600 px wide in a 390 px wide viewport',
      });
      expect(overflow.occurrences).toEqual([
        {
          screenId: 'screen-1',
          route: '/overflow.html',
          url,
          viewport: MOBILE,
          selector: '#banner',
          measured: { right: 600, width: 600, viewportWidth: 390 },
        },
      ]);
      expect(overflow.evidence).toEqual(screenshots);
      expect(skipped).toEqual([]);
    });

    test('reports the caption cut off without an ellipsis, once, at the viewport it was measured at', async () => {
      const context = await open('overflow.html');

      const { findings } = await sweepViewports(context);

      const clipped = forRule(findings, CLIPPED);
      expect(clipped).toMatchObject({
        key: '/overflow.html|mobile|clipped',
        severity: 'medium',
        observed: '1 element cuts its text off without an ellipsis at mobile 390×844',
      });
      expect(clipped.occurrences).toHaveLength(1);
      expect(clipped.occurrences[0]).toMatchObject({
        viewport: MOBILE,
        selector: '#caption',
        measured: {
          text: 'A caption far too long to fit in two hundred pixels on one line',
          clientWidth: 200,
        },
      });
      expect(clipped.occurrences[0]?.measured.scrollWidth).toBeGreaterThan(201);
    });

    test('takes one full-page screenshot at the viewport the findings were raised at', async () => {
      const context = await open('overflow.html');

      const { findings, screenshots } = await sweepViewports(context);

      expect(screenshots.map(({ kind, label }) => [kind, label])).toEqual([['screenshot', 'mobile 390×844']]);
      const [screenshot] = screenshots;
      if (screenshot === undefined) throw new Error('expected a screenshot');
      expect(screenshot.ref.kind).toBe('png');
      // The full page: the 600 px the banner makes it, not just the 390 px viewport.
      expect(await pngWidth(screenshot.ref)).toBe(600);
      expect(forRule(findings, CLIPPED).evidence).toEqual([screenshot]);
    });

    test('leaves the page reloaded at the first viewport', async () => {
      const context = await open('overflow.html');

      await sweepViewports(context);

      expect(ipage.page.viewportSize()).toEqual({ width: DESKTOP.width, height: DESKTOP.height });
      // Loaded again after the resize back: the document was not merely resized from 390 px.
      const loadedAtWidth = await ipage.page.evaluate(() => document.documentElement.dataset.loadedAtWidth);
      expect(loadedAtWidth).toBe(String(DESKTOP.width));
    });
  });

  test('reports nothing on fine.html, whose wide table scrolls inside its own wrapper', async () => {
    const context = await open('fine.html');

    expect(await sweepViewports(context)).toEqual({ findings: [], screenshots: [], skipped: [] });
    expect(ipage.page.viewportSize()).toEqual({ width: DESKTOP.width, height: DESKTOP.height });
  });

  test('names the page when no element overflows: a pseudo-element makes it scroll sideways', async () => {
    const context = await open('pseudo.html');

    const { findings } = await sweepViewports(context);

    expect(findings.map((finding) => finding.rule.id)).toEqual([OVERFLOW]);
    expect(forRule(findings, OVERFLOW).occurrences).toEqual([
      {
        screenId: 'screen-1',
        route: '/pseudo.html',
        url: context.screen.url,
        viewport: MOBILE,
        selector: null,
        measured: { scrollWidth: 600, viewportWidth: 390 },
      },
    ]);
  });

  test('with one viewport there is nothing to sweep, and the page is not reloaded', async () => {
    const context = await open('overflow.html', { viewports: [DESKTOP] });

    expect(await sweepViewports(context)).toEqual({ findings: [], screenshots: [], skipped: [] });
    expect(await ipage.page.title()).toBe(MARKED_TITLE);
  });

  test('past the deadline sweeps no viewport, counts the ones left out and does not reload', async () => {
    const context = await open('overflow.html', {
      viewports: [DESKTOP, TABLET, MOBILE],
      deadline: performance.now(),
    });

    expect(await sweepViewports(context)).toEqual({
      findings: [],
      screenshots: [],
      skipped: [{ reason: 'time-budget', count: 2 }],
    });
    expect(await ipage.page.title()).toBe(MARKED_TITLE);
    expect(ipage.page.viewportSize()).toEqual({ width: DESKTOP.width, height: DESKTOP.height });
  });

  describe('when a reload lands on another URL', () => {
    test('measures nothing there, records the skip for each such reload and restores the first viewport', async () => {
      const context = await open('moves-on-reload.html');

      expect(await sweepViewports(context)).toEqual({
        findings: [],
        screenshots: [],
        // The reload at 390 px, and the one back at 1440 px, which reloads the page it landed on.
        skipped: [{ reason: 'viewport-reload-redirected', count: 2 }],
      });
      expect(ipage.page.viewportSize()).toEqual({ width: DESKTOP.width, height: DESKTOP.height });
    });

    test('keeps what it measured on the screen when only the reload back at the first viewport lands elsewhere', async () => {
      const context = await open('moves-on-restore.html');

      const { findings, skipped } = await sweepViewports(context);

      expect(findings.map((finding) => [finding.rule.id, finding.key])).toEqual([
        [OVERFLOW, '/moves-on-restore.html|mobile'],
        [CLIPPED, '/moves-on-restore.html|mobile|clipped'],
      ]);
      expect(skipped).toEqual([{ reason: 'viewport-reload-redirected', count: 1 }]);
    });
  });
});
