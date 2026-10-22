// @vitest-environment node
import type { Finding, Severity, StepFinding } from '@jayslifecode/lookover-core';
import { expect, test } from 'vitest';
import {
  DOT_SIZE,
  LABEL_GAP,
  LABEL_HEIGHT,
  LABEL_INSET,
  PIN_CLUSTER_PX,
  type PinPlacement,
  POPOVER_GAP,
  POPOVER_INSET,
  pinFace,
  pinName,
  placePins,
  popoverBox,
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
  // 100 natural px apart (50 displayed): far enough not to cluster.
  const box = (row: number) => ({ x: 100, y: 600 + 100 * row, width: 20, height: 20 });
  const findings = [
    pinned('a-low', box(0), { severity: 'low', signature: 'link' }),
    pinned('d-high', box(1), { severity: 'high', signature: 'card' }),
    pinned('b-medium', box(2), { severity: 'medium', signature: 'button' }),
    pinned('c-high', box(3), { severity: 'high', signature: 'card' }),
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

/** The findings drawn at each pin, as `number:id`. */
function drawn(placements: readonly PinPlacement[]): string[][] {
  return placements.map((placement) =>
    placement.members.map(({ finding, number }) => `${number}:${finding.id}`),
  );
}

test('dots closer than PIN_CLUSTER_PX at the displayed scale are drawn as one cluster pin', () => {
  // At full size: `near` is 10 px right of `a`; `far` is 30 px below `a`.
  const a = pinned('a', { x: 500, y: 500, width: 20, height: 20 });
  const near = pinned('near', { x: 510, y: 500, width: 20, height: 20 });
  const far = pinned('far', { x: 500, y: 530, width: 20, height: 20 });
  const full: ScreenshotBox = { width: 1440, height: 2400 };

  expect(drawn(placePins([a, near], NATURAL_WIDTH, NATURAL_WIDTH, full))).toEqual([['1:a', '2:near']]);
  expect(drawn(placePins([a, far], NATURAL_WIDTH, NATURAL_WIDTH, full))).toEqual([['1:a'], ['2:far']]);
  // Shown at half size, `far` is 15 px away and joins the cluster too.
  expect(drawn(placePins([a, far], NATURAL_WIDTH, DISPLAYED_WIDTH, SHOWN))).toEqual([['1:a', '2:far']]);
  expect(PIN_CLUSTER_PX).toBe(24);
});

test("a dot joins the first cluster whose anchor is near it, and the cluster sits on its anchor's dot", () => {
  // Three dots 20 px apart in a row: the second is near the first; the third is 40 px from the first.
  const row = ['a', 'b', 'c'].map((id, index) =>
    pinned(id, { x: 500 + 20 * index, y: 500, width: 20, height: 20 }),
  );
  const full: ScreenshotBox = { width: 1440, height: 2400 };

  const placements = placePins(row, NATURAL_WIDTH, NATURAL_WIDTH, full);

  expect(drawn(placements)).toEqual([['1:a', '2:b'], ['3:c']]);
  expect(placements[0]).toMatchObject({ left: 520 - HALF_DOT, top: 500 - HALF_DOT });
});

test("a cluster takes its members' highest severity, and keeps them in fix-first order with their numbers", () => {
  // One group (one signature), led by its high finding but ordered by key: the low one comes first.
  const box = { x: 500, y: 500, width: 20, height: 20 };
  const findings = [
    pinned('b-high', box, { severity: 'high', signature: 'card' }),
    pinned('a-low', box, { severity: 'low', signature: 'card' }),
    pinned('c-medium', { ...box, x: 2000 }, { severity: 'medium', signature: 'other' }),
  ];

  const [cluster, single] = placePins(findings, NATURAL_WIDTH, DISPLAYED_WIDTH, SHOWN);

  expect(drawn([cluster, single].filter((placement) => placement !== undefined))).toEqual([
    ['1:a-low', '2:b-high'],
    ['3:c-medium'],
  ]);
  expect(cluster?.severity).toBe('high');
  expect(cluster?.finding.id).toBe('a-low');
  expect(single?.severity).toBe('medium');
});

test('a cluster pin shows its count, is named for its first finding, and its tooltip lists three titles', () => {
  const box = { x: 500, y: 500, width: 20, height: 20 };
  const titles = ['First', 'Second', 'Third', 'Fourth'];
  const findings = titles.map((title, index) =>
    pinned(`f${index}`, { ...box, x: box.x + index }, { title, signature: 'same' }),
  );
  const lone = pinned('lone', { ...box, y: 1500 }, { title: 'Alone', signature: 'lone', severity: 'low' });

  const [cluster, single] = placePins([...findings, lone], NATURAL_WIDTH, DISPLAYED_WIDTH, SHOWN);
  if (cluster === undefined || single === undefined) throw new Error('Expected a cluster and a pin');

  expect(pinFace(cluster)).toBe('4');
  expect(pinName(cluster)).toBe('4 findings near First');
  expect(cluster.labelLines).toEqual(['First', 'Second', 'Third', '… and 1 more']);
  expect(pinFace(single)).toBe('5');
  expect(pinName(single)).toBe('5. Alone');
  expect(single.labelLines).toEqual(['Alone']);
});

test("a cluster's taller tooltip flips below when, above, it would cover another dot", () => {
  // The cluster's tooltip has 4 lines (16 px each, 12 px of frame): 76 px tall, where a pin's is 28.
  const box = { x: 500, y: 600, width: 20, height: 20 };
  const cluster = ['a', 'b', 'c', 'd'].map((id) => pinned(id, box, { signature: 'same' }));
  // 70 displayed px above the cluster: clear of a one-line label, not of a four-line one.
  const above = pinned('above', { ...box, y: 600 - 140 }, { severity: 'high', signature: 'other' });

  const placements = placePins([...cluster, above], NATURAL_WIDTH, DISPLAYED_WIDTH, SHOWN);

  expect(placements.find((placement) => placement.members.length === 4)?.label).toBe('below');
});

test('the popover opens below the pin, and above it when there is no room below', () => {
  const shown: ScreenshotBox = { width: 720, height: 400 };
  const optionCount = 3;

  const below = popoverBox({ left: 100, top: 50 }, optionCount, shown);
  expect(below).toMatchObject({ side: 'below', edge: 50 + DOT_SIZE + POPOVER_GAP });
  expect(below.left).toBe(POPOVER_INSET);
  expect(below.maxHeight).toBe(400 - POPOVER_INSET - (50 + DOT_SIZE + POPOVER_GAP));

  const above = popoverBox({ left: 600, top: 360 }, optionCount, shown);
  // Anchored by its bottom edge, 8 px above the dot.
  expect(above).toMatchObject({ side: 'above', edge: 400 - 360 + POPOVER_GAP });
  expect(above.left + above.width).toBe(720 - POPOVER_INSET);
  expect(above.maxHeight).toBe(360 - POPOVER_GAP - POPOVER_INSET);
});
