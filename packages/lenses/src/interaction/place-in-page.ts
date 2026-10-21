import type { Box } from '@jayslifecode/lookover-core';

/*
 * Runs in the page, so it stays self-contained (see `in-page.ts`): an element source on its own, and
 * a helper other in-page sources are handed.
 */

export interface Placement {
  /** The border box in viewport coordinates, once it has been scrolled into view. */
  rect: Box;
  viewportWidth: number;
  viewportHeight: number;
}

/**
 * Scrolls the element to the middle of the viewport at once and says where it landed (`Placement`);
 * `null` for an element no longer in the document.
 */
export function placeInView(this: Element): Placement | null {
  if (!this.isConnected) return null;
  this.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  const { x, y, width, height } = this.getBoundingClientRect();
  const { clientWidth, clientHeight } = document.documentElement;
  return { rect: { x, y, width, height }, viewportWidth: clientWidth, viewportHeight: clientHeight };
}

export const PLACE_IN_VIEW_SOURCE: string = placeInView.toString();
