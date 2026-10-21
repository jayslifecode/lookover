import { describe, expect, test } from 'vitest';
import {
  blendOver,
  contrastRatio,
  isLargeText,
  parseCssColor,
  type Rgba,
  relativeLuminance,
  requiredRatio,
  roundedContrastRatio,
} from '../src/interaction/contrast.js';

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
/** Rounding a channel to the nearest integer can move it by up to 1. */
const CHANNEL_TOLERANCE = 1;
/** OKLCH → sRGB goes through two matrices and a cube; ±2 per channel covers the published rounding. */
const OKLCH_CHANNEL_TOLERANCE = 2;

function parsed(value: string): Rgba {
  const color = parseCssColor(value);
  if (color === null) throw new Error(`expected ${value} to parse`);
  return color;
}

function expectChannelsNear(actual: Rgba, expected: Rgba, tolerance: number): void {
  expect(Math.abs(actual.r - expected.r)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.g - expected.g)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.b - expected.b)).toBeLessThanOrEqual(tolerance);
  expect(actual.a).toBeCloseTo(expected.a, 3);
}

describe('parseCssColor', () => {
  test('reads rgb() and rgba() as Chromium serialises them', () => {
    expect(parseCssColor('rgb(118, 118, 118)')).toEqual({ r: 118, g: 118, b: 118, a: 1 });
    expect(parseCssColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
  });

  test('reads the space-separated syntax with a slash alpha', () => {
    expect(parseCssColor('rgb(10 20 30 / 0.25)')).toEqual({ r: 10, g: 20, b: 30, a: 0.25 });
    expect(parseCssColor('rgb(10 20 30 / 25%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.25 });
  });

  test('reads transparent as fully transparent black', () => {
    expect(parseCssColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  test('reads color(srgb …) with channels from 0 to 1', () => {
    expectChannelsNear(
      parsed('color(srgb 0.5 0.5 0.5)'),
      { r: 128, g: 128, b: 128, a: 1 },
      CHANNEL_TOLERANCE,
    );
    expectChannelsNear(parsed('color(srgb 1 0 0 / 0.5)'), { r: 255, g: 0, b: 0, a: 0.5 }, CHANNEL_TOLERANCE);
  });

  test("reads oklch() as Chromium computes Tailwind v4's colour tokens", () => {
    // Tailwind v4's blue-700 (`oklch(48.8% 0.243 264.376)`, #1447e6). Chromium paints it as
    // rgb(20, 71, 230); #1d4ed8 (29, 78, 216) is Tailwind v3's blue-700, a different colour.
    const blue700 = parsed('oklch(0.488 0.243 264.376)');

    expectChannelsNear(blue700, { r: 20, g: 71, b: 230, a: 1 }, OKLCH_CHANNEL_TOLERANCE);
    expect(contrastRatio(blue700, WHITE)).toBeCloseTo(6.82, 1);
  });

  test('reads oklch() with an alpha, a percentage lightness and a missing hue', () => {
    expect(parsed('oklch(0.488 0.243 264.376 / 0.5)').a).toBe(0.5);
    expectChannelsNear(parsed('oklch(100% 0 none)'), WHITE, CHANNEL_TOLERANCE);
    expectChannelsNear(parsed('oklch(0 0 0)'), BLACK, CHANNEL_TOLERANCE);
  });

  test('clamps an oklch() colour outside the sRGB gamut into it', () => {
    const color = parsed('oklch(0.7 0.4 30)');

    for (const channel of [color.r, color.g, color.b]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(255);
    }
  });

  test('reads the #rrggbb and #rrggbbaa a canvas writes a colour back as', () => {
    expect(parseCssColor('#9ca3af')).toEqual({ r: 156, g: 163, b: 175, a: 1 });
    expect(parseCssColor('#FFFFFF')).toEqual(WHITE);
    expect(parseCssColor('#00000080')).toEqual({ r: 0, g: 0, b: 0, a: 128 / 255 });
  });

  test.each([
    'hsl(0 0% 0%)',
    'color(display-p3 1 0 0)',
    'lab(50 20 30)',
    '#fff',
    '#fffff',
    '#ggffff',
    'red',
    'rgb(1, 2)',
    'rgb(a, b, c)',
    'oklch(0.5 0.1)',
    '',
  ])('returns null for anything else: %s', (value) => {
    expect(parseCssColor(value)).toBeNull();
  });
});

describe('blendOver', () => {
  test('paints 50 % black over white as mid grey', () => {
    expectChannelsNear(
      blendOver({ ...BLACK, a: 0.5 }, WHITE),
      { r: 128, g: 128, b: 128, a: 1 },
      CHANNEL_TOLERANCE,
    );
  });

  test('gives an alpha of fg.a + bg.a·(1 − fg.a)', () => {
    const blended = blendOver({ r: 255, g: 0, b: 0, a: 0.5 }, { r: 0, g: 0, b: 255, a: 0.5 });

    expect(blended.a).toBeCloseTo(0.75, 10);
    expect(blended.r).toBeCloseTo(170, 0);
    expect(blended.b).toBeCloseTo(85, 0);
  });

  test('keeps an opaque foreground and lets a transparent one through', () => {
    expect(blendOver(BLACK, WHITE)).toEqual(BLACK);
    expect(blendOver({ ...BLACK, a: 0 }, WHITE)).toEqual(WHITE);
    expect(blendOver({ ...BLACK, a: 0 }, { ...WHITE, a: 0 })).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
});

describe('relativeLuminance and contrastRatio', () => {
  test('white is 1 and black is 0', () => {
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 10);
    expect(relativeLuminance(BLACK)).toBe(0);
  });

  test('white on black is 21:1, in either order', () => {
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 10);
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 10);
  });

  test('#767676 on white is 4.54:1, the darkest grey that passes AA', () => {
    expect(contrastRatio(parsed('rgb(118, 118, 118)'), WHITE)).toBeCloseTo(4.54, 2);
  });

  test('a colour against itself is 1:1', () => {
    expect(contrastRatio(WHITE, WHITE)).toBe(1);
  });
});

describe('roundedContrastRatio', () => {
  test('is the contrast ratio to two decimals', () => {
    expect(roundedContrastRatio(parsed('rgb(118, 118, 118)'), WHITE)).toBe(4.54);
    expect(roundedContrastRatio(WHITE, BLACK)).toBe(21);
  });

  test('rounds up to the line it is a hair under: #959595 on white is 2.9953:1, which reads and compares as 3', () => {
    const grey = parsed('rgb(149, 149, 149)');

    expect(contrastRatio(grey, WHITE)).toBeLessThan(3);
    expect(roundedContrastRatio(grey, WHITE)).toBe(3);
  });
});

describe('isLargeText and requiredRatio', () => {
  test('24 px and up is large at any weight', () => {
    expect(isLargeText(24, 400)).toBe(true);
    expect(isLargeText(23.9, 400)).toBe(false);
  });

  test('18.66 px (14 pt) and up is large when bold', () => {
    expect(isLargeText(18.66, 700)).toBe(true);
    expect(isLargeText(18.66, 600)).toBe(false);
    expect(isLargeText(18.6, 700)).toBe(false);
  });

  test('large text needs 3:1, other text 4.5:1', () => {
    expect(requiredRatio(true)).toBe(3);
    expect(requiredRatio(false)).toBe(4.5);
  });
});
