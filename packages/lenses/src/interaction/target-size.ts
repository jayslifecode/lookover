import type { Box } from '@jayslifecode/lookover-core';

/** WCAG 2.2 2.5.8 (Target Size, Minimum): a target is at least this many CSS pixels wide and tall. */
export const MIN_TARGET_PX = 24;
/** The spacing exception's circle is `MIN_TARGET_PX` across, so it reaches this far from a target's centre. */
const SPACING_RADIUS_PX = MIN_TARGET_PX / 2;
const HALF = 2;

export type TargetSizeResult = { ok: true } | { ok: false; nearest: number };

/**
 * Whether `target` is big enough to tap, given the boxes of the other targets around it (WCAG 2.2
 * 2.5.8). A target at least 24 by 24 px passes. A smaller one passes by the spacing exception when the
 * 24 px circle centred on it meets no other box, that is when the distance from its centre to every
 * other box is at least 12 px (a box exactly 12 px away only touches the circle). Otherwise it fails,
 * and `nearest` is the smallest of those distances, in CSS pixels (0 when the centre is inside a box).
 */
export function passesTargetSize(target: Box, others: readonly Box[]): TargetSizeResult {
  if (target.width >= MIN_TARGET_PX && target.height >= MIN_TARGET_PX) {
    return { ok: true };
  }
  const centre = { x: target.x + target.width / HALF, y: target.y + target.height / HALF };
  const nearest = Math.min(...others.map((other) => distanceToBox(centre, other)));
  return nearest < SPACING_RADIUS_PX ? { ok: false, nearest } : { ok: true };
}

/** The distance from a point to the closest point of a box, 0 for a point inside it. */
function distanceToBox(point: { x: number; y: number }, box: Box): number {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width));
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height));
  return Math.hypot(dx, dy);
}
