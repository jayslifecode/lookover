import {
  type EvidenceItem,
  type Finding,
  type LensContext,
  type LensSkip,
  normaliseUrl,
  type Occurrence,
  type OccurrenceFindingInput,
  occurrenceFinding,
  type SelectorCandidate,
  stableSelector,
  stopLoading,
  type Viewport,
} from '@jayslifecode/lookover-core';
import { ruleById } from '@jayslifecode/lookover-rules';
import { MEASURE_OVERFLOW_SOURCE, type OverflowMeasure } from './in-page.js';
import { evaluateSource } from './measure.js';
import { tally } from './skips.js';
import { FINISH_ALL_TRANSITIONS_SOURCE } from './states-in-page.js';

const OVERFLOW_RULE = ruleById('interaction.horizontal-overflow');
const CLIPPED_RULE = ruleById('interaction.text-clipped');

/** A page wider than its viewport by no more than this is rounding, not overflow. */
const OVERFLOW_TOLERANCE_PX = 1;
const FONTS_READY_TIMEOUT_MS = 2_000;
/** As long as the crawler gives a navigation by default. */
export const RELOAD_TIMEOUT_MS = 15_000;
const SKIP_TIME_BUDGET = 'time-budget';
/** A reload that landed on another URL: what it shows is not the screen. */
const SKIP_REDIRECTED = 'viewport-reload-redirected';
/**
 * A reload that threw (it timed out, or the document failed to load): there is nothing to measure. Its
 * message is dropped; the request observer records the failed document itself.
 */
const SKIP_RELOAD_FAILED = 'viewport-reload-failed';
/** Waits, in the page, until its fonts have loaded: text set in a fallback font is measured too narrow. */
const FONTS_READY_SOURCE = '() => document.fonts.ready.then(() => undefined)';

export interface SweepOptions {
  /** How long each reload may take; `RELOAD_TIMEOUT_MS` by default. */
  reloadTimeoutMs?: number;
}

export interface SweepResult {
  findings: Finding[];
  /** The full-page screenshots taken, one for each viewport that raised a finding. */
  screenshots: EvidenceItem[];
  skipped: LensSkip[];
}

/** A finding at one viewport, before its screenshot is taken. */
type Draft = Omit<OccurrenceFindingInput, 'evidence'>;

const NOTHING: SweepResult = { findings: [], screenshots: [], skipped: [] };

/** What putting the first viewport back takes once the sweep is over. */
type Restore = 'nothing' | 'resize' | 'reload';
/** How a reload went: on the screen's URL, landed elsewhere, or threw. */
type Reloaded = 'on-screen' | 'redirected' | 'failed';

interface Swept {
  result: SweepResult;
  restore: Restore;
}

/**
 * Measures the screen's horizontal overflow (`MEASURE_OVERFLOW_SOURCE`) at each viewport: at the first
 * (the one it was captured at) as the page is, at each further one reloaded at that size; each time once
 * its fonts are ready (at most 2 s) and its transitions have finished:
 *
 * - `interaction.horizontal-overflow` when the page is wider than the viewport (`scrollWidth >
 *   clientWidth + 1`): one finding for the viewport (key `${route}|${viewport.name}`), with an
 *   occurrence for each element that reaches past it, or one for the page when no element's box does
 *   (a pseudo-element, say).
 * - `interaction.text-clipped`: one finding for the viewport (key `${route}|${viewport.name}|clipped`),
 *   with an occurrence for each element that cuts its own text off without an ellipsis.
 *
 * Both carry a full-page screenshot taken at that viewport. `context.deadline` is checked before each
 * viewport; the ones not reached are counted (`time-budget`). When the page was reloaded at a further
 * viewport, the first one is restored and the page reloaded at it, so whatever measures next finds it as
 * it was captured.
 *
 * The page is only ever measured, and reloaded, at the screen's own URL. Once it is not there any more,
 * after a reload (a redirect: the session expired, the screen moved) or by the end of a measurement (a
 * client-side route change), what it shows is dropped, and that viewport and every one after it count as
 * `viewport-reload-redirected`; only the first viewport's size is put back, and the page is not reloaded
 * again. A reload that throws (it takes longer than `options.reloadTimeoutMs`, 15 s by default, or the
 * document fails to load) ends the sweep the same way, counted as `viewport-reload-failed`, and what was
 * measured before it is kept. The reload back at the first viewport is checked the same way.
 */
