import {
  type Box,
  type ElementRef,
  type EvidenceRef,
  type Finding,
  type LensContext,
  type LensSkip,
  type PseudoState,
  pushNodes,
  type Viewport,
} from '@jayslifecode/lookover-core';
import type { CDPSession } from 'playwright';
import { IDENTITY_SOURCE, type Identity, signatureOf } from './identity.js';
import type { StyleSnapshot } from './in-page.js';
import { evaluateSource, measureOn } from './measure.js';
import { tally } from './skips.js';
import {
  type CaptureTarget,
  captureFocus,
  captureState,
  type FocusMarkVia,
  type FocusShot,
  lookOf,
  type Shot,
  whileForced,
} from './states-capture.js';
import { BLUR_SOURCE, FINISH_ALL_TRANSITIONS_SOURCE } from './states-in-page.js';
import { type FocusLook, judgeStates } from './states-rules.js';

export type { FocusMarkVia } from './states-capture.js';
export { CROP_PADDING_PX } from './states-capture.js';
export { MAX_FOCUS_WITHIN_DEPTH } from './states-in-page.js';
export type { FocusLook } from './states-rules.js';
export { focusIndicatorColor, focusMarkOf, stateDiffers } from './states-rules.js';

/** Per screen, at most this many controls get forced states; the rest are counted in `skipped`. */
export const MAX_STATE_ELEMENTS = 60;
/** Per screen, the controls of at most this many class signatures are cropped, in every state. */
export const MAX_GALLERY_ELEMENTS = 12;

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
  /** What changed under focus (see `focusMarkOf`); `null` when nothing did or it was not focused. */
  focusMarkOn: FocusMarkOn | null;
  /**
   * How the mark was found: with focus forced, or only once the control was focused for real (a mark a
   * focus listener sets); `null` when there is none.
   */
  focusMarkVia: FocusMarkVia | null;
}

/** One stop of the Tab walk, in the order focus reached it. */
export interface FocusStop {
  /** How many Tab presses from the top of the page it took to land here. */
  index: number;
  /** `null` when the page's selectors do not find the element again. */
  selector: string | null;
  tag: string;
  /** The border box in document coordinates. */
  box: Box;
  /** Why a person could not see the focused element (see `ACTIVE_ELEMENT_SOURCE`); `null` when they could. */
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

type Shots = Pick<GalleryEntry, 'states' | 'crops' | 'skipped' | 'focusMarkOn' | 'focusMarkVia'>;

/** What the states captured so far hold. */
interface Taken extends Omit<Shots, 'skipped'> {
  /** How the control looks at rest, its nearest ancestors included, for focus to be compared with. */
  rest: FocusLook | null;
}

const NOTHING_TAKEN: Taken = { states: {}, crops: {}, focusMarkOn: null, focusMarkVia: null, rest: null };

/**
 * Puts the screen's controls, in reading order, at rest and then in a forced `:hover`, `:focus` (with
 * `:focus-visible`) and `:active`, taking a style snapshot in each and cropping the controls of the
 * first `MAX_GALLERY_ELEMENTS` class signatures (`tag` and sorted class list) in every state. Only the
 * first `MAX_STATE_ELEMENTS` controls are taken (`state-elements-cap`); a disabled control is recorded
 * at rest only; past `context.deadline` the rest are left out (`time-budget`). Focus is first moved
 * off whatever has it, so no control's rest state shows its focus mark. At rest and with focus, the
 * `MAX_FOCUS_WITHIN_DEPTH` nearest ancestors are snapshotted too, to tell where focus shows
 * (`GalleryEntry.focusMarkOn`); a control whose forced focus shows nothing is focused for real as well,
 * for a mark a focus listener sets (see `captureFocus`, `GalleryEntry.focusMarkVia`).
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
      ? await judgeStates(context, element, captured.entry, captured.signature)
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

/** A control as captured, its class signature (`signatureOf`) and the signatures cropped so far. */
interface Captured {
  entry: GalleryEntry;
  /** `null` when the control was not read in the page. */
  signature: string | null;
  signatures: ReadonlySet<string>;
}

async function captureElement(
  context: LensContext,
  element: ElementRef,
  nodeIds: ReadonlyMap<number, number>,
  signatures: ReadonlySet<string>,
): Promise<Captured> {
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
    focusMarkVia: null,
  };
  if (!isForcible(element)) {
    return { entry: { ...blank, skipped: SKIP_NO_BACKEND_NODE }, signature: null, signatures };
  }
  const nodeId = nodeIds.get(element.backendNodeId) ?? NOT_IN_DOCUMENT;
  const identity =
    nodeId === NOT_IN_DOCUMENT
      ? null
      : await measureOn<Identity>(context.ipage.cdp, element, IDENTITY_SOURCE);
  if (identity === null) return { entry: { ...blank, skipped: SKIP_GONE }, signature: null, signatures };
  const named = { ...blank, componentName: identity.componentName };
  const signature = signatureOf(element.tag, identity.classes);
  if (element.disabled) {
    const rest = await captureState(context, element, false, false);
    const states = rest === null ? {} : { rest: rest.snapshot };
    const skipped = rest === null ? SKIP_GONE : SKIP_DISABLED;
    return { entry: { ...named, states, skipped }, signature, signatures };
  }
  const isCropped = !signatures.has(signature) && signatures.size < MAX_GALLERY_ELEMENTS;
  const shots = await captureEveryState(context, element, nodeId, isCropped);
  return {
    entry: { ...named, ...shots },
    signature,
    signatures: isCropped ? new Set([...signatures, signature]) : signatures,
  };
}

async function captureEveryState(
  context: LensContext,
  element: ForcibleElement,
  nodeId: number,
  isCropped: boolean,
): Promise<Shots> {
  let taken = NOTHING_TAKEN;
  for (const gallery of GALLERY_STATES) {
    const shot = await shotIn(context, { element, nodeId, isCropped }, gallery, taken.rest);
    if (shot === null) return shotsOf(taken, SKIP_GONE);
    taken = withShot(taken, gallery.state, shot);
  }
  return shotsOf(taken, null);
}

/** The control in one state; the focus state is compared with `rest` as it is taken (see `captureFocus`). */
function shotIn(
  context: LensContext,
  { element, nodeId, isCropped }: CaptureTarget,
  { state, forced, withAncestors }: (typeof GALLERY_STATES)[number],
  rest: FocusLook | null,
): Promise<Shot | FocusShot | null> {
  if (state === 'focus' && rest !== null) {
    return captureFocus(context, { element, nodeId, isCropped }, forced, rest);
  }
  return whileForced(context.ipage.cdp, nodeId, forced, () =>
    captureState(context, element, isCropped, withAncestors),
  );
}

function withShot(taken: Taken, state: GalleryState, shot: Shot | FocusShot): Taken {
  const focusMark = 'markOn' in shot ? { focusMarkOn: shot.markOn, focusMarkVia: shot.via } : {};
  return {
    ...taken,
    ...focusMark,
    states: { ...taken.states, [state]: shot.snapshot },
    crops: shot.crop === null ? taken.crops : { ...taken.crops, [state]: shot.crop },
    rest: state === 'rest' ? lookOf(shot) : taken.rest,
  };
}

/** The gallery's part of what was taken: the rest look only decides where focus shows. */
function shotsOf({ rest: _, ...shots }: Taken, skipped: string | null): Shots {
  return { ...shots, skipped };
}

function isForcible(element: ElementRef): element is ForcibleElement {
  return element.backendNodeId !== undefined;
}
