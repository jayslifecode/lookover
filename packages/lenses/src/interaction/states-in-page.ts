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

/** Blurs the element, then whatever has focus now (a focus listener may have moved it on). */
function blurSelf(this: Element): void {
  if (this instanceof HTMLElement || this instanceof SVGElement) this.blur();
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
export const BLUR_SOURCE = blurActiveElement.toString();
export const BLUR_SELF_SOURCE = blurSelf.toString();
/** Ends the transitions a cleared state started, so the page is back at rest for whatever measures next. */
export const FINISH_ALL_TRANSITIONS_SOURCE = finishAllTransitions.toString();
