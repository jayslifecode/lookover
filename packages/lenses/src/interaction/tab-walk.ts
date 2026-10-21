import {
  type ElementTarget,
  type Finding,
  type LensContext,
  type LensSkip,
  type StepTrace,
  stableSelector,
  stepFinding,
} from '@jayslifecode/lookover-core';
import { type Rule, ruleById } from '@jayslifecode/lookover-rules';
import { targetIdentityOf } from './identity.js';
import { evaluateSource } from './measure.js';
import { tally } from './skips.js';
import type { FocusStop } from './states.js';
import { FINISH_ALL_TRANSITIONS_SOURCE } from './states-in-page.js';
import { ACTIVE_ELEMENT_SOURCE, type ActiveElement, RESTART_TAB_ORDER_SOURCE } from './tab-in-page.js';

/** Per screen, Tab is pressed at most this many times, whatever the screen holds. */
export const MAX_TAB_PRESSES = 300;
/** Focus on the same element after this many Tab presses in a row is a keyboard trap. */
export const TRAP_REPEATS = 3;

const HIDDEN_RULE = ruleById('interaction.focus-hidden');
const TRAP_RULE = ruleById('interaction.focus-trap');

/** A page may hold controls the accessibility tree did not list, so more than the count are allowed. */
const PRESSES_PER_CONTROL = 2;
const PRESS_HEADROOM = 5;
/** While Tab moves through the controls inside an iframe, the iframe stays the page's active element. */
const FRAME_TAG = 'iframe';
/**
 * Only a custom element can have a closed shadow root, and its tag name has a hyphen. From the page a
 * closed root cannot be looked into: focus moving between the controls in it looks like focus staying.
 */
const CUSTOM_ELEMENT_TAG_PART = '-';

const SKIP_UNADDRESSABLE = 'focus-stop-unaddressable';
/** A stop in a framework's development overlay (`DEV_OVERLAY_TAGS`): the dev server's, not the app's. */
const SKIP_DEV_OVERLAY = 'dev-overlay';
const SKIP_PRESSES_CAP = 'tab-presses-cap';
const SKIP_WALK_STOPPED = 'tab-walk-stopped';
const SKIP_TIME_BUDGET = 'time-budget';

const HIDDEN_WHAT = 'bounding box and visibility of document.activeElement';
const TRAP_WHAT = 'document.activeElement after each of the last Tab presses';
/** Why a person cannot see the focused element, as `ACTIVE_ELEMENT_SOURCE` names it. */
const HIDDEN_REASONS: Readonly<Record<string, string>> = {
  'zero-size': 'it has no width or height',
  visibility: 'it is hidden with the visibility property',
  opacity: 'it is fully transparent',
  offscreen: 'it is outside the page',
};

/**
 * `ACTIVE_ELEMENT_SOURCE` once the transitions the focus started have run to their end, so a skip link
 * that slides in on `:focus` is read in the place it settles, not where it started.
 */
const SETTLED_ACTIVE_ELEMENT_SOURCE = `() => { (${FINISH_ALL_TRANSITIONS_SOURCE})(); return (${ACTIVE_ELEMENT_SOURCE})(); }`;

export interface TabWalkResult {
  focusOrder: FocusStop[];
  findings: Finding[];
  skipped: LensSkip[];
}

/** A stop that can be named in a finding: its selector survives redaction. */
type AddressedStop = FocusStop & { selector: string };

/** Why the walk stopped. */
type WalkEnd =
  /** Focus left the document, or came back round to the first stop. */
  | { kind: 'finished' }
  /** The same element kept focus for `TRAP_REPEATS` presses in a row; the rest of the page was not walked. */
  | { kind: 'stuck'; pressesLeft: number }
  /** The presses ran out before either. */
  | { kind: 'cap' }
  | { kind: 'deadline'; pressesLeft: number };

/** A stop, and what tells whether the next press moved focus: see `isStuck`. */
interface Landing {
  stop: FocusStop;
  /** The element focus is on, down to the control in its open shadow roots (`ActiveElement.inner`). */
  identity: string;
  /** A native control that Tab crosses in several presses (`ActiveElement.isMultiPart`). */
  isMultiPart: boolean;
  /** In a framework's development overlay (`ActiveElement.isDevOverlay`). */
  isDevOverlay: boolean;
}

interface Walked {
  /** The app's stops: the ones in a development overlay are left out. */
  stops: FocusStop[];
  /** How many stops were in a development overlay. */
  devOverlay: number;
  end: WalkEnd;
}