export async function sweepViewports(context: LensContext, options: SweepOptions = {}): Promise<SweepResult> {
  const [first] = context.viewports;
  if (first === undefined) return NOTHING;
  const timeoutMs = options.reloadTimeoutMs ?? RELOAD_TIMEOUT_MS;
  const { result, restore } = await sweepEach(context, timeoutMs);
  const restored = await restoreFirst(context, first, restore, timeoutMs);
  return { ...result, skipped: tally([...result.skipped, ...restored]) };
}

async function sweepEach(context: LensContext, timeoutMs: number): Promise<Swept> {
  const { viewports } = context;
  let result = NOTHING;
  for (const [index, viewport] of viewports.entries()) {
    const left = viewports.length - index;
    if (performance.now() >= context.deadline) {
      return { result: withSkip(result, SKIP_TIME_BUDGET, left), restore: index > 1 ? 'reload' : 'nothing' };
    }
    const reloaded = index === 0 ? 'on-screen' : await reloadAt(context, viewport, timeoutMs);
    if (reloaded === 'failed')
      return { result: withSkip(result, SKIP_RELOAD_FAILED, left), restore: 'resize' };
    const measured = reloaded === 'on-screen' ? await measureAt(context, viewport) : null;
    if (measured === null) return { result: withSkip(result, SKIP_REDIRECTED, left), restore: 'resize' };
    result = merge(result, measured);
  }
  return { result, restore: viewports.length > 1 ? 'reload' : 'nothing' };
}

/** Puts the first viewport back; the skip of a reload back that landed elsewhere or threw. */
async function restoreFirst(
  context: LensContext,
  first: Viewport,
  restore: Restore,
  timeoutMs: number,
): Promise<LensSkip[]> {
  if (restore === 'nothing') return [];
  if (restore === 'resize') {
    await context.ipage.page.setViewportSize(sizeOf(first));
    return [];
  }
  const reloaded = await reloadAt(context, first, timeoutMs);
  if (reloaded === 'failed') return [{ reason: SKIP_RELOAD_FAILED, count: 1 }];
  return reloaded === 'redirected' ? [{ reason: SKIP_REDIRECTED, count: 1 }] : [];
}

/**
 * Resizes the page and reloads it: `redirected` when the reload landed on a URL other than the
 * screen's, `failed` when it threw (the size stays the one asked for). A failed reload's navigation is
 * stopped, so the page can be resized again (see `stopLoading`).
 */
async function reloadAt(context: LensContext, viewport: Viewport, timeoutMs: number): Promise<Reloaded> {
  const { page, cdp } = context.ipage;
  await page.setViewportSize(sizeOf(viewport));
  try {
    await page.reload({ waitUntil: 'load', timeout: timeoutMs });
  } catch {
    // Why it failed is the page's business; the request observer records the failed document.
    await stopLoading(cdp);
    return 'failed';
  }
  return isSameScreenUrl(page.url(), context.screen.url) ? 'on-screen' : 'redirected';
}

/** The same URL once both are normalised: a trailing slash and the hash do not count. */
function isSameScreenUrl(landed: string, screenUrl: string): boolean {
  const base = new URL(screenUrl);
  const expected = normaliseUrl(screenUrl, base);
  return expected !== null && normaliseUrl(landed, base)?.href === expected.href;
}

function sizeOf({ width, height }: Viewport): { width: number; height: number } {
  return { width, height };
}

