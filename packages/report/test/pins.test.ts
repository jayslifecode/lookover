// @vitest-environment node
import type { Finding, Severity, StepFinding } from '@jayslifecode/lookover-core';
import { expect, test } from 'vitest';
import {
  DOT_SIZE,
  LABEL_GAP,
  LABEL_HEIGHT,
  LABEL_INSET,
  type PinPlacement,
  placePins,
  type ScreenshotBox,
} from '../src/screens/pins';
import { occurrenceFinding, stepFinding } from './fixture';

/*
 * The screenshot in these tests is 1440 px wide, as the bench captures it, shown at half that width, so
 * every box is halved; the dot's top-left corner is then 12 px left of and above the target's top-right.
 */

const NATURAL_WIDTH = 1440;
const DISPLAYED_WIDTH = 720;
const SHOWN: ScreenshotBox = { width: DISPLAYED_WIDTH, height: 1200 };
const LABEL_WIDTH = 200;
const HALF_DOT = DOT_SIZE / 2;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A confirmed step finding whose target has `box`, in the screenshot's own (natural) pixels. */
function pinned(
  id: string,
  box: Box,
  overrides: { severity?: Severity; signature?: string; title?: string } = {},
): StepFinding {
  const finding = stepFinding({ id, signature: overrides.signature ?? `sig-${id}`, ...overrides });
  if (finding.target === null) throw new Error('The fixture step finding has no target');
  return { ...finding, target: { ...finding.target, box } };
}

/** The same label width for every finding, as the report measures it. */
function widths(findings: readonly Finding[], width = LABEL_WIDTH): ReadonlyMap<string, number> {
  return new Map(findings.map((finding) => [finding.id, width]));
}

function byId(placements: readonly PinPlacement[]): Record<string, PinPlacement> {
  return Object.fromEntries(placements.map((placement) => [placement.finding.id, placement]));
}

test("scales the target's box to the displayed width and puts the dot on its top-right corner", () => {
  const finding = pinned('a', { x: 1000, y: 400, width: 40, height: 20 });

  const [placement] = placePins([finding], NATURAL_WIDTH, DISPLAYED_WIDTH, SHOWN, widths([finding]));

  // The box's right edge is 1040 natural px, 520 displayed; its top 400, 200 displayed.
  expect(placement).toMatchObject({ number: 1, left: 520 - HALF_DOT, top: 200 - HALF_DOT });
  expect(placement?.finding.id).toBe('a');
  // At full size nothing is scaled.
  const [full] = placePins([finding], NATURAL_WIDTH, NATURAL_WIDTH, { width: 1440, height: 2400 });
  expect(full).toMatchObject({ left: 1040 - HALF_DOT, top: 400 - HALF_DOT });
});

test('keeps the dot inside the screenshot when the target touches its edge', () => {
  const corner = pinned('corner', { x: 0, y: 0, width: 1440, height: 10 });

  const [placement] = placePins([corner], NATURAL_WIDTH, DISPLAYED_WIDTH, SHOWN);

  expect(placement).toMatchObject({ left: DISPLAYED_WIDTH - DOT_SIZE, top: 0 });
});

test('the label sits above the dot, and flips below when it would cover another dot', () => {
  // `under` is 30 displayed px below `over`: its label above (8 px gap, 28 px tall) would cover `over`'s dot.
  const over = pinned('over', { x: 500, y: 400, width: 100, height: 20 });
  const under = pinned('under', { x: 500, y: 460, width: 100, height: 20 });
  // `apart` is far enough below that its label clears `under`'s dot.
  const apart = pinned('apart', {
    x: 500,
    y: 460 + 2 * (DOT_SIZE + LABEL_GAP + LABEL_HEIGHT),
    width: 100,
    height: 20,
  });
  const findings = [over, under, apart];

  const placed = byId(placePins(findings, NATURAL_WIDTH, DISPLAYED_WIDTH, SHOWN, widths(findings)));

  expect(placed.over?.label).toBe('above');
  expect(placed.under?.label).toBe('below');
  expect(placed.apart?.label).toBe('above');
});

test('the label flips below when there is no room above it inside the screenshot', () => {
  const top = pinned('top', { x: 500, y: 40, width: 100, height: 20 });

  const [placement] = placePins([top], NATURAL_WIDTH, DISPLAYED_WIDTH, SHOWN, widths([top]));

  // The dot's top is at 8 px: a label above would start at 8 - 8 - 28 = -28.
  expect(placement?.label).toBe('below');
});

