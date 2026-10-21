import {
  type EvidenceItem,
  type Finding,
  type LensContext,
  type LensSkip,
  type Occurrence,
  type OccurrenceFindingInput,
  occurrenceFinding,
  type SelectorCandidate,
  stableSelector,
  type Viewport,
} from '@jayslifecode/lookover-core';
import { ruleById } from '@jayslifecode/lookover-rules';
import type { Page } from 'playwright';
import { MEASURE_OVERFLOW_SOURCE, type OverflowMeasure } from './in-page.js';
import { evaluateSource } from './measure.js';
import { FINISH_ALL_TRANSITIONS_SOURCE } from './states-in-page.js';

const OVERFLOW_RULE = ruleById('interaction.horizontal-overflow');
const CLIPPED_RULE = ruleById('interaction.text-clipped');

/** A page wider than its viewport by no more than this is rounding, not overflow. */
const OVERFLOW_TOLERANCE_PX = 1;
const FONTS_READY_TIMEOUT_MS = 2_000;
/** As long as the crawler gives a navigation by default. */
const RELOAD_TIMEOUT_MS = 15_000;
const SKIP_TIME_BUDGET = 'time-budget';
/** Waits, in the page, until its fonts have loaded: text set in a fallback font is measured too narrow. */
const FONTS_READY_SOURCE = '() => document.fonts.ready.then(() => undefined)';

export interface SweepResult {
  findings: Finding[];
  /** The full-page screenshots taken, one for each viewport that raised a finding. */
  screenshots: EvidenceItem[];
  skipped: LensSkip[];
}

/** A finding at one viewport, before its screenshot is taken. */
type Draft = Omit<OccurrenceFindingInput, 'evidence'>;

const NOTHING: SweepResult = { findings: [], screenshots: [], skipped: [] };

/**
 * Reloads the screen at each viewport after the first (the one it was captured at) and measures its
 * horizontal overflow there (`MEASURE_OVERFLOW_SOURCE`), once its fonts are ready (at most 2 s) and its
 * transitions have finished:
 *
 * - `interaction.horizontal-overflow` when the page is wider than the viewport (`scrollWidth >
 *   clientWidth + 1`): one finding for the viewport (key `${route}|${viewport.name}`), with an
 *   occurrence for each element that reaches past it, or one for the page when no element's box does
 *   (a pseudo-element, say).
 * - `interaction.text-clipped`: one finding for the viewport (key `${route}|${viewport.name}|clipped`),
 *   with an occurrence for each element that cuts its own text off without an ellipsis.
 *
 * Both carry a full-page screenshot taken at that viewport. `context.deadline` is checked before each
 * viewport; the ones not reached are counted (`time-budget`). When any viewport was swept, the first one
 * is restored and the page reloaded at it, so whatever measures next finds it as it was captured. The
 * page only ever reloads its own URL.
 */
export async function sweepViewports(context: LensContext): Promise<SweepResult> {
  const [first, ...others] = context.viewports;
  const { page } = context.ipage;
  let result = NOTHING;
  let swept = 0;
  for (const viewport of others) {
    if (performance.now() >= context.deadline) break;
    result = merge(result, await measureAt(context, viewport));
    swept += 1;
  }
  if (first !== undefined && swept > 0) await reloadAt(page, first);
  const left = others.length - swept;
  return left > 0
    ? { ...result, skipped: [...result.skipped, { reason: SKIP_TIME_BUDGET, count: left }] }
    : result;
}

async function measureAt(context: LensContext, viewport: Viewport): Promise<SweepResult> {
  const { page } = context.ipage;
  await reloadAt(page, viewport);
  await atMost(FONTS_READY_TIMEOUT_MS, evaluateSource(page, FONTS_READY_SOURCE));
  await evaluateSource(page, FINISH_ALL_TRANSITIONS_SOURCE);
  const measure = await evaluateSource<OverflowMeasure>(page, MEASURE_OVERFLOW_SOURCE);
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

async function reloadAt(page: Page, { width, height }: Viewport): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.reload({ waitUntil: 'load', timeout: RELOAD_TIMEOUT_MS });
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

function merge(a: SweepResult, b: SweepResult): SweepResult {
  return {
    findings: [...a.findings, ...b.findings],
    screenshots: [...a.screenshots, ...b.screenshots],
    skipped: [...a.skipped, ...b.skipped],
  };
}