/**
 * Presses Tab from the top of the page and records where focus lands, one `FocusStop` for each press
 * (`index` is the number of presses it took). At most `2 * focusableCount + 5` presses are made, not
 * counting the ones that stay on a multi-part control (`staysOnMultiPart`), and never more than
 * `MAX_TAB_PRESSES`. `context.deadline` is checked before each. The walk ends when focus leaves the
 * document (the active element is the body), when it comes back round to the first stop, when the same
 * element keeps focus for `TRAP_REPEATS` presses (`isStuck`; `tab-walk-stopped` counts the presses not
 * made), when the presses run out (`tab-presses-cap`) or at the deadline (`time-budget`, counting the
 * presses not made).
 *
 * - `interaction.focus-hidden`: a stop that cannot be seen (see `ACTIVE_ELEMENT_SOURCE`), measured once
 *   the focus has landed and its transitions have finished, so a skip link that shows itself on
 *   `:focus` is not reported. One finding for each element, at its first stop.
 * - `interaction.focus-trap`: the walk was stuck on an element while the screen has more than one
 *   focusable control.
 *
 * A stop with no selector of its own is kept in the order but cannot be reported
 * (`focus-stop-unaddressable`). A stop in a framework's development overlay (`DEV_OVERLAY_TAGS`) is
 * pressed through like any other, then left out of the order and the findings and counted
 * (`dev-overlay`): it is the dev server's, not the app's.
 */
export async function tabWalk(context: LensContext, focusableCount: number): Promise<TabWalkResult> {
  const { stops, devOverlay, end } = await walkStops(context, pressBudget(focusableCount));
  const overlaySkips: LensSkip[] = devOverlay > 0 ? [{ reason: SKIP_DEV_OVERLAY, count: devOverlay }] : [];
  return {
    focusOrder: stops,
    findings: await judge(context, stops, end, focusableCount),
    skipped: tally([...unaddressableSkips(stops), ...overlaySkips, ...endSkips(end)]),
  };
}

/** The presses a screen with this many focusable controls is given, before `MAX_TAB_PRESSES`. */
function pressBudget(focusableCount: number): number {
  return PRESSES_PER_CONTROL * focusableCount + PRESS_HEADROOM;
}

async function walkStops(context: LensContext, budget: number): Promise<Walked> {
  const { page } = context.ipage;
  await evaluateSource(page, RESTART_TAB_ORDER_SOURCE);
  let landings: Landing[] = [];
  let counted = 0;
  const ended = (end: WalkEnd): Walked => ({
    stops: landings.filter(({ isDevOverlay }) => !isDevOverlay).map(({ stop }) => stop),
    devOverlay: landings.filter(({ isDevOverlay }) => isDevOverlay).length,
    end,
  });
  const pressesLeft = (): number => Math.min(budget - counted, MAX_TAB_PRESSES - landings.length);
  while (pressesLeft() > 0) {
    if (performance.now() >= context.deadline) return ended({ kind: 'deadline', pressesLeft: pressesLeft() });
    await page.keyboard.press('Tab');
    const active = await evaluateSource<ActiveElement>(page, SETTLED_ACTIVE_ELEMENT_SOURCE);
    if (active.isBody) return ended({ kind: 'finished' });
    const landing = landingOf(landings.length + 1, active);
    if (isWrap(landings, landing)) return ended({ kind: 'finished' });
    counted += staysOnMultiPart(landings, landing) ? 0 : 1;
    landings = [...landings, landing];
    if (isStuck(landings)) return ended({ kind: 'stuck', pressesLeft: pressesLeft() });
  }
  return ended({ kind: 'cap' });
}

function landingOf(index: number, active: ActiveElement): Landing {
  const { selector, tag, box, hidden, inner, isMultiPart, isDevOverlay } = active;
  const stored = selector === null ? null : stableSelector(selector);
  return {
    stop: { index, selector: stored, tag, box, hidden },
    identity: `${stored}|${inner}`,
    isMultiPart,
    isDevOverlay,
  };
}

/** Focus is back on the first stop after being somewhere else: the walk has been all the way round. */
function isWrap(landings: readonly Landing[], { stop }: Landing): boolean {
  const first = landings[0]?.stop;
  const previous = landings.at(-1)?.stop;
  return (
    first !== undefined &&
    stop.selector !== null &&
    stop.selector === first.selector &&
    previous?.selector !== stop.selector
  );
}

/** The press left focus on the multi-part control it was already on: its next part, not another stop. */
function staysOnMultiPart(landings: readonly Landing[], landing: Landing): boolean {
  const previous = landings.at(-1);
  return landing.isMultiPart && landing.stop.selector !== null && previous?.identity === landing.identity;
}

/**
 * Focus can move without the active element changing, and then it is not a trap: between the segments
 * of a native control the browser draws in parts (`isMultiPart`), between the controls in an iframe
 * (`FRAME_TAG`) and between the controls in a closed shadow root (`CUSTOM_ELEMENT_TAG_PART`). The
 * controls in an open shadow root are told apart by `identity`.
 */
function movesInside({ stop, isMultiPart }: Landing): boolean {
  return isMultiPart || stop.tag === FRAME_TAG || stop.tag.includes(CUSTOM_ELEMENT_TAG_PART);
}

/**
 * The last `TRAP_REPEATS` landings are the same element and the same control inside it. A development
 * overlay is never the app's trap: the walk goes on past it, within its presses.
 */
function isStuck(landings: readonly Landing[]): boolean {
  const run = landings.slice(-TRAP_REPEATS);
  const [head] = run;
  if (head === undefined || run.length < TRAP_REPEATS) return false;
  if (head.stop.selector === null || head.isDevOverlay || movesInside(head)) return false;
  return run.every(({ identity }) => identity === head.identity);
}

