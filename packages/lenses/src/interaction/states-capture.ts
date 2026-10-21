import {
  type Box,
  type EvidenceRef,
  focusBackendNode,
  forcePseudoState,
  type LensContext,
  type PseudoState,
} from '@jayslifecode/lookover-core';
import type { CDPSession } from 'playwright';
import type { StyleSnapshot } from './in-page.js';
import { measureOn } from './measure.js';
import type { FocusMarkOn, ForcibleElement } from './states.js';
import {
  ANCESTOR_SNAPSHOTS_SOURCE,
  BLUR_SELF_SOURCE,
  PLACE_IN_VIEW_SOURCE,
  type Placement,
  SETTLED_SNAPSHOT_SOURCE,
} from './states-in-page.js';
import { type FocusLook, focusMarkOf } from './states-rules.js';

/*
 * How `captureStates` puts one control in a state and takes it: forcing a pseudo-class through its
 * node id, focusing it for real through its backend node id, and the snapshots and the crop taken
 * meanwhile.
 */

/** Room kept around a control in its crop, so an outline or a ring outside its box shows. */
export const CROP_PADDING_PX = 8;

/** Which way a control's focus mark was found: with focus forced, or once focused for real. */
export type FocusMarkVia = 'forced' | 'real';

/** What a state looks like on the control. */
export interface Shot {
  snapshot: StyleSnapshot;
  /** Empty unless asked for. */
  ancestors: readonly StyleSnapshot[];
  crop: EvidenceRef | null;
}

/** The control to capture: its node, through which states are forced, and whether it is cropped. */
export interface CaptureTarget {
  element: ForcibleElement;
  nodeId: number;
  isCropped: boolean;
}

/** The focus state's shot, where it shows focus and which way that was found (`null`: it shows none). */
export interface FocusShot extends Shot {
  markOn: FocusMarkOn | null;
  via: FocusMarkVia | null;
}

/**
 * What `DOM.focus` fails with when the element cannot take focus here (or has been removed since), and
 * when no node has the backend node id any more. Any other failure is not about the element.
 */
const FOCUS_REFUSED_ERRORS: readonly string[] = [
  'Element is not focusable',
  'No node found for given backend id',
];
/**
 * What `CSS.forcePseudoState` fails with once the element has been removed: Chromium unbinds its node
 * id, and drops the states forced on it at the same time.
 */
const UNKNOWN_NODE_ERROR = 'Could not find node with given id';

/**
 * The control in its focus state, `forced` (`:focus` and `:focus-visible`) on its node, with its nearest
 * ancestors, compared with how it looks at `rest` (see `focusMarkOf`). A forced pseudo-class dispatches
 * no event, so a mark that a focus listener sets (Headless UI's `data-focus`, React Aria's
 * `data-focus-visible`, MUI's `.Mui-focusVisible`) does not show that way. When the forced look shows no
 * mark and the control can take focus, it is focused for real (`DOM.focus`) while the states stay
 * forced, so `:focus-visible` still matches, and looked at again once its transitions have finished;
 * it is blurred afterwards, and the states cleared, whatever happens. The real look is kept when it
 * shows the mark. `null` when the control has left the page.
 */
export async function captureFocus(
  context: LensContext,
  { element, nodeId, isCropped }: CaptureTarget,
  forced: readonly PseudoState[],
  rest: FocusLook,
): Promise<FocusShot | null> {
  return whileForced(context.ipage.cdp, nodeId, forced, async () => {
    const shot = await captureState(context, element, isCropped, true);
    if (shot === null) return null;
    const markOn = focusMarkOf(rest, lookOf(shot));
    if (markOn !== null) return { ...shot, markOn, via: 'forced' };
    const unmarked: FocusShot = { ...shot, markOn: null, via: null };
    if (!element.focusable) return unmarked;
    const real = await whileFocused(context.ipage.cdp, element, () =>
      captureState(context, element, isCropped, true),
    );
    const realMarkOn = real === null ? null : focusMarkOf(rest, lookOf(real));
    return real === null || realMarkOn === null ? unmarked : { ...real, markOn: realMarkOn, via: 'real' };
  });
}

/** How a shot looks, for `focusMarkOf`. */
export function lookOf({ snapshot, ancestors }: Shot): FocusLook {
  return { self: snapshot, ancestors };
}

/**
 * Runs `measure` with `states` forced on the node (none: at rest), clearing them afterwards whatever
 * happens; `null` when the element has already left the page.
 */
export async function whileForced<T>(
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

/**
 * Runs `measure` with the element focused for real, blurring it afterwards whatever happens (and
 * whatever its focus listener moved focus to); `null` when it cannot take focus.
 */
async function whileFocused<T>(
  cdp: CDPSession,
  element: ForcibleElement,
  measure: () => Promise<T | null>,
): Promise<T | null> {
  if (!(await focusUnlessRefused(cdp, element.backendNodeId))) return null;
  try {
    return await measure();
  } finally {
    await measureOn(cdp, element, BLUR_SELF_SOURCE);
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

/** Focuses the element for real; `false` when it cannot take focus or is gone. */
async function focusUnlessRefused(cdp: CDPSession, backendNodeId: number): Promise<boolean> {
  try {
    await focusBackendNode(cdp, backendNodeId);
    return true;
  } catch (error) {
    if (error instanceof Error && FOCUS_REFUSED_ERRORS.some((text) => error.message.includes(text))) {
      return false;
    }
    throw error;
  }
}

/**
 * The control's style snapshot in the state it is in, its nearest ancestors' when asked, and its crop
 * when it is cropped; `null` once it is gone.
 */
export async function captureState(
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
