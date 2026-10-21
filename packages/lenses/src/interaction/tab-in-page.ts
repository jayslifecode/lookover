import { type Box, BUILD_SELECTOR_SOURCE, type SelectorCandidate } from '@jayslifecode/lookover-core';
import type { SelectorBuilder } from './in-page.js';
import { BLUR_SOURCE } from './states-in-page.js';

/*
 * What the Tab walk reads and does inside the page. Like `in-page.ts`, each `*_SOURCE` is the source
 * text of a function that runs in the page, so the functions here stay self-contained: no imports and
 * no references to module scope (types are fine, they are erased). What a function needs besides the
 * page is passed in by its `*_SOURCE` wrapper.
 */

/** Why a focused element cannot be seen; see `ACTIVE_ELEMENT_SOURCE`. */
export type FocusHiddenReason = 'zero-size' | 'visibility' | 'opacity' | 'offscreen';

export interface ActiveElement {
  /** `null` when focus is on the body, or the selectors do not find the element again (a shadow tree). */
  selector: SelectorCandidate | null;
  tag: string;
  /** The border box in document coordinates. */
  box: Box;
  /** Nothing has focus: `document.activeElement` is the body (or the root). */
  isBody: boolean;
  hidden: FocusHiddenReason | null;
  /**
   * Where focus is inside the active element's open shadow roots, outermost first, as
   * `<tag>#<position in the root>` steps joined with ` >> `; empty when it is not inside any. The
   * active element stays the shadow host while Tab moves between the controls in its shadow tree.
   */
  inner: string;
  /**
   * A native control Tab crosses in several presses while it stays the active element, because the
   * browser draws its parts: a date, time, datetime-local, month or week `<input>`, and a `<video>`
   * or `<audio>` with `controls`.
   */
  isMultiPart: boolean;
}

/** The helpers `activeElement` is given, so that each of them is a function of its own. */
interface ActiveElementHelpers {
  boxOf: typeof boxOf;
  selectorOf: typeof selectorOf;
  isMultiPart: typeof isMultiPart;
  innerSteps: typeof innerSteps;
  hiddenReason: typeof hiddenReason;
}

function boxOf(el: Element): Box {
  const rect = el.getBoundingClientRect();
  return { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height };
}

function selectorOf(el: Element, buildSelector: SelectorBuilder): SelectorCandidate | null {
  const candidate = buildSelector(el);
  const resolvesToEl = (selector: string): boolean => document.querySelector(selector) === el;
  return resolvesToEl(candidate.selector) && resolvesToEl(candidate.path) ? candidate : null;
}

function isMultiPart(el: Element): boolean {
  const MULTI_PART_INPUT_TYPES = ['date', 'time', 'datetime-local', 'month', 'week'];
  if (el instanceof HTMLInputElement) return MULTI_PART_INPUT_TYPES.includes(el.type);
  return (el instanceof HTMLVideoElement || el instanceof HTMLAudioElement) && el.controls;
}

function innerSteps(el: Element): string[] {
  const steps: string[] = [];
  let host: Element = el;
  let inside = host.shadowRoot?.activeElement ?? null;
  while (inside !== null) {
    const position = Array.from(host.shadowRoot?.querySelectorAll('*') ?? []).indexOf(inside);
    steps.push(`${inside.localName}#${position}`);
    host = inside;
    inside = host.shadowRoot?.activeElement ?? null;
  }
  return steps;
}

function hiddenReason(el: Element, box: Box): FocusHiddenReason | null {
  const root = document.documentElement;
  const isTransparent = (node: Element | null): boolean =>
    node !== null &&
    (Number.parseFloat(getComputedStyle(node).opacity) === 0 || isTransparent(node.parentElement));
  if (box.width === 0 || box.height === 0) return 'zero-size';
  if (getComputedStyle(el).visibility !== 'visible') return 'visibility';
  if (isTransparent(el)) return 'opacity';
  const isOutside =
    box.x + box.width <= 0 ||
    box.y + box.height <= 0 ||
    box.x >= root.scrollWidth ||
    box.y >= root.scrollHeight;
  return isOutside ? 'offscreen' : null;
}

function activeElement(buildSelector: SelectorBuilder, helpers: ActiveElementHelpers): ActiveElement {
  const { boxOf, selectorOf, isMultiPart, innerSteps, hiddenReason } = helpers;
  const root = document.documentElement;
  const active = document.activeElement ?? document.body ?? root;
  const isBody = active === document.body || active === root;
  const box = boxOf(active);
  return {
    selector: isBody ? null : selectorOf(active, buildSelector),
    tag: active.localName,
    box,
    isBody,
    hidden: isBody ? null : hiddenReason(active, box),
    inner: innerSteps(active).join(' >> '),
    isMultiPart: isMultiPart(active),
  };
}

const ACTIVE_ELEMENT_HELPERS_SOURCE = `{ boxOf: ${boxOf.toString()}, selectorOf: ${selectorOf.toString()}, isMultiPart: ${isMultiPart.toString()}, innerSteps: ${innerSteps.toString()}, hiddenReason: ${hiddenReason.toString()} }`;

/**
 * What has keyboard focus, as
 * `{ selector: { selector, path } | null, tag, box, isBody, hidden, inner, isMultiPart }`
 * (`ActiveElement`). `selector` is the selector builder's pair (the Node side stores the one
 * `stableSelector` picks), `null` when focus is on the body or the pair does not find the element
 * again (a shadow tree). `hidden` says why a person could not see the focused element: its box has no
 * area (`zero-size`), it is not `visibility: visible`, it or an ancestor has `opacity: 0`, or its box
 * lies entirely outside the document (`offscreen`, e.g. `left: -9999px`); `null` when it can be seen.
 * Read it after focus has landed, so an element that shows itself on `:focus` (a skip link) reads as
 * visible. `inner` and `isMultiPart` say when Tab moves focus without changing the active element:
 * see `ActiveElement`.
 */
export const ACTIVE_ELEMENT_SOURCE = `() => (${activeElement.toString()})(${BUILD_SELECTOR_SOURCE}, ${ACTIVE_ELEMENT_HELPERS_SOURCE})`;

/**
 * Blurring is not enough to start Tab at the top: Chromium goes on from the element that last had
 * focus, or was last clicked, so the controls before it would never be reached. Focusing the body
 * (it has to be given a `tabindex` for that, put back at once) moves that starting point to the top.
 */
function restartTabOrder(blur: () => void): void {
  blur();
  const { body } = document;
  const tabindex = body.getAttribute('tabindex');
  body.tabIndex = -1;
  body.focus({ preventScroll: true });
  body.blur();
  if (tabindex === null) body.removeAttribute('tabindex');
  else body.setAttribute('tabindex', tabindex);
  window.scrollTo(0, 0);
}

/** Back to the top of the page with nothing focused, so the first Tab press lands on the first control. */
export const RESTART_TAB_ORDER_SOURCE = `() => (${restartTabOrder.toString()})(${BLUR_SOURCE})`;
