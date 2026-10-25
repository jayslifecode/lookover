import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Finding } from '@jayslifecode/lookover-core';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { E2E_OUTPUT_DIR } from './bench-env.js';
import {
  describeStats,
  FRAME_BUDGET_MS,
  FRAME_HARD_LIMIT_MS,
  FRAMES_OVER_BUDGET_ALLOWED,
  type FrameSample,
  type FrameStats,
  frameStats,
  roundedMs,
  sampleFrames,
} from './frames.js';
import { differingPixels } from './pixels.js';
import {
  closeReports,
  firstPinned,
  firstScreen,
  goTo,
  NO_PAGE_PROBLEMS,
  type OpenOptions,
  openReport,
  panel,
  panelHeading,
  pinOf,
  REPORT_VIEWPORT,
  type ReportPage,
  type ServedFixture,
  screenRoute,
  serveFixture,
  waitForPins,
} from './report-page.js';

/*
 * How the report moves (spec §11, "Smoothness rules"): its frame budget at 1440×900 with the three glass
 * layers on screen (the top bar, the finding panel and a toast), during three travels of the view
 * switcher's pill across all its tabs and one pin → panel container transform; that the panel's top band
 * refracts the page behind it; and that reduced motion and reduced transparency leave no glass blurred
 * and, under reduced motion, nothing animating. The measured frames are written to `.e2e/frames.json`,
 * which CI keeps.
 */

/** The spec's baseline, from the v10 motion study at 1440×900 (Playwright, rAF frame times). */
const BASELINE = { averageMs: 16.67, maxMs: 18.7 } as const;
const FRAMES_FILE = join(E2E_OUTPUT_DIR, 'frames.json');
/** Screens → Drift → Screens → Drift: three travels from one end of the switcher to the other. */
const PILL_TRAVELS: readonly string[] = ['Drift', 'Screens', 'Drift'];
/** The spec's pill settles within ~650 ms (its trail edge); this leaves it room. */
const PILL_SETTLE_MS = 800;
/** The 560 ms grow, the 150 ms fade of the ghost, and room to spare. */
const TRANSFORM_SETTLE_MS = 900;
/** Lets the first render, the fonts and the screenshot settle before anything is measured. */
const SETTLE_MS = 500;
/** An interaction sampled over fewer frames than this measured nothing. */
const MIN_SAMPLED_FRAMES = 20;
const GLASS_SELECTOR = '[data-glass]';
const MAX_GLASS_LAYERS = 3;
const REDUCED_TRANSPARENCY = '(prefers-reduced-transparency: reduce)';
/** The report's `LENS_FILTER_ID`: the SVG filter the panel's top band refracts through. */
const LENS_FILTER_ID = 'lens';
const LENS_FILTER = new RegExp(`url\\(.*#${LENS_FILTER_ID}.*\\)`);
/** Black and white stripes 64 px wide behind everything: what a refraction would bend. */
const STRIPES =
  'body { background: repeating-linear-gradient(90deg, #000 0 64px, #fff 64px 128px) !important; }';
/** The band's tint and the sheen over it soften what it shows: the probe looks at its backdrop alone. */
const BARE_BAND =
  '.glass-lens-band { background: none !important; } .glass::before { display: none !important; }';
/** The band's height inside the panel's 1 px border, less a pixel of its rounded corners' edge. */
const BAND_HEIGHT_PX = 38;
/** A pixel a bent stripe edge moved across flips between black and white: far more than this. */
const FLIP_TOLERANCE = 128;
/** The band covers six stripe edges on 38 rows, each bent by about a pixel: hundreds of flips, not tens. */
const MIN_FLIPPED_PIXELS = 50;

/**
 * A glass surface as the browser computed it: the backdrop filters it draws, on itself or on a layer of
 * its own (the lens look's frosted body, `::after`, and its band, `[data-glass-band]`), each shown.
 */
interface GlassStyle {
  readonly look: string;
  readonly filters: readonly string[];
}

/** One measured interaction, as frames.json records it. */
interface MeasuredInteraction extends FrameStats {
  /** The glass surfaces on screen when it started. */
  readonly glassLayers: number;
  readonly deltasMs: readonly number[];
}

let browser: Browser;
let served: ServedFixture;
let opened: readonly ReportPage[] = [];

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

beforeEach(async () => {
  served = await serveFixture('lookover-e2e-motion-');
});

