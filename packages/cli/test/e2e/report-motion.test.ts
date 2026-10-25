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
import {
  firstPinned,
  firstScreen,
  goTo,
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
 * switcher's pill across all its tabs and one pin → panel container transform; and that reduced motion
 * and reduced transparency leave no glass blurred and, under reduced motion, nothing animating. The
 * measured frames are written to `.e2e/frames.json`, which CI keeps.
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
/** The panel's edge band refracts through the report's `#lens` SVG filter. */
const LENS_FILTER = /url\(.*#lens.*\)/;

/** A glass surface as the browser computed it: its own backdrop filter, and its refracting edge's. */
interface GlassStyle {
  readonly look: string;
  readonly backdropFilter: string;
  /** `none` when the surface draws no edge band (`::after`) or the band filters nothing. */
  readonly edgeFilter: string;
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
  for (const each of opened) await each.context.close();
  opened = [];
  await served.close();
});

async function open(options: OpenOptions = {}): Promise<ReportPage> {
  const report = await openReport(browser, served, options);
  opened = [...opened, report];
  return report;
}

function glassStyles(page: Page): Promise<GlassStyle[]> {
  return page.locator(GLASS_SELECTOR).evaluateAll((elements) =>
    elements.map((element) => {
      const edge = getComputedStyle(element, '::after');
      const isDrawn = edge.content !== 'none' && edge.display !== 'none';
      return {
        look: element.getAttribute('data-glass') ?? '',
        backdropFilter: getComputedStyle(element).backdropFilter,
        edgeFilter: isDrawn ? edge.backdropFilter : 'none',
      };
    }),
  );
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
    // Measured with the glass as it looks: frosted, and the panel refracting along its edge.
    expect(glass.filter(({ backdropFilter }) => backdropFilter === 'none')).toEqual([]);
    expect(
      glass.filter(({ look, edgeFilter }) => look === 'lens' && LENS_FILTER.test(edgeFilter)),
    ).toHaveLength(1);
    for (const [name, stats] of Object.entries(interactions)) {
      expect(stats.frames, name).toBeGreaterThan(MIN_SAMPLED_FRAMES);
      expect(stats.overBudget, `${name}: frames over ${FRAME_BUDGET_MS} ms`).toBeLessThanOrEqual(
        FRAMES_OVER_BUDGET_ALLOWED,
      );
      expect(stats.overHardLimit, `${name}: frames over ${FRAME_HARD_LIMIT_MS} ms`).toBe(0);
    }
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
    expect(
      glass.filter(({ backdropFilter, edgeFilter }) => backdropFilter !== 'none' || edgeFilter !== 'none'),
    ).toEqual([]);
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
    expect(
      glass.filter(
        ({ look, backdropFilter, edgeFilter }) =>
          look !== 'solid' || backdropFilter !== 'none' || edgeFilter !== 'none',
      ),
    ).toEqual([]);
  });
});
