import type { ElementRef } from '@jayslifecode/lookover-core';
import type { CDPSession } from 'playwright';
import { COMPONENT_NAME_SOURCE } from './in-page.js';
import { measureOn } from './measure.js';

/*
 * What names an element beyond its selector: the React component that rendered it and its class
 * signature, the key controls that look alike share.
 */

/** Runs in the page, so it stays self-contained (see `in-page.ts`). */
function classList(this: Element): string[] {
  return Array.from(this.classList).toSorted();
}

export interface Identity {
  componentName: string | null;
  classes: string[];
}

/** What a finding's target says about the element besides where it is. */
export interface TargetIdentity {
  componentName: string | null;
  signature: string | null;
}

/**
 * `{ componentName, classes }`: the React component (`COMPONENT_NAME_SOURCE`) and the sorted class list;
 * `null` for an element no longer in the document.
 */
export const IDENTITY_SOURCE = `function () { if (!this.isConnected) return null; return { componentName: (${COMPONENT_NAME_SOURCE}).call(this), classes: (${classList.toString()}).call(this) }; }`;

/**
 * An element's class signature: its tag and its sorted class list, joined by `.`
 * (`button.btn.primary`). Controls that share one look alike, so the gallery crops one control per
 * signature and findings can be grouped by it.
 */
export function signatureOf(tag: string, classes: readonly string[]): string {
  return [tag, ...classes].join('.');
}

/**
 * The element's React component and class signature, read in the page (by backend node id when it has
 * one, else by selector); both `null` when it cannot be read there.
 */
export async function targetIdentityOf(
  cdp: CDPSession,
  element: Pick<ElementRef, 'selector' | 'backendNodeId'>,
  tag: string,
): Promise<TargetIdentity> {
  const identity = await measureOn<Identity>(cdp, element, IDENTITY_SOURCE);
  if (identity === null) return { componentName: null, signature: null };
  return { componentName: identity.componentName, signature: signatureOf(tag, identity.classes) };
}