afterEach(async () => {
  const problems = await closeReports(opened, served.origin);
  opened = [];
  await served.close();
  expect(problems).toEqual(NO_PAGE_PROBLEMS);
});

async function open(options: OpenOptions = {}): Promise<ReportPage> {
  const report = await openReport(browser, served, options);
  opened = [...opened, report];
  return report;
}

function glassStyles(page: Page): Promise<GlassStyle[]> {
  return page.locator(GLASS_SELECTOR).evaluateAll((elements) =>
    elements.map((element) => {
      const shown = (style: CSSStyleDeclaration) =>
        style.display === 'none' || style.backdropFilter === 'none' ? [] : [style.backdropFilter];
      const body = getComputedStyle(element, '::after');
      const band = element.querySelector(':scope > [data-glass-band]');
      return {
        look: element.getAttribute('data-glass') ?? '',
        filters: [
          ...shown(getComputedStyle(element)),
          ...(body.content === 'none' ? [] : shown(body)),
          ...(band === null ? [] : shown(getComputedStyle(band))),
        ],
      };
    }),
  );
}

/** Two frames: a style just added has been applied and painted. */
function nextPaint(page: Page): Promise<void> {
  return page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

/** A screenshot of `clip` with the panel's band filtering through `filter` instead of its own. */
async function bandShot(
  page: Page,
  filter: string,
  clip: { x: number; y: number; width: number; height: number },
) {
  const override = await page.addStyleTag({
    content: `.glass-lens-band { -webkit-backdrop-filter: ${filter} !important; backdrop-filter: ${filter} !important; }`,
  });
  await nextPaint(page);
  const shot = await page.screenshot({ clip });
  await override.evaluate((element) => element.parentNode?.removeChild(element));
  return shot;
}

/**
 * Puts the toast up (the third glass layer) by copying the finding's fix prompt, then leaves the panel on
 * the run's summary again, so the next choice of the pin grows the panel out of it.
 */
async function showToast(page: Page, finding: Finding): Promise<void> {
  const screenId = firstScreen(served.map).id;
  await goTo(page, screenRoute(screenId, finding.id));
  await panel(page).getByRole('button', { name: 'Copy fix prompt' }).click();
  await page.getByText('Fix prompt copied', { exact: true }).waitFor();
  await goTo(page, screenRoute(screenId));
  await panelHeading(page).filter({ hasText: 'Run summary' }).waitFor();
}

async function measured(page: Page, interaction: () => Promise<void>): Promise<MeasuredInteraction> {
  const glassLayers = await page.locator(GLASS_SELECTOR).count();
  const { deltasMs }: FrameSample = await sampleFrames(page, interaction);
  return { ...frameStats(deltasMs), glassLayers, deltasMs: deltasMs.map(roundedMs) };
}

async function writeFrames(interactions: Readonly<Record<string, MeasuredInteraction>>): Promise<void> {
  const record = {
    measuredAt: new Date().toISOString(),
    browser: `chromium ${browser.version()}`,
    viewport: REPORT_VIEWPORT,
    budgetMs: FRAME_BUDGET_MS,
    hardLimitMs: FRAME_HARD_LIMIT_MS,
    framesOverBudgetAllowed: FRAMES_OVER_BUDGET_ALLOWED,
    baseline: BASELINE,
    interactions,
  };
  await mkdir(E2E_OUTPUT_DIR, { recursive: true });
  await writeFile(FRAMES_FILE, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

describe('the report in motion, at 1440×900', () => {
  test('holds the frame budget through three pill travels and a pin-to-panel transform', async () => {
    const { page } = await open({ canUseClipboard: true });
    const finding = firstPinned(served);
    await waitForPins(page);
    await showToast(page, finding);
    await page.waitForTimeout(SETTLE_MS);

    const pillTravel = await measured(page, async () => {
      for (const tab of PILL_TRAVELS) {
        await page.getByRole('tab', { name: tab }).click();
        await page.waitForTimeout(PILL_SETTLE_MS);
      }
    });
    await page.getByRole('tab', { name: 'Screens' }).click();
    await waitForPins(page);
    await showToast(page, finding);
    await page.waitForTimeout(SETTLE_MS);
    const pinToPanel = await measured(page, async () => {
      await pinOf(page, finding).click();
      await page.waitForTimeout(TRANSFORM_SETTLE_MS);
    });
    const interactions = { 'pill-travel': pillTravel, 'pin-to-panel': pinToPanel };
    // Written before anything is asserted, so a run over budget still leaves its numbers for CI.
    await writeFrames(interactions);
    for (const [name, stats] of Object.entries(interactions)) {
      process.stdout.write(`${describeStats(name, stats)} (${stats.glassLayers} glass layers)\n`);
    }
    const glass = await glassStyles(page);

    expect(await panelHeading(page).textContent()).toBe(finding.title);
    expect(pinToPanel.glassLayers).toBe(MAX_GLASS_LAYERS);
    // Measured with the glass as it looks: every surface filters the page behind it, and one (the panel)
    // through #lens as well, along its top edge (the next test shows that band bending the page).
    expect(glass.filter(({ filters }) => filters.length === 0)).toEqual([]);
    expect(glass.filter(({ filters }) => filters.some((filter) => LENS_FILTER.test(filter)))).toHaveLength(1);
    for (const [name, stats] of Object.entries(interactions)) {
      expect(stats.frames, name).toBeGreaterThan(MIN_SAMPLED_FRAMES);
      expect(stats.overBudget, `${name}: frames over ${FRAME_BUDGET_MS} ms`).toBeLessThanOrEqual(
        FRAMES_OVER_BUDGET_ALLOWED,
      );
      expect(stats.overHardLimit, `${name}: frames over ${FRAME_HARD_LIMIT_MS} ms`).toBe(0);
    }
  });

  test("the panel's top band bends the page behind it, not the frosted layer's own picture", async () => {
    const { context, page } = await open();
    await waitForPins(page);
    await page.addStyleTag({ content: `${STRIPES} ${BARE_BAND}` });
    await page.mouse.move(0, 0);
    const box = await panel(page).boundingBox();
    if (box === null) throw new Error('The finding panel is not laid out');
    const band = { x: box.x + 1, y: box.y + 1, width: box.width - 2, height: BAND_HEIGHT_PX };

    const bent = await bandShot(page, `url(#${LENS_FILTER_ID})`, band);
    const straight = await bandShot(page, 'none', band);
    const straightAgain = await bandShot(page, 'none', band);
    const comparer = await context.newPage();
    const flipped = await differingPixels(comparer, bent, straight, FLIP_TOLERANCE);
    const noise = await differingPixels(comparer, straight, straightAgain, 0);
    process.stdout.write(`lens band: ${flipped} of ${band.width * band.height} pixels flipped by #lens\n`);

    // Through #lens alone the band shows the sharp stripes bent, so pixels by their edges flip between black
    // and white: the band filters the page itself. Were it inside the frosted layer's backdrop root, it
    // would see only that layer's blurred picture, and nothing would flip. (The band's own filter blurs
    // and saturates before it displaces, as the whole panel's did, so on screen the bend is soft.)
    expect(flipped).toBeGreaterThan(MIN_FLIPPED_PIXELS);
    expect(noise).toBe(0);
  });

  test('under reduced motion no glass is blurred and nothing animates, a choice of pin included', async () => {
    const { page } = await open({ contextOptions: { reducedMotion: 'reduce' } });
    const finding = firstPinned(served);
    await waitForPins(page);
    const glass = await glassStyles(page);

    const { animations } = await sampleFrames(
      page,
      async () => {
        await pinOf(page, finding).click();
        await panelHeading(page).filter({ hasText: finding.title }).waitFor();
        await page.waitForTimeout(TRANSFORM_SETTLE_MS);
      },
      { countAnimations: true },
    );

    expect(glass.length).toBeGreaterThan(0);
    expect(glass.filter(({ filters }) => filters.length > 0)).toEqual([]);
    expect(animations.length).toBeGreaterThan(MIN_SAMPLED_FRAMES);
    expect(animations.filter((count) => count > 0)).toEqual([]);
  });

  test('under reduced transparency every glass surface is solid, the toast included', async () => {
    const { page } = await open({
      canUseClipboard: true,
      // Playwright's emulateMedia has no reduced transparency: Chromium's own emulation does.
      beforeLoad: async (fresh) => {
        const cdp = await fresh.context().newCDPSession(fresh);
        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
        });
      },
    });
    const finding = firstPinned(served);
    await waitForPins(page);
    await showToast(page, finding);
    const glass = await glassStyles(page);

    expect(await page.evaluate((query) => window.matchMedia(query).matches, REDUCED_TRANSPARENCY)).toBe(true);
    expect(glass).toHaveLength(MAX_GLASS_LAYERS);
    expect(glass.filter(({ look, filters }) => look !== 'solid' || filters.length > 0)).toEqual([]);
  });
});
