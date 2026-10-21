/** A colour in sRGB: channels from 0 to 255 (not rounded), alpha from 0 to 1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

type Vector3 = readonly [number, number, number];
type Matrix3 = readonly [Vector3, Vector3, Vector3];

/** The channels and the alpha of a colour function, as written. */
interface ColorArguments {
  channels: readonly string[];
  alpha: string | null;
}

const MAX_CHANNEL = 255;
const PERCENT = 100;
const DEGREES_TO_RADIANS = Math.PI / 180;
/** In `oklch()`, a chroma of 100% is 0.4 (CSS Color 4). */
const OKLCH_FULL_CHROMA = 0.4;
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/;
const COLOR_FUNCTION = /^(rgba?|oklch|color)\(([^()]*)\)$/;

/*
 * OKLab → linear sRGB, from Björn Ottosson, "A perceptual color space for image processing" (2020),
 * https://bottosson.github.io/posts/oklab/ — the conversion CSS Color 4 specifies for `oklch()`.
 * OKLab (L, a, b) times `OKLAB_TO_LMS_CBRT` gives the cube roots of the LMS cone responses; cubed and
 * times `LMS_TO_LINEAR_SRGB`, linear sRGB.
 */
const OKLAB_TO_LMS_CBRT: Matrix3 = [
  [1, 0.3963377774, 0.2158037573],
  [1, -0.1055613458, -0.0638541728],
  [1, -0.0894841775, -1.291485548],
];
const LMS_TO_LINEAR_SRGB: Matrix3 = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
];

/** The sRGB transfer function (IEC 61966-2-1): below these, the curve is a straight line. */
const SRGB_LINEAR_LIMIT = 0.0031308;
const SRGB_ENCODED_LIMIT = 0.04045;
const SRGB_LINEAR_SLOPE = 12.92;
const SRGB_GAMMA = 2.4;
const SRGB_OFFSET = 0.055;

/** WCAG 2.x relative luminance weights, and the flare term both sides of a contrast ratio get. */
const LUMINANCE_WEIGHTS: Vector3 = [0.2126, 0.7152, 0.0722];
const CONTRAST_FLARE = 0.05;

/** WCAG 2.x large text: 18 pt (24 px), or 14 pt (18.66 px) when bold. */
const LARGE_TEXT_PX = 24;
const LARGE_BOLD_TEXT_PX = 18.66;
const BOLD_WEIGHT = 700;
/** WCAG 2.x 1.4.3 (AA) minimum contrast for large text and for all other text. */
const LARGE_TEXT_RATIO = 3;
const TEXT_RATIO = 4.5;

/**
 * Reads a colour the way `getComputedStyle` serialises it in Chromium: `rgb()` and `rgba()` (comma or
 * space syntax), `transparent`, `color(srgb r g b / a)` and `oklch(L C H / a)`, which is what Tailwind
 * v4's colour tokens compute to. `oklch()` is converted through OKLab to sRGB and clamped into its
 * gamut. Anything else (`hsl()`, other colour spaces, hex, names) is `null`: computed styles never
 * hold those, so the caller should not trust a value it cannot read.
 */
export function parseCssColor(value: string): Rgba | null {
  const text = value.trim().toLowerCase();
  if (text === 'transparent') {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  const match = COLOR_FUNCTION.exec(text);
  const args = match === null ? null : splitArguments(match[2] ?? '');
  if (match === null || args === null) {
    return null;
  }
  switch (match[1]) {
    case 'oklch':
      return fromOklch(args);
    case 'color':
      return fromSrgbFunction(args);
    default:
      return fromRgb(args);
  }
}

/** `fg` painted over `bg` (source-over): alpha `fg.a + bg.a·(1 − fg.a)`, channels weighted to match. */
export function blendOver(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a === 0) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  const mix = (top: number, bottom: number): number => (top * fg.a + bottom * bg.a * (1 - fg.a)) / a;
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a };
}

/** WCAG 2.x relative luminance, 0 for black to 1 for white. Alpha is ignored: blend first. */
export function relativeLuminance(c: Rgba): number {
  const [wr, wg, wb] = LUMINANCE_WEIGHTS;
  return wr * linearise(c.r) + wg * linearise(c.g) + wb * linearise(c.b);
}

/** WCAG 2.x contrast ratio, from 1 (none) to 21 (black on white), in either order. Alpha is ignored. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + CONTRAST_FLARE) / (Math.min(la, lb) + CONTRAST_FLARE);
}

export function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  return fontSizePx >= LARGE_TEXT_PX || (fontSizePx >= LARGE_BOLD_TEXT_PX && fontWeight >= BOLD_WEIGHT);
}

/** The contrast WCAG 2.x 1.4.3 asks of text of that size. */
export function requiredRatio(isLarge: boolean): number {
  return isLarge ? LARGE_TEXT_RATIO : TEXT_RATIO;
}

