import type { Box } from '@jayslifecode/lookover-core';
import { STYLE_SNAPSHOT_SOURCE, type StyleSnapshot } from './in-page.js';

/** How many ancestors, from the parent up, can show a control's focus (a wrapper's `:focus-within`). */
export const MAX_FOCUS_WITHIN_DEPTH = 3;

/*
 * Run in the page, so they stay self-contained (see `in-page.ts`).
 */

function finishTransitions(this: Element): void {
  for (const animation of this.getAnimations({ subtree: true })) {
    if (animation instanceof CSSTransition) animation.finish();
  }
}

function finishAllTransitions(): void {
  for (const animation of document.getAnimations()) {
    if (animation instanceof CSSTransition) animation.finish();
  }
}

export interface Placement {
  /** The border box in viewport coordinates, once it has been scrolled into view. */
  rect: Box;
  viewportWidth: number;
  viewportHeight: number;
}

function placeInView(this: Element): Placement | null {
  if (!this.isConnected) return null;
  this.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  const { x, y, width, height } = this.getBoundingClientRect();
  const { clientWidth, clientHeight } = document.documentElement;
  return { rect: { x, y, width, height }, viewportWidth: clientWidth, viewportHeight: clientHeight };
}

function ancestorSnapshots(
  this: Element,
  depth: number,
  settle: (this: Element) => void,
  snapshot: (this: Element) => StyleSnapshot,
): StyleSnapshot[] | null {
  if (!this.isConnected) return null;
  const snapshots: StyleSnapshot[] = [];
  for (let node = this.parentElement; node !== null && snapshots.length < depth; node = node.parentElement) {
    settle.call(node);
    snapshots.push(snapshot.call(node));
  }
  return snapshots;
}

function blurActiveElement(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement || active instanceof SVGElement) active.blur();
}

/*
 * The two sources below are `null` for an element no longer in the document: Chromium still resolves
 * a removed element that is alive, and its computed style is then all empty strings.
 */

/**
 * `STYLE_SNAPSHOT_SOURCE` once the CSS transitions running on the element, its pseudo-elements and its
 * descendants have been run to their end: a state change starts its transitions from the old values,
 * so a snapshot read straight away would show a hover colour that fades in as no change at all.
 */
export const SETTLED_SNAPSHOT_SOURCE = `function () { if (!this.isConnected) return null; (${finishTransitions.toString()}).call(this); return (${STYLE_SNAPSHOT_SOURCE}).call(this); }`;
/** `SETTLED_SNAPSHOT_SOURCE` for each of the `MAX_FOCUS_WITHIN_DEPTH` nearest ancestors, parent first. */
export const ANCESTOR_SNAPSHOTS_SOURCE = `function () { return (${ancestorSnapshots.toString()}).call(this, ${MAX_FOCUS_WITHIN_DEPTH}, ${finishTransitions.toString()}, ${STYLE_SNAPSHOT_SOURCE}); }`;
export const PLACE_IN_VIEW_SOURCE = placeInView.toString();
export const BLUR_SOURCE = blurActiveElement.toString();
/** Ends the transitions a cleared state started, so the page is back at rest for whatever measures next. */
export const FINISH_ALL_TRANSITIONS_SOURCE = finishAllTransitions.toString();
