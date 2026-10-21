import type { Box } from '@jayslifecode/lookover-core';
import { describe, expect, test } from 'vitest';
import { MIN_TARGET_PX, passesTargetSize } from '../src/interaction/target-size.js';

const SMALL_SIDE = 16;

function box(x: number, y: number, width: number, height: number): Box {
  return { x, y, width, height };
}

/** A 16 px square at the origin, whose centre is (8, 8): its 24 px circle reaches 12 px from there. */
const SMALL = box(0, 0, SMALL_SIDE, SMALL_SIDE);

describe('passesTargetSize', () => {
  test('the minimum is 24 px', () => {
    expect(MIN_TARGET_PX).toBe(24);
  });

  test('passes a target that is at least 24 by 24, however crowded it is', () => {
    const crowding = [box(24, 0, SMALL_SIDE, SMALL_SIDE), box(0, 24, SMALL_SIDE, SMALL_SIDE)];

    expect(passesTargetSize(box(0, 0, 24, 24), crowding)).toEqual({ ok: true });
    expect(passesTargetSize(box(0, 0, 100, 40), crowding)).toEqual({ ok: true });
  });

  test('passes a small target with nothing near it, or with nothing else on the screen', () => {
    expect(passesTargetSize(SMALL, [])).toEqual({ ok: true });
    expect(passesTargetSize(SMALL, [box(200, 200, 40, 40)])).toEqual({ ok: true });
  });

  test('fails a small target with another box within 12 px of its centre, naming the distance', () => {
    // The other box starts at x = 19: 11 px from the centre (8, 8), inside the 12 px radius.
    const result = passesTargetSize(SMALL, [box(19, 0, SMALL_SIDE, SMALL_SIDE)]);

    expect(result).toEqual({ ok: false, nearest: 11 });
  });

  test('passes when the other box is 13 px from the centre', () => {
    expect(passesTargetSize(SMALL, [box(21, 0, SMALL_SIDE, SMALL_SIDE)])).toEqual({ ok: true });
  });

  test('passes when the other box is exactly 12 px from the centre: the circle touches it, it does not meet it', () => {
    expect(passesTargetSize(SMALL, [box(20, 0, SMALL_SIDE, SMALL_SIDE)])).toEqual({ ok: true });
  });

  test('fails a target 23 px wide and 24 px tall when another box touches it', () => {
    // The centre is (11.5, 12); a box starting at x = 23 is 11.5 px away.
    expect(passesTargetSize(box(0, 0, 23, 24), [box(23, 0, 40, 24)])).toEqual({ ok: false, nearest: 11.5 });
  });

  test('fails a target 24 px wide and 23 px tall when another box touches it, and passes it when none does', () => {
    const target = box(0, 0, 24, 23);

    expect(passesTargetSize(target, [box(0, 23, 24, 24)])).toEqual({ ok: false, nearest: 11.5 });
    expect(passesTargetSize(target, [box(0, 40, 24, 24)])).toEqual({ ok: true });
  });

  test('measures from the centre to the nearest edge of a box beside it, not to its centre', () => {
    // The box spans x 10 to 60 and y 0 to 50, so the centre (8, 8) is 2 px from its left edge.
    expect(passesTargetSize(SMALL, [box(10, 0, 50, 50)])).toEqual({ ok: false, nearest: 2 });
  });

  test('measures a box at a diagonal to its corner', () => {
    // The corner (11, 12) is 3 px right and 4 px below the centre: 5 px.
    expect(passesTargetSize(SMALL, [box(11, 12, 30, 30)])).toEqual({ ok: false, nearest: 5 });
  });

  test('is a distance of 0 when the centre lies inside another box', () => {
    expect(passesTargetSize(SMALL, [box(-4, -4, 40, 40)])).toEqual({ ok: false, nearest: 0 });
  });

  test('names the smallest of several distances', () => {
    const others = [
      box(60, 0, SMALL_SIDE, SMALL_SIDE),
      box(0, 17, SMALL_SIDE, SMALL_SIDE),
      box(19, 0, 16, 16),
    ];

    expect(passesTargetSize(SMALL, others)).toEqual({ ok: false, nearest: 9 });
  });
});
