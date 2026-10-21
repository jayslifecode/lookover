/*
 * How the in-page sources read a colour. Like `in-page.ts`, `colourReader` runs in the page, so it
 * stays self-contained: no imports and no references to module scope (types are fine, they are erased).
 */

/** A colour in sRGB as one pixel holds it: channels from 0 to 255, alpha from 0 to 1. */
export interface Painted {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** How the in-page sources read a computed colour, whatever syntax Chromium computed it in. */
export interface ColourReader {
  /** The colour as Chromium paints it into one pixel of an sRGB canvas, read back; `null` when the canvas rejects it. */
  paint(color: string): Painted | null;
  /** The colour in sRGB, as `rgb(r, g, b)` or `rgba(r, g, b, a)`; `null` when the canvas rejects it. */
  asRgb(color: string): string | null;
}

/**
 * Reads colours through a 1×1 sRGB canvas. Computed styles keep the colour space a colour was written
 * in (Tailwind 4.3's palette computes to `lab()`, v4.0's to `oklch()`, `color-mix()` to `oklab()`),
 * and so does the canvas's own `fillStyle`; only a painted pixel is sRGB whatever came in. `asRgb`
 * keeps an sRGB colour with alpha as Chromium writes it back (`rgba(…)`, exact) and paints anything
 * else, so a colour in another space with alpha is as exact as the pixel's 8 bits.
 *
 * A colour the canvas cannot parse leaves `fillStyle` as it was, so painting it would paint whatever was
 * read before. Each colour is therefore assigned over a sentinel first: when `fillStyle` still holds the
 * sentinel afterwards, the colour is assigned over a second one, and only a colour that leaves both
 * unchanged is rejected (`null`), since no colour equals both.
 */
function colourReader(): ColourReader {
  const MAX_CHANNEL = 255;
  const ALPHA_DECIMALS = 3;
  const SRGB_WITH_ALPHA = 'rgba(';
  const SENTINELS = ['rgb(1, 2, 3)', 'rgb(4, 5, 6)'];
  const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  if (context === null) {
    throw new Error('colourReader: no 2D canvas to read colours with');
  }
  /** Whether `fillStyle` takes `color` over `sentinel`, which it keeps when it rejects the colour. */
  const takesOver = (sentinel: string, color: string): boolean => {
    context.fillStyle = sentinel;
    const kept = String(context.fillStyle);
    context.fillStyle = color;
    return String(context.fillStyle) !== kept;
  };
  /** Leaves `color` in `fillStyle` and is `true`, or is `false` when the canvas rejects it. */
  const accepts = (color: string): boolean => SENTINELS.some((sentinel) => takesOver(sentinel, color));
  const paint = (color: string): Painted | null => {
    context.clearRect(0, 0, 1, 1);
    if (!accepts(color)) return null;
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / MAX_CHANNEL };
  };
  const asRgb = (color: string): string | null => {
    if (!accepts(color)) return null;
    const written = String(context.fillStyle);
    if (written.startsWith(SRGB_WITH_ALPHA)) return written;
    const painted = paint(color);
    if (painted === null) return null;
    const { r, g, b, a } = painted;
    return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(ALPHA_DECIMALS))})`;
  };
  return { paint, asRgb };
}

/** `colourReader`'s source text: an in-page source calls it to get a `ColourReader`. */
export const COLOUR_READER_SOURCE: string = colourReader.toString();
