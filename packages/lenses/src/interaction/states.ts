import {
  type Box,
  type ElementRef,
  type EvidenceRef,
  type Finding,
  forcePseudoState,
  type LensContext,
  type LensSkip,
  type PseudoState,
  pushNodes,
  type Viewport,
} from '@jayslifecode/lookover-core';
import type { CDPSession } from 'playwright';
import type { StyleSnapshot } from './in-page.js';
import { evaluateSource, measureOn } from './measure.js';
import { tally } from './skips.js';
import {
  ANCESTOR_SNAPSHOTS_SOURCE,
  BLUR_SOURCE,
  FINISH_ALL_TRANSITIONS_SOURCE,
  IDENTITY_SOURCE,
  type Identity,
  PLACE_IN_VIEW_SOURCE,
  type Placement,
  SETTLED_SNAPSHOT_SOURCE,
} from './states-in-page.js';
import { focusMarkOf, judgeStates } from './states-rules.js';

export { MAX_FOCUS_WITHIN_DEPTH } from './states-in-page.js';
export type { FocusLook } from './states-rules.js';
export { focusIndicatorColor, focusMarkOf, stateDiffers } from './states-rules.js';

/** Per screen, at most this many controls get forced states; the rest are counted in `skipped`. */
export const MAX_STATE_ELEMENTS = 60;
/** Per screen, the controls of at most this many class signatures are cropped, in every state. */
export const MAX_GALLERY_ELEMENTS = 12;
/** Room kept around a control in its crop, so an outline or a ring outside its box shows. */
export const CROP_PADDING_PX = 8;

export type GalleryState = 'rest' | 'hover' | 'focus' | 'active';
/** What shows a control's focus: itself, or its n-th ancestor (`ancestor:1` is the parent). */
export type FocusMarkOn = 'self' | `ancestor:${number}`;

/** One control of the screen in each state it was put in. */
export interface GalleryEntry {
  selector: string;
  role: string;
  name: string;
  componentName: string | null;
  states: Partial<Record<GalleryState, StyleSnapshot>>;
  crops: Partial<Record<GalleryState, EvidenceRef>>;
  /** Why it was not put in every state (`disabled`, `no-backend-node`, `gone`); `null` when it was. */
  skipped: string | null;
  /** What changed under forced focus (see `focusMarkOf`); `null` when nothing did or it was not forced. */
  focusMarkOn: FocusMarkOn | null;
}

/** One stop of the Tab walk, in the order focus reached it. */
export interface FocusStop {
  index: number;
  selector: string | null;
  tag: string;
  box: Box;
  hidden: string | null;
}

/** The screen's controls in each state, written by the lens as `gallery-<screenId>.json`. */
export interface StateGallery {
  screenId: string;
  viewport: Viewport;
  entries: GalleryEntry[];
  /** Filled by the Tab walk. */
  focusOrder: FocusStop[];
}

export interface StatesResult {
  gallery: StateGallery;
  findings: Finding[];
  /** `interaction.hover-state-missing`: a hover rule set with JavaScript cannot be seen this way. */
  worthALook: Finding[];
  skipped: LensSkip[];
}

/** A control that can have states forced on it: one with a CDP node behind it. */
export type ForcibleElement = ElementRef & { backendNodeId: number };

/** A disabled control cannot be hovered, focused or pressed: it is recorded at rest only. */
const SKIP_DISABLED = 'disabled';
/** A ref built in the page has no node to force states through. */
const SKIP_NO_BACKEND_NODE = 'no-backend-node';
/** The control left the page before or while its states were captured. */
const SKIP_GONE = 'gone';
/** The DOM node id `pushNodes` gives an element that is no longer in the document. */
const NOT_IN_DOCUMENT = 0;
/**
 * What `CSS.forcePseudoState` fails with once the element has been removed: Chromium unbinds its node
 * id, and drops the states forced on it at the same time.
 */
const UNKNOWN_NODE_ERROR = 'Could not find node with given id';

/**
 * The states in the order they are captured, the pseudo-classes forced for each, and whether the
 * control's nearest ancestors are snapshotted too (only to tell where focus shows).
 */
const GALLERY_STATES: readonly {
  state: GalleryState;
  forced: readonly PseudoState[];
  withAncestors: boolean;
}[] = [
  { state: 'rest', forced: [], withAncestors: true },
  { state: 'hover', forced: ['hover'], withAncestors: false },
  { state: 'focus', forced: ['focus', 'focus-visible'], withAncestors: true },
  { state: 'active', forced: ['active'], withAncestors: false },
];

interface Walked {
  entries: GalleryEntry[];
  findings: Finding[];
  worthALook: Finding[];
  skipped: LensSkip[];
}

type Shots = Pick<GalleryEntry, 'states' | 'crops' | 'skipped' | 'focusMarkOn'>;

/** What the states captured so far hold, the ancestors' snapshots included. */
interface Taken {
  states: GalleryEntry['states'];
  crops: GalleryEntry['crops'];
  ancestors: Partial<Record<GalleryState, readonly StyleSnapshot[]>>;
}

