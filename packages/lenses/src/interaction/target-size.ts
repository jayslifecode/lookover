import type { Box } from '@jayslifecode/lookover-core';

/** WCAG 2.2 2.5.8 (Target Size, Minimum): a target is at least this many CSS pixels wide and tall. */
export const MIN_TARGET_PX = 24;
/** The spacing exception's circle is `MIN_TARGET_PX` across, so it reaches this far from a target's centre. */
const SPACING_RADIUS_PX = MIN_TARGET_PX / 2;
const HALF = 2;

export type TargetSizeResult = { ok: true } | { ok: false; nearest: number };

interface Point {
  x: number;
  y: number;
}

/**
 * Whether `target` is big enough to tap, given the boxes of the other targets around it (WCAG 2.2
 * 2.5.8). A target at least 24 by 24 px passes. A smaller one passes by the spacing exception only when
 * the 24 px circle centred on it (radius 12)
 *
 * - meets no other target's box: the distance from its centre to every other box is at least 12 px (a
 *   box exactly 12 px away only touches the circle), and
 * - does not intersect the circle of any other undersized target: the distance between the two
 *   centres is at least 24 px (circles exactly 24 px apart only touch).
 *
 * Otherwise it fails, and `nearest` is the smallest distance from its centre to another box, in CSS
 * pixels (0 when the centre is inside a box), whichever of the two conditions it fails.
 *
 * A box that contains the target (a listbox around its option rows) or that the target contains (an
 * icon inside its button) is not another target next to it, so it counts for neither. A box that only
 * overlaps the target does.
 */
export function passesTargetSize(target: Box, others: readonly Box[]): TargetSizeResult {
  if (!isUndersized(target)) {
    return { ok: true };
  }
  const centre = centreOf(target);
  const neighbours = others.filter((other) => !contains(other, target) && !contains(target, other));
  const nearest = Math.min(...neighbours.map((other) => distanceToBox(centre, other)));
  const isTooClose = nearest < SPACING_RADIUS_PX;
  const circlesMeet = neighbours.some(
    (other) => isUndersized(other) && distanceBetween(centre, centreOf(other)) < MIN_TARGET_PX,
  );
  return isTooClose || circlesMeet ? { ok: false, nearest } : { ok: true };
}

function isUndersized({ width, height }: Box): boolean {
  return width < MIN_TARGET_PX || height < MIN_TARGET_PX;
}

function centreOf(box: Box): Point {
  return { x: box.x + box.width / HALF, y: box.y + box.height / HALF };
}

function distanceBetween(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The distance from a point to the closest point of a box, 0 for a point inside it. */
function distanceToBox(point: Point, box: Box): number {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width));
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height));
  return Math.hypot(dx, dy);
}

/** Whether `inner` lies entirely within `outer`, edges included. */
function contains(outer: Box, inner: Box): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}