/** `r g b / a` or `r, g, b, a` into its channels and the alpha after a slash; `null` for two slashes. */
function splitArguments(body: string): ColorArguments | null {
  const [channelText = '', alphaText, ...extra] = body.split('/');
  if (extra.length > 0) {
    return null;
  }
  return {
    channels: channelText.split(/[\s,]+/).filter((token) => token !== ''),
    alpha: alphaText === undefined ? null : alphaText.trim(),
  };
}

/** `rgb(r, g, b)`, `rgba(r, g, b, a)` or `rgb(r g b / a)`: the legacy syntax puts the alpha fourth. */
function fromRgb({ channels, alpha }: ColorArguments): Rgba | null {
  const [r = '', g = '', b = '', legacyAlpha, ...extra] = channels;
  if (extra.length > 0 || (legacyAlpha !== undefined && alpha !== null)) {
    return null;
  }
  const values = [r, g, b].map((token) => component(token, MAX_CHANNEL));
  return rgbaOf(values, alphaOf(legacyAlpha ?? alpha));
}

/** `color(srgb r g b / a)`, channels from 0 to 1. */
function fromSrgbFunction({ channels, alpha }: ColorArguments): Rgba | null {
  const [space, ...rest] = channels;
  if (space !== 'srgb') {
    return null;
  }
  const values = rest.map((token) => scaled(component(token, 1), MAX_CHANNEL));
  return rgbaOf(values, alphaOf(alpha));
}

/** `oklch(L C H / a)`: lightness from 0 to 1 (or a percentage), chroma, hue in degrees. */
function fromOklch({ channels, alpha }: ColorArguments): Rgba | null {
  const [l = '', c = '', h = '', ...extra] = channels;
  const lightness = component(l, 1);
  const chroma = component(c, OKLCH_FULL_CHROMA);
  const hue = component(h, null);
  if (extra.length > 0 || lightness === null || chroma === null || hue === null) {
    return null;
  }
  const lab: Vector3 = [
    lightness,
    chroma * Math.cos(hue * DEGREES_TO_RADIANS),
    chroma * Math.sin(hue * DEGREES_TO_RADIANS),
  ];
  const [lc, mc, sc] = multiply(OKLAB_TO_LMS_CBRT, lab);
  const linear = multiply(LMS_TO_LINEAR_SRGB, [lc ** 3, mc ** 3, sc ** 3]);
  return rgbaOf(
    linear.map((channel) => encodeSrgb(channel) * MAX_CHANNEL),
    alphaOf(alpha),
  );
}

/** A CSS number, `none` (a missing component, which counts as 0), or a percentage of `percentOf`. */
function component(token: string, percentOf: number | null): number | null {
  if (token === 'none') {
    return 0;
  }
  if (percentOf !== null && token.endsWith('%')) {
    return scaled(component(token.slice(0, -1), null), percentOf / PERCENT);
  }
  return NUMBER.test(token) ? Number(token) : null;
}

/** The alpha as written (a number or a percentage), clamped to 0–1; 1 when there is none. */
function alphaOf(token: string | null | undefined): number | null {
  if (token === null || token === undefined) {
    return 1;
  }
  const alpha = component(token, 1);
  return alpha === null ? null : clamp(alpha, 1);
}

function rgbaOf(channels: readonly (number | null)[], alpha: number | null): Rgba | null {
  const [r, g, b] = channels;
  if (channels.length !== 3 || r == null || g == null || b == null || alpha === null) {
    return null;
  }
  return { r: clamp(r, MAX_CHANNEL), g: clamp(g, MAX_CHANNEL), b: clamp(b, MAX_CHANNEL), a: alpha };
}

function scaled(value: number | null, factor: number): number | null {
  return value === null ? null : value * factor;
}

function clamp(value: number, max: number): number {
  return Math.min(max, Math.max(0, value));
}

function multiply(matrix: Matrix3, vector: Vector3): Vector3 {
  const [x, y, z] = vector;
  const row = ([m0, m1, m2]: Vector3): number => m0 * x + m1 * y + m2 * z;
  return [row(matrix[0]), row(matrix[1]), row(matrix[2])];
}

/** Linear light (0–1, clamped into the sRGB gamut) to an encoded sRGB value (0–1). */
function encodeSrgb(linear: number): number {
  const value = clamp(linear, 1);
  return value <= SRGB_LINEAR_LIMIT
    ? value * SRGB_LINEAR_SLOPE
    : (1 + SRGB_OFFSET) * value ** (1 / SRGB_GAMMA) - SRGB_OFFSET;
}

/** An encoded sRGB channel (0–255) to linear light (0–1). */
function linearise(channel: number): number {
  const value = channel / MAX_CHANNEL;
  return value <= SRGB_ENCODED_LIMIT
    ? value / SRGB_LINEAR_SLOPE
    : ((value + SRGB_OFFSET) / (1 + SRGB_OFFSET)) ** SRGB_GAMMA;
}