interface Shot {
  snapshot: StyleSnapshot;
  /** Empty unless asked for. */
  ancestors: readonly StyleSnapshot[];
  crop: EvidenceRef | null;
}

/**
 * Puts the screen's controls, in reading order, at rest and then in a forced `:hover`, `:focus` (with
 * `:focus-visible`) and `:active`, taking a style snapshot in each and cropping the controls of the
 * first `MAX_GALLERY_ELEMENTS` class signatures (`tag` and sorted class list) in every state. Only the
 * first `MAX_STATE_ELEMENTS` controls are taken (`state-elements-cap`); a disabled control is recorded
 * at rest only; past `context.deadline` the rest are left out (`time-budget`). Focus is first moved
 * off whatever has it, so no control's rest state shows its focus mark. At rest and with focus, the
 * `MAX_FOCUS_WITHIN_DEPTH` nearest ancestors are snapshotted too, to tell where focus shows
 * (`GalleryEntry.focusMarkOn`).
 *
 * Every node id is pushed once, before anything is forced, and states are measured by backend node id
 * only: requesting the document again would strand the forced states (see `forcePseudoState`). Each
 * forced state is cleared before the next one, whatever happens.
 */
export async function captureStates(
  context: LensContext,
  elements: readonly ElementRef[],
): Promise<StatesResult> {
  const { screen, ipage } = context;
  const taken = elements.slice(0, MAX_STATE_ELEMENTS);
  const overCap = elements.length - taken.length;
  await evaluateSource(ipage.page, BLUR_SOURCE);
  const nodeIds = await nodeIdsOf(ipage.cdp, taken);
  const walked = await walk(context, taken, nodeIds);
  await evaluateSource(ipage.page, FINISH_ALL_TRANSITIONS_SOURCE);
  const capSkip: LensSkip[] = overCap > 0 ? [{ reason: 'state-elements-cap', count: overCap }] : [];
  return {
    gallery: { screenId: screen.id, viewport: screen.viewport, entries: walked.entries, focusOrder: [] },
    findings: walked.findings,
    worthALook: walked.worthALook,
    skipped: [...capSkip, ...walked.skipped],
  };
}

/** Each control's DOM node id by its backend node id; `NOT_IN_DOCUMENT` for one that has left the page. */
async function nodeIdsOf(
  cdp: CDPSession,
  elements: readonly ElementRef[],
): Promise<ReadonlyMap<number, number>> {
  const backendNodeIds = elements.flatMap(({ backendNodeId }) =>
    backendNodeId === undefined ? [] : [backendNodeId],
  );
  if (backendNodeIds.length === 0) return new Map();
  const nodeIds = await pushNodes(cdp, backendNodeIds);
  return new Map(backendNodeIds.map((id, index) => [id, nodeIds[index] ?? NOT_IN_DOCUMENT]));
}

async function walk(
  context: LensContext,
  elements: readonly ElementRef[],
  nodeIds: ReadonlyMap<number, number>,
): Promise<Walked> {
  let walked: Walked = { entries: [], findings: [], worthALook: [], skipped: [] };
  let signatures: ReadonlySet<string> = new Set();
  for (const [index, element] of elements.entries()) {
    if (performance.now() >= context.deadline) {
      return {
        ...walked,
        skipped: tally([...walked.skipped, { reason: 'time-budget', count: elements.length - index }]),
      };
    }
    const captured = await captureElement(context, element, nodeIds, signatures);
    signatures = captured.signatures;
    const judged = isForcible(element)
      ? await judgeStates(context, element, captured.entry)
      : { findings: [], worthALook: [], skipped: [] };
    walked = {
      entries: [...walked.entries, captured.entry],
      findings: [...walked.findings, ...judged.findings],
      worthALook: [...walked.worthALook, ...judged.worthALook],
      skipped: tally([...walked.skipped, ...judged.skipped]),
    };
  }
  return walked;
}

async function captureElement(
  context: LensContext,
  element: ElementRef,
  nodeIds: ReadonlyMap<number, number>,
  signatures: ReadonlySet<string>,
): Promise<{ entry: GalleryEntry; signatures: ReadonlySet<string> }> {
  const { selector, role, name } = element;
  const blank: GalleryEntry = {
    selector,
    role,
    name,
    componentName: null,
    states: {},
    crops: {},
    skipped: null,
    focusMarkOn: null,
  };
  if (!isForcible(element)) return { entry: { ...blank, skipped: SKIP_NO_BACKEND_NODE }, signatures };
  const nodeId = nodeIds.get(element.backendNodeId) ?? NOT_IN_DOCUMENT;
  const identity =
    nodeId === NOT_IN_DOCUMENT
      ? null
      : await measureOn<Identity>(context.ipage.cdp, element, IDENTITY_SOURCE);
  if (identity === null) return { entry: { ...blank, skipped: SKIP_GONE }, signatures };
  const named = { ...blank, componentName: identity.componentName };
  if (element.disabled) {
    const rest = await captureState(context, element, false, false);
    const states = rest === null ? {} : { rest: rest.snapshot };
    return { entry: { ...named, states, skipped: rest === null ? SKIP_GONE : SKIP_DISABLED }, signatures };
  }
  const signature = [element.tag, ...identity.classes].join('.');
  const isCropped = !signatures.has(signature) && signatures.size < MAX_GALLERY_ELEMENTS;
  const shots = await captureEveryState(context, element, nodeId, isCropped);
  return {
    entry: { ...named, ...shots },
    signatures: isCropped ? new Set([...signatures, signature]) : signatures,
  };
}

