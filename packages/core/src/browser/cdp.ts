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

const QUAD_POINTS = 4;

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