function lastOf(stops: readonly FocusStop[]): FocusStop | null {
  return stops.at(-1) ?? null;
}

function isAddressed(stop: FocusStop): stop is AddressedStop {
  return stop.selector !== null;
}

/**
 * The findings for the stops, built one after another: finding an element by its selector requests the
 * document again, which drops the node ids a finding built at the same time was given.
 */
async function judge(
  context: LensContext,
  stops: readonly FocusStop[],
  end: WalkEnd,
  focusableCount: number,
): Promise<Finding[]> {
  let findings: Finding[] = [];
  for (const stop of firstHiddenStops(stops)) {
    findings = [...findings, await hiddenFinding(context, stop)];
  }
  const trapped = trappedStop(stops, end, focusableCount);
  return trapped === null ? findings : [...findings, await trapFinding(context, trapped)];
}

/** The element that keeps focus, when the walk was stuck and there was somewhere else to go. */
function trappedStop(
  stops: readonly FocusStop[],
  end: WalkEnd,
  focusableCount: number,
): AddressedStop | null {
  const last = lastOf(stops);
  const isTrapped = end.kind === 'stuck' && focusableCount > 1;
  return isTrapped && last !== null && isAddressed(last) ? last : null;
}

/** The first stop at each element that cannot be seen. */
function firstHiddenStops(stops: readonly FocusStop[]): AddressedStop[] {
  const seen = new Set<string>();
  return stops.filter(isAddressed).filter((stop) => {
    if (stop.hidden === null || seen.has(stop.selector)) return false;
    seen.add(stop.selector);
    return true;
  });
}

function unaddressableSkips(stops: readonly FocusStop[]): LensSkip[] {
  const count = stops.filter((stop) => stop.selector === null).length;
  return count > 0 ? [{ reason: SKIP_UNADDRESSABLE, count }] : [];
}

function endSkips(end: WalkEnd): LensSkip[] {
  if (end.kind === 'cap') return [{ reason: SKIP_PRESSES_CAP, count: 1 }];
  if (end.kind === 'deadline') return [{ reason: SKIP_TIME_BUDGET, count: end.pressesLeft }];
  if (end.kind === 'stuck' && end.pressesLeft > 0) {
    return [{ reason: SKIP_WALK_STOPPED, count: end.pressesLeft }];
  }
  return [];
}

async function hiddenFinding(context: LensContext, stop: AddressedStop): Promise<Finding> {
  const reason = stop.hidden ?? '';
  return findingFor(context, HIDDEN_RULE, stop, {
    what: HIDDEN_WHAT,
    observed: `takes keyboard focus on Tab press ${stop.index} but cannot be seen: ${HIDDEN_REASONS[reason] ?? reason}`,
    measured: { selector: stop.selector, press: stop.index, hidden: reason, box: stop.box },
  });
}

function trapFinding(context: LensContext, stop: AddressedStop): Promise<Finding> {
  return findingFor(context, TRAP_RULE, stop, {
    what: TRAP_WHAT,
    observed: `keeps keyboard focus when Tab is pressed ${TRAP_REPEATS} times in a row, so a keyboard user cannot move past it`,
    measured: { selector: stop.selector, press: stop.index, repeats: TRAP_REPEATS },
  });
}

interface FindingText {
  /** What the trace's last step measures; it also labels the measurements evidence. */
  what: string;
  observed: string;
  /** Stored as the finding's measurements. */
  measured: Record<string, unknown>;
}

/**
 * A step finding for `rule` on the element of `stop`, with the trace `navigate`, `set-viewport`, Tab
 * pressed as many times as it took to get there, and `measure`; the measurements are its evidence.
 */
async function findingFor(
  context: LensContext,
  rule: Rule,
  stop: AddressedStop,
  { what, observed, measured }: FindingText,
): Promise<Finding> {
  const ref = await context.ctx.evidence.putJson('measurements', measured);
  return stepFinding({
    rule,
    screen: context.screen,
    target: await targetOf(context, stop),
    trace: traceOf(context, stop.index, what),
    observed,
    evidence: [{ kind: 'measurements', label: what, ref }],
  });
}

/**
 * The stop's element as the screen's elements list it (its role, name and box); a stop the
 * accessibility tree did not list is named by its tag and its own box.
 */
async function targetOf(context: LensContext, stop: AddressedStop): Promise<ElementTarget> {
  const listed = context.screen.elements.find(({ selector }) => selector === stop.selector);
  const identity = await targetIdentityOf(context.ipage.cdp, { selector: stop.selector }, stop.tag);
  return {
    selector: stop.selector,
    role: listed?.role ?? stop.tag,
    name: listed?.name ?? '',
    ...identity,
    box: listed?.box ?? stop.box,
  };
}

function traceOf(context: LensContext, presses: number, what: string): StepTrace {
  const { route, url, viewport } = context.screen;
  return {
    route,
    url,
    viewport,
    steps: [
      { kind: 'navigate', url },
      { kind: 'set-viewport', viewport },
      { kind: 'press', key: 'Tab', times: presses },
      { kind: 'measure', what },
    ],
  };
}
