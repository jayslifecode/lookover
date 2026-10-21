import {
  callOnNode,
  type ElementRef,
  resolveBackendNode,
  resolveSelector,
} from '@jayslifecode/lookover-core';
import type { CDPSession, Page } from 'playwright';

/**
 * What `DOM.resolveNode` fails with when the element is gone: no node has the backend node id any
 * more (it was collected), or the node is alive but no longer in the page's document (the document
 * was replaced, e.g. by a reload). Any other failure (a closed session or target) is not about the
 * element and is rethrown.
 */
const GONE_NODE_ERRORS: readonly string[] = [
  'No node with given id found',
  'Node with given id does not belong to the document',
];

/**
 * Runs an element source (see `in-page.ts`) with `this` bound to the element and `args` passed to it,
 * and returns its result. The element is found by its backend node id when it has one, else by its
 * selector; `null` when it cannot be found (removed, or gone with the document it was in). Any other
 * failure, a closed CDP session or an error the source throws in the page, is rethrown.
 *
 * Finding it by selector requests the document, which drops the pseudo states forced before (see
 * `forcePseudoState`): measure a forced state by backend node id.
 */
export async function measureOn<T>(
  cdp: CDPSession,
  element: Pick<ElementRef, 'selector' | 'backendNodeId'>,
  source: string,
  args: readonly unknown[] = [],
): Promise<T | null> {
  const objectId = await resolveElement(cdp, element);
  if (objectId === null) {
    return null;
  }
  try {
    return await callOnNode<T>(cdp, objectId, source, args);
  } finally {
    // Best effort: a failed release means the page's context is gone, which frees the handle too.
    await cdp.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
  }
}

/** Calls an element-less source (see `in-page.ts`) in the page and returns its result. */
export function evaluateSource<T>(page: Page, source: string): Promise<T> {
  // `page.evaluate` runs a string as an expression rather than calling it, so the call is spelled out.
  return page.evaluate<T>(`(${source})()`);
}

async function resolveElement(
  cdp: CDPSession,
  element: Pick<ElementRef, 'selector' | 'backendNodeId'>,
): Promise<string | null> {
  if (element.backendNodeId === undefined) {
    return resolveSelector(cdp, element.selector);
  }
  return resolveBackendNode(cdp, element.backendNodeId).catch((error: unknown) => {
    if (isGoneNodeError(error)) {
      return null;
    }
    throw error;
  });
}

function isGoneNodeError(error: unknown): boolean {
  return error instanceof Error && GONE_NODE_ERRORS.some((message) => error.message.includes(message));
}