async function captureEveryState(
  context: LensContext,
  element: ForcibleElement,
  nodeId: number,
  isCropped: boolean,
): Promise<Shots> {
  let taken: Taken = { states: {}, crops: {}, ancestors: {} };
  for (const { state, forced, withAncestors } of GALLERY_STATES) {
    const shot = await whileForced(context.ipage.cdp, nodeId, forced, () =>
      captureState(context, element, isCropped, withAncestors),
    );
    if (shot === null) return shotsOf(taken, SKIP_GONE);
    taken = {
      states: { ...taken.states, [state]: shot.snapshot },
      crops: shot.crop === null ? taken.crops : { ...taken.crops, [state]: shot.crop },
      ancestors: { ...taken.ancestors, [state]: shot.ancestors },
    };
  }
  return shotsOf(taken, null);
}

/** The gallery's part of what was taken: the ancestors' snapshots only decide where focus shows. */
function shotsOf({ states, crops, ancestors }: Taken, skipped: string | null): Shots {
  const { rest, focus } = states;
  const focusMarkOn =
    rest === undefined || focus === undefined
      ? null
      : focusMarkOf(
          { self: rest, ancestors: ancestors.rest ?? [] },
          { self: focus, ancestors: ancestors.focus ?? [] },
        );
  return { states, crops, skipped, focusMarkOn };
}

/**
 * Runs `measure` with `states` forced on the node (none: at rest), clearing them afterwards whatever
 * happens; `null` when the element has already left the page.
 */
async function whileForced<T>(
  cdp: CDPSession,
  nodeId: number,
  states: readonly PseudoState[],
  measure: () => Promise<T | null>,
): Promise<T | null> {
  if (states.length === 0) return measure();
  if (!(await forceUnlessGone(cdp, nodeId, states))) return null;
  try {
    return await measure();
  } finally {
    // Gone by now or not, nothing stays forced: a removed element's states go with its node id.
    await forceUnlessGone(cdp, nodeId, []);
  }
}

/** Forces `states` on the node (`[]` clears them); `false` when the element has left the page. */
async function forceUnlessGone(
  cdp: CDPSession,
  nodeId: number,
  states: readonly PseudoState[],
): Promise<boolean> {
  try {
    await forcePseudoState(cdp, nodeId, states);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes(UNKNOWN_NODE_ERROR)) return false;
    throw error;
  }
}

/**
 * The control's style snapshot in the state it is in, its nearest ancestors' when asked, and its crop
 * when it is cropped; `null` once it is gone.
 */
async function captureState(
  context: LensContext,
  element: ForcibleElement,
  isCropped: boolean,
  withAncestors: boolean,
): Promise<Shot | null> {
  const { cdp } = context.ipage;
  const snapshot = await measureOn<StyleSnapshot>(cdp, element, SETTLED_SNAPSHOT_SOURCE);
  if (snapshot === null) return null;
  const ancestors = withAncestors
    ? await measureOn<StyleSnapshot[]>(cdp, element, ANCESTOR_SNAPSHOTS_SOURCE)
    : [];
  if (ancestors === null) return null;
  return { snapshot, ancestors, crop: isCropped ? await cropOf(context, element) : null };
}

/**
 * A screenshot of the control scrolled into view, padded by `CROP_PADDING_PX` and kept inside the
 * viewport; `null` when it is gone or nothing of it is in the viewport.
 */
async function cropOf(context: LensContext, element: ForcibleElement): Promise<EvidenceRef | null> {
  const placement = await measureOn<Placement>(context.ipage.cdp, element, PLACE_IN_VIEW_SOURCE);
  const clip = placement === null ? null : paddedClip(placement);
  if (clip === null) return null;
  const png = await context.ipage.page.screenshot({ clip, type: 'png' });
  return context.ctx.evidence.putPng(png);
}

function paddedClip({ rect, viewportWidth, viewportHeight }: Placement): Box | null {
  const x = Math.max(0, rect.x - CROP_PADDING_PX);
  const y = Math.max(0, rect.y - CROP_PADDING_PX);
  const right = Math.min(viewportWidth, rect.x + rect.width + CROP_PADDING_PX);
  const bottom = Math.min(viewportHeight, rect.y + rect.height + CROP_PADDING_PX);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function isForcible(element: ElementRef): element is ForcibleElement {
  return element.backendNodeId !== undefined;
}
