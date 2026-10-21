import type { CDPSession } from 'playwright';
import type { Box } from '../map/types.js';

/** One node of Chromium's full accessibility tree, reduced to what the map needs. */
export interface AXNode {
  nodeId: string;
  role: string;
  name: string;
  ignored: boolean;
  /** Absent for nodes with no DOM element behind them (e.g. the root web area's text runs). */
  backendDOMNodeId?: number;
  /** `AXProperty.name` → its value, e.g. `{ focusable: true, disabled: false }`. */
  properties: Record<string, unknown>;
  /** Child node ids in tree order, ignored children included; `[]` for a leaf. */
  childIds: string[];
}

/** A pseudo-class `forcePseudoState` can force on an element. */
export type PseudoState = 'hover' | 'focus' | 'focus-visible' | 'active';

const QUAD_POINTS = 4;
/** What `DOM.pushNodesByBackendIdsToFrontend` fails with until a `DOM.getDocument` for the current document. */
const DOCUMENT_NOT_REQUESTED = 'Document needs to be requested first';
/** The node id `DOM.querySelector` returns when nothing matches. */
const NO_NODE = 0;
/** The CDP sessions `forcePseudoState` has enabled the DOM and CSS domains on. */
const cssEnabledSessions = new WeakSet<CDPSession>();

/**
 * Every node of the main frame's accessibility tree. Chromium lists them breadth-first, not in
 * reading order; walk `childIds` from the root for that.
 */
export async function getAXTree(cdp: CDPSession): Promise<AXNode[]> {
  await cdp.send('DOM.enable');
  await cdp.send('Accessibility.enable');
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  return nodes.map((node) => ({
    nodeId: node.nodeId,
    role: stringValue(node.role?.value),
    name: stringValue(node.name?.value),
    ignored: node.ignored,
    ...(node.backendDOMNodeId === undefined ? {} : { backendDOMNodeId: node.backendDOMNodeId }),
    properties: Object.fromEntries(
      (node.properties ?? []).map((property) => [property.name, property.value.value]),
    ),
    childIds: node.childIds ?? [],
  }));
}

/**
 * The element's border box in CSS pixels. `null` when the node has no layout (detached,
 * `display: none`, unknown id; `DOM.getBoxModel` throws for those) or when the box has no area.
 */
export async function boxFor(cdp: CDPSession, backendDOMNodeId: number): Promise<Box | null> {
  const border = await cdp.send('DOM.getBoxModel', { backendNodeId: backendDOMNodeId }).then(
    ({ model }) => model.border,
    // No layout box is an expected answer for many nodes, not a failure of the caller.
    () => null,
  );
  return border === null ? null : quadToBox(border);
}

/** A remote object id for the element, for use with `callOnNode`. */
export async function resolveBackendNode(cdp: CDPSession, backendDOMNodeId: number): Promise<string> {
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: backendDOMNodeId });
  if (object.objectId === undefined) {
    throw new Error(`DOM.resolveNode returned no object id for backend node ${backendDOMNodeId}`);
  }
  return object.objectId;
}

/**
 * A remote object id for the first element `selector` matches in the main frame's document, for use
 * with `callOnNode`; `null` when nothing matches. A selector the browser cannot parse rejects.
 *
 * It requests the document (`DOM.getDocument`), and Chromium then discards the node ids it handed out
 * before, together with the pseudo states forced through them (see `forcePseudoState`). Remote object
 * ids are not affected.
 */
export async function resolveSelector(cdp: CDPSession, selector: string): Promise<string | null> {
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (nodeId === NO_NODE) {
    return null;
  }
  const { object } = await cdp.send('DOM.resolveNode', { nodeId });
  if (object.objectId === undefined) {
    throw new Error(`DOM.resolveNode returned no object id for ${selector}`);
  }
  return object.objectId;
}

/**
 * The DOM node ids (what `DOM.*` and `CSS.*` commands take) of the elements with these backend node
 * ids, in the same order; `0` for one that is not in the current document.
 *
 * Chromium hands out node ids only after the document has been requested. The document is requested
 * only when it has not been yet (a new CDP session, or a new document after a navigation), so the
 * ids an earlier call returned for the same document stay valid.
 */
export async function pushNodes(cdp: CDPSession, backendNodeIds: readonly number[]): Promise<number[]> {
  const push = async (): Promise<number[]> => {
    const { nodeIds } = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', {
      backendNodeIds: [...backendNodeIds],
    });
    return nodeIds;
  };
  try {
    return await push();
  } catch (error) {
    if (!(error instanceof Error && error.message.includes(DOCUMENT_NOT_REQUESTED))) {
      throw error;
    }
  }
  await cdp.send('DOM.getDocument', { depth: 0 });
  return push();
}

/**
 * Forces `states` on the element with DOM node id `nodeId` (see `pushNodes`) until they are cleared
 * with `[]`, so its computed style is the one that state shows. The DOM and CSS domains are enabled
 * the first time a CDP session is used here.
 *
 * A state forced through a node id outlives that id: once the document is requested again
 * (`resolveSelector`), it can no longer be cleared, and Chromium drops it only at the element's next
 * style recalculation, so its computed style can still show it. Force, measure and clear without
 * requesting the document in between (measure by backend node id, not by selector).
 */
export async function forcePseudoState(
  cdp: CDPSession,
  nodeId: number,
  states: readonly PseudoState[],
): Promise<void> {
  if (!cssEnabledSessions.has(cdp)) {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    cssEnabledSessions.add(cdp);
  }
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [...states] });
}

/**
 * Gives the element with this backend node id keyboard focus for real (CDP `DOM.focus`), as a script's
 * `element.focus()` does: its `focus` and `focusin` events fire, so a style a focus listener sets shows.
 * Unlike `forcePseudoState`, it needs no node id, so it does not request the document. Rejects when the
 * element cannot take focus or is gone.
 */
export async function focusBackendNode(cdp: CDPSession, backendNodeId: number): Promise<void> {
  await cdp.send('DOM.focus', { backendNodeId });
}

/**
 * Stops the page's pending navigation (CDP `Page.stopLoading`), as the browser's stop button does. A
 * navigation that never finishes (a reload whose answer never comes) otherwise keeps the page waiting
 * for it: Playwright's `setViewportSize` and `evaluate` hang until it commits.
 */
export async function stopLoading(cdp: CDPSession): Promise<void> {
  await cdp.send('Page.stopLoading');
}

/**
 * Calls `fnSource` (a function declaration; `this` is the element) with `args` and returns its
 * result by value. Rejects when the function throws in the page.
 */
export async function callOnNode<T>(
  cdp: CDPSession,
  objectId: string,
  fnSource: string,
  args: readonly unknown[] = [],
): Promise<T> {
  const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: fnSource,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
  });
  if (exceptionDetails !== undefined) {
    const reason = exceptionDetails.exception?.description ?? exceptionDetails.text;
    throw new Error(`callOnNode: the function threw in the page: ${reason}`);
  }
  return result.value as T;
}

function quadToBox(quad: readonly number[]): Box | null {
  if (quad.length !== QUAD_POINTS * 2) {
    return null;
  }
  const xs = quad.filter((_, index) => index % 2 === 0);
  const ys = quad.filter((_, index) => index % 2 === 1);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
