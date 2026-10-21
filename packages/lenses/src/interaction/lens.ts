import type { Lens, LensContext, LensResult, LensSkip } from '@jayslifecode/lookover-core';
import { evaluateSource } from './measure.js';
import { tally } from './skips.js';
import { captureStates, type StateGallery } from './states.js';
import { BLUR_SOURCE } from './states-in-page.js';
import { measureStatic } from './static.js';
import { type TabWalkResult, tabWalk } from './tab-walk.js';
import { sweepViewports } from './viewports.js';

/** The catalogue's `interaction.*` rules, in its order: every rule the interaction lens can report. */
export const INTERACTION_RULES: readonly string[] = [
  'interaction.focus-visible-missing',
  'interaction.focus-indicator-contrast',
  'interaction.hover-state-missing',
  'interaction.text-contrast-fail',
  'interaction.text-contrast-low',
  'interaction.target-size',
  'interaction.keyboard-unreachable',
  'interaction.positive-tabindex',
  'interaction.focus-hidden',
  'interaction.focus-trap',
  'interaction.horizontal-overflow',
  'interaction.text-clipped',
];

/** The lens's steps, in the order they run; each names the skip of a step the deadline left out. */
type StepName = 'states' | 'static' | 'tab-walk' | 'viewports';

/** Moves focus off whatever has it and scrolls to the top at once, whatever the page's scroll-behavior. */
const RESET_FOCUS_AND_SCROLL_SOURCE = `() => { (${BLUR_SOURCE})(); window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); }`;

/**
 * Measures how a screen's controls look and behave: their forced hover, focus and active states
 * (`captureStates`), their text contrast, size and keyboard reach (`measureStatic`), the Tab order
 * (`tabWalk`) and, at each further viewport, horizontal overflow and clipped text (`sweepViewports`),
 * in that order. A step that would start after `context.deadline` is skipped whole
 * (`time-budget:<step>`); one that has started stops itself at the deadline. The states and the focus
 * order are written as the screen's gallery (`gallery-<screenId>.json`). Missing hover states are
 * lower-confidence and go to `worthALook`; everything else is a finding.
 */
export class InteractionLens implements Lens {
  readonly name = 'interaction';
  readonly rules = INTERACTION_RULES;

  async inspect(context: LensContext): Promise<LensResult> {
    const { elements } = context.screen;
    const states = await unlessPastDeadline(context, () => captureStates(context, elements));
    const statics = await unlessPastDeadline(context, () => measureStatic(context, elements));
    const walk = await unlessPastDeadline(context, () => walkTabs(context));
    const sweep = await unlessPastDeadline(context, () => sweepViewports(context));
    const gallery: StateGallery = {
      ...(states?.gallery ?? emptyGallery(context)),
      focusOrder: walk?.focusOrder ?? [],
    };
    return {
      findings: [
        ...(states?.findings ?? []),
        ...(statics?.findings ?? []),
        ...(walk?.findings ?? []),
        ...(sweep?.findings ?? []),
      ],
      worthALook: states?.worthALook ?? [],
      gallery: await context.ctx.evidence.putJson(`gallery-${context.screen.id}`, gallery),
      skipped: tally([
        ...(states?.skipped ?? [timeBudget('states')]),
        ...(statics?.skipped ?? [timeBudget('static')]),
        ...(walk?.skipped ?? [timeBudget('tab-walk')]),
        ...(sweep?.skipped ?? [timeBudget('viewports')]),
      ]),
    };
  }
}

/** `step`'s result, or `null` when the deadline has passed and it is not started. */
function unlessPastDeadline<T>(context: LensContext, step: () => Promise<T>): Promise<T | null> {
  return performance.now() >= context.deadline ? Promise.resolve(null) : step();
}

function timeBudget(step: StepName): LensSkip {
  return { reason: `time-budget:${step}`, count: 1 };
}

/**
 * The Tab walk, told how many of the screen's controls take focus. It leaves its last stop focused and
 * the page scrolled to it; both are put back, so the sweep and the next screen start from the top.
 */
async function walkTabs(context: LensContext): Promise<TabWalkResult> {
  const focusable = context.screen.elements.filter((element) => element.focusable).length;
  const walked = await tabWalk(context, focusable);
  await evaluateSource(context.ipage.page, RESET_FOCUS_AND_SCROLL_SOURCE);
  return walked;
}

/** The gallery of a screen whose states were not captured. */
function emptyGallery({ screen }: LensContext): StateGallery {
  return { screenId: screen.id, viewport: screen.viewport, entries: [], focusOrder: [] };
}
