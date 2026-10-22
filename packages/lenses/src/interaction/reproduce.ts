import type {
  ElementRef,
  Finding,
  LensContext,
  LensSkip,
  Reproduction,
  ReproductionTarget,
} from '@jayslifecode/lookover-core';
import { captureStates } from './states.js';
import { measureStatic } from './static.js';
import { tabWalk } from './tab-walk.js';
import { sweepViewports } from './viewports.js';

/** What the step that owns a rule reported, re-run for the target: every finding, worth-a-look included. */
interface Rerun {
  findings: readonly Finding[];
  /** Why the step skipped the target; `null` for a step that runs whole, which skips no one target. */
  skipped: string | null;
}

/** Re-runs one step for the target; `null` when the target's element is not on the fresh page. */
type Step = (target: ReproductionTarget, context: LensContext) => Promise<Rerun | null>;

/** The target's element is not on the fresh page: nothing there has its selector. */
const SKIP_GONE = 'gone';
const GONE: Reproduction = { reproduced: false, observed: null, skipped: SKIP_GONE, evidence: [] };

/** Each interaction rule and the step that reports it. */
const STEP_OF_RULE: ReadonlyMap<string, Step> = new Map<string, Step>([
  ['interaction.focus-visible-missing', rerunStates],
  ['interaction.focus-indicator-contrast', rerunStates],
  ['interaction.hover-state-missing', rerunStates],
  ['interaction.text-contrast-fail', rerunStatic],
  ['interaction.text-contrast-low', rerunStatic],
  ['interaction.target-size', rerunStatic],
  ['interaction.keyboard-unreachable', rerunStatic],
  ['interaction.positive-tabindex', rerunPageWideStatic],
  ['interaction.focus-hidden', rerunTabWalk],
  ['interaction.focus-trap', rerunTabWalk],
  ['interaction.horizontal-overflow', rerunSweep],
  ['interaction.text-clipped', rerunSweep],
]);

/**
 * Measures an interaction finding again on a freshly loaded page by re-running the step that reports
 * its rule, restricted to the target as far as that step allows: the forced states of its one element,
 * the static rules for its one element (every element still a neighbour), the page-wide positive
 * tabindex measure, the whole Tab walk, or the sweep at the target's viewport alone. It reproduced when
 * the step reports a finding with the target's `id` again (a missing hover state comes out as worth a
 * look). An element whose selector matches nothing on the fresh page is `gone`; a step that ran for the
 * target alone and skipped it gives its reason. Throws for a rule the lens does not report.
 */
export async function reproduceInteraction(
  target: ReproductionTarget,
  context: LensContext,
): Promise<Reproduction> {
  const rule = target.finding.rule.id;
  const step = STEP_OF_RULE.get(rule);
  if (step === undefined) throw new Error(`The interaction lens does not report ${rule}`);
  const rerun = await step(target, context);
  if (rerun === null) return GONE;
  const match = rerun.findings.find((finding) => finding.id === target.finding.id);
  if (match === undefined) return { reproduced: false, observed: null, skipped: rerun.skipped, evidence: [] };
  return { reproduced: true, observed: match.observed, skipped: null, evidence: match.evidence };
}

async function rerunStates(target: ReproductionTarget, context: LensContext): Promise<Rerun | null> {
  const element = elementOf(target, context);
  if (element === null) return null;
  const { findings, worthALook, gallery, skipped } = await captureStates(context, [element]);
  const entrySkip = gallery.entries[0]?.skipped ?? null;
  return { findings: [...findings, ...worthALook], skipped: entrySkip ?? firstReason(skipped) };
}

async function rerunStatic(target: ReproductionTarget, context: LensContext): Promise<Rerun | null> {
  const element = elementOf(target, context);
  if (element === null) return null;
  const { elements } = context.screen;
  const { findings, skipped } = await measureStatic(context, elements, { only: element.selector });
  return { findings, skipped: firstReason(skipped) };
}

/** Positive tabindex is the static step's one page-wide measure: it runs with no element to judge. */
async function rerunPageWideStatic(_target: ReproductionTarget, context: LensContext): Promise<Rerun> {
  return { findings: (await measureStatic(context, [])).findings, skipped: null };
}

async function rerunTabWalk(_target: ReproductionTarget, context: LensContext): Promise<Rerun> {
  const focusable = context.screen.elements.filter((element) => element.focusable).length;
  return { findings: (await tabWalk(context, focusable)).findings, skipped: null };
}

async function rerunSweep(target: ReproductionTarget, context: LensContext): Promise<Rerun> {
  const only = 'occurrence' in target ? target.occurrence.viewport.name : target.finding.trace.viewport.name;
  return { findings: (await sweepViewports(context, { only })).findings, skipped: null };
}

/** The element of the fresh screen with the target's selector; `null` when there is none. */
function elementOf(target: ReproductionTarget, context: LensContext): ElementRef | null {
  const selector = 'occurrence' in target ? target.occurrence.selector : target.finding.target?.selector;
  return context.screen.elements.find((element) => element.selector === selector) ?? null;
}

function firstReason(skipped: readonly LensSkip[]): string | null {
  return skipped[0]?.reason ?? null;
}
