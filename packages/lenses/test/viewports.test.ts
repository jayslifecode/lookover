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
const REDIRECTED = 'viewport-reload-redirected';
const RELOAD_FAILED = 'viewport-reload-failed';
/** Short, so a reload the fixture never answers fails in well under the test's own timeout. */
const SHORT_RELOAD_TIMEOUT_MS = 500;
const DESKTOP: Viewport = { name: 'desktop', width: 1440, height: 900 };
const TABLET: Viewport = { name: 'tablet', width: 768, height: 1024 };
const MOBILE: Viewport = { name: 'mobile', width: 390, height: 844 };
/** Set on the page before the sweep: a reload puts the fixture's own title back. */
const MARKED_TITLE = 'marked before the sweep';
const CAPTION = 'A caption far too long to fit in two hundred pixels on one line';
/** Where a PNG's IHDR chunk keeps the width. */
const PNG_WIDTH_OFFSET = 16;

function asOccurrence(finding: Finding | undefined): OccurrenceFinding {
  if (finding?.shape !== 'occurrence') throw new Error('expected an occurrence finding');
  return finding;
}

function withKey(findings: readonly Finding[], key: string): OccurrenceFinding {
  return asOccurrence(findings.find((finding) => finding.key === key));
}

function rulesAndKeys(findings: readonly Finding[]): [string, string][] {
  return findings.map((finding) => [finding.rule.id, finding.key]);
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

/** A route that serves `file` for its first `served` requests and never answers after that. */
function hangsAfter(served: number, file: string): { route: FixtureRoute; requests: () => number } {
  let requests = 0;
  return {
    route: (_req, _res, serveStatic) => {
      requests += 1;
      if (requests <= served) serveStatic(file);
    },
    requests: () => requests,
  };
}

describe('sweepViewports', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let browser: TestSession;
  let run: TestRun;
  let ipage: InstrumentedPage;
  // The first load is overflow.html; the sweep's first reload never gets an answer.
  const hangsOnReload = hangsAfter(1, '/overflow.html');
  // The first load and the reload at 390 px are overflow.html; the reload back at 1440 px never gets one.
  const hangsOnRestore = hangsAfter(2, '/overflow.html');

  beforeAll(async () => {
    fixture = await serveFixture(FIXTURE_DIR, {
      '/hangs-on-reload.html': hangsOnReload.route,
      '/hangs-on-restore.html': hangsOnRestore.route,
      // The first load is fine.html; the sweep's first reload lands on overflow.html, which must not be measured.
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

  /** The width the document now in the page was loaded at (overflow.html records it). */
  function loadedAtWidth(): Promise<string | undefined> {
    return ipage.page.evaluate(() => document.documentElement.dataset.loadedAtWidth);
  }

  describe('on overflow.html', () => {
    test('measures the capture viewport as it is, then each further one reloaded', async () => {
      const context = await open('overflow.html');

      const { findings, skipped } = await sweepViewports(context);

      expect(rulesAndKeys(findings)).toEqual([
        [CLIPPED, '/overflow.html|desktop|clipped'],
        [OVERFLOW, '/overflow.html|mobile'],
        [CLIPPED, '/overflow.html|mobile|clipped'],
      ]);
      expect(skipped).toEqual([]);
    });

    test('reports the page scrolling sideways at 390 px, with the banner as the element that overflows', async () => {
      const context = await open('overflow.html');
      const { url } = context.screen;

      const { findings } = await sweepViewports(context);

      const overflow = withKey(findings, '/overflow.html|mobile');
      expect(overflow).toMatchObject({
        rule: { id: OVERFLOW },
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
    });

    test('reports the caption cut off without an ellipsis at each viewport, as the viewport it was measured at', async () => {
      const context = await open('overflow.html');

      const { findings } = await sweepViewports(context);

      for (const viewport of [DESKTOP, MOBILE]) {
        const clipped = withKey(findings, `/overflow.html|${viewport.name}|clipped`);
        const label = `${viewport.name} ${viewport.width}×${viewport.height}`;
        expect(clipped).toMatchObject({
          rule: { id: CLIPPED },
          severity: 'medium',
          observed: `1 element cuts its text off without an ellipsis at ${label}`,
        });
        expect(clipped.occurrences).toHaveLength(1);
        expect(clipped.occurrences[0]).toMatchObject({
          viewport,
          selector: '#caption',
          measured: { text: CAPTION, clientWidth: 200 },
        });
        expect(clipped.occurrences[0]?.measured.scrollWidth).toBeGreaterThan(201);
      }
    });

    test('takes one full-page screenshot at each viewport that raised a finding, as their evidence', async () => {
      const context = await open('overflow.html');

      const { findings, screenshots } = await sweepViewports(context);

      expect(screenshots.map(({ kind, label }) => [kind, label])).toEqual([
        ['screenshot', 'desktop 1440×900'],
        ['screenshot', 'mobile 390×844'],
      ]);
      const [atDesktop, atMobile] = screenshots;
      if (atDesktop === undefined || atMobile === undefined) throw new Error('expected two screenshots');
      expect(await pngWidth(atDesktop.ref)).toBe(DESKTOP.width);
      // The full page: the 600 px the banner makes it, not just the 390 px viewport.
      expect(await pngWidth(atMobile.ref)).toBe(600);
      expect(findings.map((finding) => finding.evidence)).toEqual([[atDesktop], [atMobile], [atMobile]]);
    });

    test('leaves the page reloaded at the first viewport', async () => {
      const context = await open('overflow.html');

      await sweepViewports(context);

      expect(ipage.page.viewportSize()).toEqual({ width: DESKTOP.width, height: DESKTOP.height });
      // Loaded again after the resize back: the document was not merely resized from 390 px.
      expect(await loadedAtWidth()).toBe(String(DESKTOP.width));
    });
  });

  test('reports nothing on fine.html, whose wide table scrolls inside its own wrapper', async () => {
    const context = await open('fine.html');

    expect(await sweepViewports(context)).toEqual({ findings: [], screenshots: [], skipped: [] });
    expect(ipage.page.viewportSize()).toEqual({ width: DESKTOP.width, height: DESKTOP.height });
  });

  test('reports text cut off only at the capture viewport, where the caption sits in a narrow column', async () => {
    const context = await open('clipped-desktop.html');

    const { findings } = await sweepViewports(context);

    expect(rulesAndKeys(findings)).toEqual([[CLIPPED, '/clipped-desktop.html|desktop|clipped']]);
    expect(withKey(findings, '/clipped-desktop.html|desktop|clipped').occurrences[0]).toMatchObject({
      viewport: DESKTOP,
      selector: '#caption',
    });
  });

  test('names the page when no element overflows: a pseudo-element makes it scroll sideways', async () => {
    const context = await open('pseudo.html');

    const { findings } = await sweepViewports(context);

    expect(rulesAndKeys(findings)).toEqual([[OVERFLOW, '/pseudo.html|mobile']]);
    expect(withKey(findings, '/pseudo.html|mobile').occurrences).toEqual([
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

  test('with one viewport, measures it as it is and does not reload the page', async () => {
    const context = await open('overflow.html', { viewports: [DESKTOP] });

    const { findings, skipped } = await sweepViewports(context);

    expect(rulesAndKeys(findings)).toEqual([[CLIPPED, '/overflow.html|desktop|clipped']]);
    expect(skipped).toEqual([]);
    expect(await ipage.page.title()).toBe(MARKED_TITLE);
  });

  test('past the deadline measures no viewport, counts every one left out and does not reload', async () => {
    const context = await open('overflow.html', {
      viewports: [DESKTOP, TABLET, MOBILE],
      deadline: performance.now(),
    });

    expect(await sweepViewports(context)).toEqual({
      findings: [],
      screenshots: [],
      skipped: [{ reason: 'time-budget', count: 3 }],
    });
    expect(await ipage.page.title()).toBe(MARKED_TITLE);
    expect(ipage.page.viewportSize()).toEqual({ width: DESKTOP.width, height: DESKTOP.height });
  });

  describe('when the page leaves the screen URL', () => {
    test('stops at the first reload that lands elsewhere: no measurement, no reload after, the size restored', async () => {
      const context = await open('moves-on-reload.html', { viewports: [DESKTOP, TABLET, MOBILE] });

      expect(await sweepViewports(context)).toEqual({
        findings: [],
        screenshots: [],
        // The tablet reload landed on overflow.html; neither it nor the mobile viewport was measured.
        skipped: [{ reason: REDIRECTED, count: 2 }],
      });
      expect(ipage.page.viewportSize()).toEqual({ width: DESKTOP.width, height: DESKTOP.height });
      // Still the document the tablet reload landed on: the URL it moved to was never requested again.
      expect(new URL(ipage.page.url()).pathname).toBe('/overflow.html');
      expect(await loadedAtWidth()).toBe(String(TABLET.width));
    });

    test('keeps what it measured on the screen when only the reload back at the first viewport lands elsewhere', async () => {
      const context = await open('moves-on-restore.html');

      const { findings, skipped } = await sweepViewports(context);

      expect(rulesAndKeys(findings)).toEqual([
        [CLIPPED, '/moves-on-restore.html|desktop|clipped'],
        [OVERFLOW, '/moves-on-restore.html|mobile'],
        [CLIPPED, '/moves-on-restore.html|mobile|clipped'],
      ]);
      expect(skipped).toEqual([{ reason: REDIRECTED, count: 1 }]);
    });

    test('drops what it measured when the URL changed in the page before the measurement was done', async () => {
      const context = await open('overflow.html');
      // A client-side route change: the document stays, its URL does not.
      await ipage.page.evaluate(() => history.replaceState(null, '', '/elsewhere.html'));

      expect(await sweepViewports(context)).toEqual({
        findings: [],
        screenshots: [],
        // The capture viewport's caption was measured and dropped; the mobile viewport was not reloaded.
        skipped: [{ reason: REDIRECTED, count: 2 }],
      });
      expect(await ipage.page.title()).toBe(MARKED_TITLE);
    });
  });

  describe('when a reload fails', () => {
    test('keeps what it measured, counts the viewports left unmeasured and restores the size without a reload', async () => {
      const context = await open('hangs-on-reload.html', { viewports: [DESKTOP, TABLET, MOBILE] });

      const { findings, skipped } = await sweepViewports(context, {
        reloadTimeoutMs: SHORT_RELOAD_TIMEOUT_MS,
      });

      expect(rulesAndKeys(findings)).toEqual([[CLIPPED, '/hangs-on-reload.html|desktop|clipped']]);
      // The tablet reload never got an answer; neither it nor the mobile viewport was measured.
      expect(skipped).toEqual([{ reason: RELOAD_FAILED, count: 2 }]);
      expect(ipage.page.viewportSize()).toEqual({ width: DESKTOP.width, height: DESKTOP.height });
      // The first load and the one reload that failed: the page was not reloaded again to restore it.
      expect(hangsOnReload.requests()).toBe(2);
    });

    test('keeps every viewport it measured when only the reload back at the first viewport fails', async () => {
      const context = await open('hangs-on-restore.html');

      const { findings, skipped } = await sweepViewports(context, {
        reloadTimeoutMs: SHORT_RELOAD_TIMEOUT_MS,
      });

      expect(rulesAndKeys(findings)).toEqual([
        [CLIPPED, '/hangs-on-restore.html|desktop|clipped'],
        [OVERFLOW, '/hangs-on-restore.html|mobile'],
        [CLIPPED, '/hangs-on-restore.html|mobile|clipped'],
      ]);
      expect(skipped).toEqual([{ reason: RELOAD_FAILED, count: 1 }]);
      expect(ipage.page.viewportSize()).toEqual({ width: DESKTOP.width, height: DESKTOP.height });
    });
  });
});