test('the label slides sideways to stay inside the screenshot, and stays centred when it fits', () => {
  const nearRight = pinned('right', { x: 1280, y: 600, width: 120, height: 20 });
  const nearLeft = pinned('left', { x: 0, y: 900, width: 40, height: 20 });
  const middle = pinned('middle', { x: 600, y: 1200, width: 100, height: 20 });
  const findings = [nearRight, nearLeft, middle];

  const placed = byId(placePins(findings, NATURAL_WIDTH, DISPLAYED_WIDTH, SHOWN, widths(findings)));

  // Right: the dot's centre is at 700, so the centred label would end at 800; it ends at 720 - 8 instead.
  expect(placed.right?.labelShift).toBe(DISPLAYED_WIDTH - LABEL_INSET - (700 + LABEL_WIDTH / 2));
  // Left: the dot's centre is at 20, so the centred label would start at -80; it starts at 8 instead.
  expect(placed.left?.labelShift).toBe(LABEL_INSET - (20 - LABEL_WIDTH / 2));
  expect(placed.middle?.labelShift).toBe(0);
});

test('a label wider than the screenshot is cut to its width less the insets', () => {
  const finding = pinned('long', { x: 600, y: 600, width: 100, height: 20 });
  const narrow: ScreenshotBox = { width: 300, height: 1200 };

  const [placement] = placePins([finding], NATURAL_WIDTH, 300, narrow, widths([finding], 900));

  expect(placement?.labelWidth).toBe(300 - 2 * LABEL_INSET);
  // Its left edge then sits on the inset.
  const centre = (placement?.left ?? 0) + HALF_DOT;
  expect(centre - (placement?.labelWidth ?? 0) / 2 + (placement?.labelShift ?? 0)).toBe(LABEL_INSET);
});

test('a label not measured yet is given a width from its title', () => {
  const short = pinned('short', { x: 600, y: 600, width: 100, height: 20 }, { title: 'Too small' });
  const long = pinned('long', { x: 600, y: 900, width: 100, height: 20 }, { title: 'Too small '.repeat(4) });

  const placed = byId(placePins([short, long], NATURAL_WIDTH, DISPLAYED_WIDTH, SHOWN));

  expect(placed.short?.labelWidth).toBeGreaterThan(0);
  expect(placed.long?.labelWidth).toBeGreaterThan(placed.short?.labelWidth ?? Number.POSITIVE_INFINITY);
});

test('numbers the pins fix-first: the most severe group first, then each group by finding key', () => {
  const box = { x: 100, y: 600, width: 20, height: 20 };
  const findings = [
    pinned('a-low', box, { severity: 'low', signature: 'link' }),
    pinned('d-high', box, { severity: 'high', signature: 'card' }),
    pinned('b-medium', box, { severity: 'medium', signature: 'button' }),
    pinned('c-high', box, { severity: 'high', signature: 'card' }),
  ];
  const numbers = (input: readonly Finding[]) =>
    placePins(input, NATURAL_WIDTH, DISPLAYED_WIDTH, SHOWN).map(({ finding, number }) => [
      number,
      finding.id,
    ]);

  expect(numbers(findings)).toEqual([
    [1, 'c-high'],
    [2, 'd-high'],
    [3, 'b-medium'],
    [4, 'a-low'],
  ]);
  // The order the findings arrive in changes nothing.
  expect(numbers(findings.toReversed())).toEqual(numbers(findings));
});

test('an occurrence finding, or a step finding without a target, gets no pin and no number', () => {
  const step = pinned('step', { x: 100, y: 600, width: 20, height: 20 }, { severity: 'low' });
  const occurrence = occurrenceFinding({ id: 'occurrence', severity: 'high', screens: ['s1'] });
  const untargeted: StepFinding = { ...stepFinding({ id: 'untargeted', severity: 'high' }), target: null };

  const placements = placePins([occurrence, untargeted, step], NATURAL_WIDTH, DISPLAYED_WIDTH, SHOWN);

  expect(placements.map(({ finding, number }) => [number, finding.id])).toEqual([[1, 'step']]);
});

test('no pins before the screenshot has a size', () => {
  const finding = pinned('a', { x: 100, y: 100, width: 20, height: 20 });

  expect(placePins([finding], 0, DISPLAYED_WIDTH, SHOWN)).toEqual([]);
  expect(placePins([finding], NATURAL_WIDTH, 0, { width: 0, height: 0 })).toEqual([]);
});