/** The findings at `viewport` as the page is now; `null` when, measured, it is not at the screen's URL. */
async function measureAt(context: LensContext, viewport: Viewport): Promise<SweepResult | null> {
  const { page } = context.ipage;
  await atMost(FONTS_READY_TIMEOUT_MS, evaluateSource(page, FONTS_READY_SOURCE));
  await evaluateSource(page, FINISH_ALL_TRANSITIONS_SOURCE);
  const measure = await evaluateSource<OverflowMeasure>(page, MEASURE_OVERFLOW_SOURCE);
  if (!isSameScreenUrl(page.url(), context.screen.url)) return null;
  const drafts = [overflowDraft(context, viewport, measure), clippedDraft(context, viewport, measure)].filter(
    (draft): draft is Draft => draft !== null,
  );
  if (drafts.length === 0) return NOTHING;
  const screenshot = await fullPageScreenshot(context, viewport);
  return {
    findings: drafts.map((draft) => occurrenceFinding({ ...draft, evidence: [screenshot] })),
    screenshots: [screenshot],
    skipped: [],
  };
}

function overflowDraft(context: LensContext, viewport: Viewport, measure: OverflowMeasure): Draft | null {
  const { scrollWidth, clientWidth, offenders } = measure;
  if (scrollWidth <= clientWidth + OVERFLOW_TOLERANCE_PX) return null;
  const occurrences =
    offenders.length === 0
      ? [occurrenceAt(context, viewport, null, { scrollWidth, viewportWidth: clientWidth })]
      : offenders.map(({ selector, right, width }) =>
          occurrenceAt(context, viewport, selector, { right, width, viewportWidth: clientWidth }),
        );
  return {
    rule: OVERFLOW_RULE,
    key: `${context.screen.route}|${viewport.name}`,
    occurrences,
    observed: `the page scrolls sideways at ${labelOf(viewport)}: it is ${scrollWidth} px wide in a ${clientWidth} px wide viewport`,
  };
}

function clippedDraft(context: LensContext, viewport: Viewport, { clipped }: OverflowMeasure): Draft | null {
  if (clipped.length === 0) return null;
  const occurrences = clipped.map(({ selector, text, scrollWidth, clientWidth }) =>
    occurrenceAt(context, viewport, selector, { text, scrollWidth, clientWidth }),
  );
  const subject = clipped.length === 1 ? '1 element cuts its' : `${clipped.length} elements cut their`;
  return {
    rule: CLIPPED_RULE,
    key: `${context.screen.route}|${viewport.name}|clipped`,
    occurrences,
    observed: `${subject} text off without an ellipsis at ${labelOf(viewport)}`,
  };
}

/** Where it was seen: the screen at `viewport`, and the element when there is one that can be stored. */
function occurrenceAt(
  context: LensContext,
  viewport: Viewport,
  selector: SelectorCandidate | null,
  measured: Occurrence['measured'],
): Occurrence {
  const { id: screenId, route, url } = context.screen;
  return {
    screenId,
    route,
    url,
    viewport,
    selector: selector === null ? null : stableSelector(selector),
    measured,
  };
}

async function fullPageScreenshot(context: LensContext, viewport: Viewport): Promise<EvidenceItem> {
  const png = await context.ipage.page.screenshot({ fullPage: true, type: 'png' });
  return { kind: 'screenshot', label: labelOf(viewport), ref: await context.ctx.evidence.putPng(png) };
}

/** `mobile 390×844`. */
function labelOf({ name, width, height }: Viewport): string {
  return `${name} ${width}×${height}`;
}

/** Waits for `task` until it settles, either way, or `ms` have passed: best effort, never throws. */
async function atMost(ms: number, task: Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([task.catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function withSkip(result: SweepResult, reason: string, count: number): SweepResult {
  return { ...result, skipped: [...result.skipped, { reason, count }] };
}

function merge(a: SweepResult, b: SweepResult): SweepResult {
  return {
    findings: [...a.findings, ...b.findings],
    screenshots: [...a.screenshots, ...b.screenshots],
    skipped: [...a.skipped, ...b.skipped],
  };
}
