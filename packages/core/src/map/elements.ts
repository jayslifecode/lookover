import type { CDPSession } from 'playwright';
import { type AXNode, callOnNode, getAXTree, resolveBackendNode } from '../browser/cdp.js';
import type { InstrumentedPage } from '../browser/session.js';
import { BUILD_SELECTOR_SOURCE } from './selectors.js';
import type { Box, ElementRef } from './types.js';

/** Accessibility roles of the widgets a user can operate; every other role is structure or text. */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'slider',
  'spinbutton',
  'switch',
  'tab',
]);

/** Past this many interactive elements a screen is truncated; the caller reports it. */
export const MAX_ELEMENTS_PER_SCREEN = 500;

/**
 * How many elements are measured at once: enough to overlap the CDP round trips, few enough to keep
 * the number of requests in flight bounded on a large screen.
 */
const CONCURRENT_ELEMENTS = 50;

type InteractiveAXNode = AXNode & { backendDOMNodeId: number };

/** What the page reports about one element (see `measureElement`). */
interface MeasuredElement {
  selector: string;
  tag: string;
  box: Box;
  disabled: boolean;
  focusable: boolean;
}

/**
 * Runs in the page with `this` bound to the element, so it must stay self-contained. `buildSelector`
 * is `BUILD_SELECTOR_SOURCE`, passed in by `MEASURE_ELEMENT_SOURCE`.
 *
 * The box is the border box in document coordinates (viewport rect plus scroll offset), so it lands
 * on full-page screenshots. An element whose selector does not resolve to it (one inside a shadow
 * tree) is reported as `null`: a replay could never find it again.
 */
function measureElement(this: Element, buildSelector: (el: Element) => string): MeasuredElement | null {
  const selector = buildSelector(this);
  if (document.querySelector(selector) !== this) {
    return null;
  }
  const rect = this.getBoundingClientRect();
  const disabled = this.matches(':disabled') || this.getAttribute('aria-disabled') === 'true';
  const tabIndex = (this as Element & Partial<HTMLOrSVGElement>).tabIndex ?? -1;
  return {
    selector,
    tag: this.localName,
    box: { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height },
    disabled,
    focusable: !disabled && tabIndex >= 0,
  };
}

const MEASURE_ELEMENT_SOURCE = `function () { return (${measureElement.toString()}).call(this, ${BUILD_SELECTOR_SOURCE}); }`;

/**
 * The interactive elements of the page as assistive technology sees them: non-ignored nodes of the
 * accessibility tree with an interactive role, in reading order. Each gets a selector that resolves
 * to exactly that element and its box in document coordinates.
 *
 * Only the first `MAX_ELEMENTS_PER_SCREEN` candidates are measured; `total` counts all of them, so
 * the caller can tell the screen was truncated. Candidates without area (hidden, collapsed), whose
 * DOM node can no longer be resolved, or that a document selector cannot reach (shadow trees) are
 * left out of `elements`. Elements in other frames are not in the main frame's tree.
 */
export async function extractElements(
  ipage: InstrumentedPage,
): Promise<{ elements: ElementRef[]; total: number }> {
  const candidates = inReadingOrder(await getAXTree(ipage.cdp)).filter(isInteractive);
  const measured = await mapInChunks(
    candidates.slice(0, MAX_ELEMENTS_PER_SCREEN),
    CONCURRENT_ELEMENTS,
    (node) => measureNode(ipage.cdp, node),
  );
  return {
    elements: measured.filter((element): element is ElementRef => element !== null),
    total: candidates.length,
  };
}

/**
 * The nodes depth-first from the root, which is reading order; `getAXTree` lists them breadth-first,
 * which would put a shallow footer link ahead of the main content. A child id with no listed node
 * (an iframe's document) is skipped.
 */
function inReadingOrder(nodes: readonly AXNode[]): AXNode[] {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const childIds = new Set(nodes.flatMap((node) => node.childIds));
  const walk = (node: AXNode): AXNode[] => [
    node,
    ...node.childIds.flatMap((id) => {
      const child = byId.get(id);
      return child === undefined ? [] : walk(child);
    }),
  ];
  return nodes.filter((node) => !childIds.has(node.nodeId)).flatMap(walk);
}

function isInteractive(node: AXNode): node is InteractiveAXNode {
  return !node.ignored && INTERACTIVE_ROLES.has(node.role) && node.backendDOMNodeId !== undefined;
}

async function measureNode(cdp: CDPSession, node: InteractiveAXNode): Promise<ElementRef | null> {
  const objectId = await resolveBackendNode(cdp, node.backendDOMNodeId).catch(() => null);
  if (objectId === null) {
    // The node went away between reading the tree and resolving it: nothing left to measure.
    return null;
  }
  try {
    const measured = await callOnNode<MeasuredElement | null>(cdp, objectId, MEASURE_ELEMENT_SOURCE);
    if (measured === null || !hasArea(measured.box)) {
      return null;
    }
    return {
      selector: measured.selector,
      role: node.role,
      name: node.name,
      tag: measured.tag,
      box: measured.box,
      backendNodeId: node.backendDOMNodeId,
      disabled: axFlag(node, 'disabled') ?? measured.disabled,
      focusable: axFlag(node, 'focusable') ?? measured.focusable,
    };
  } finally {
    // Best effort: a failed release means the page's context is gone, which frees the handle too.
    await cdp.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
  }
}

function hasArea(box: Box): boolean {
  return box.width > 0 && box.height > 0;
}

/** A boolean AX property; `undefined` when the tree does not state it. */
function axFlag(node: AXNode, property: 'disabled' | 'focusable'): boolean | undefined {
  const value = node.properties[property];
  return typeof value === 'boolean' ? value : undefined;
}

/** `fn` over `items`, at most `size` calls in flight at a time, results in input order. */
async function mapInChunks<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  let results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    const chunk = await Promise.all(items.slice(start, start + size).map(fn));
    results = [...results, ...chunk];
  }
  return results;
}
