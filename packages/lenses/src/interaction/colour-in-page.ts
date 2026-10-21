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
  /** The colour as Chromium paints it into one pixel of an sRGB canvas, read back. */
  paint(color: string): Painted;
  /** The colour in sRGB, as `rgb(r, g, b)` or `rgba(r, g, b, a)`. */
  asRgb(color: string): string;
}

/**
 * Reads colours through a 1×1 sRGB canvas. Computed styles keep the colour space a colour was written
 * in (Tailwind 4.3's palette computes to `lab()`, v4.0's to `oklch()`, `color-mix()` to `oklab()`),
 * and so does the canvas's own `fillStyle`; only a painted pixel is sRGB whatever came in. `asRgb`
 * keeps an sRGB colour with alpha as Chromium writes it back (`rgba(…)`, exact) and paints anything
 * else, so a colour in another space with alpha is as exact as the pixel's 8 bits.
 */
function colourReader(): ColourReader {
  const MAX_CHANNEL = 255;
  const ALPHA_DECIMALS = 3;
  const SRGB_WITH_ALPHA = 'rgba(';
  const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  if (context === null) {
    throw new Error('colourReader: no 2D canvas to read colours with');
  }
  const paint = (color: string): Painted => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / MAX_CHANNEL };
  };
  const asRgb = (color: string): string => {
    context.fillStyle = color;
    const written = String(context.fillStyle);
    if (written.startsWith(SRGB_WITH_ALPHA)) return written;
    const { r, g, b, a } = paint(color);
    return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(ALPHA_DECIMALS))})`;
  };
  return { paint, asRgb };
}

/** `colourReader`'s source text: an in-page source calls it to get a `ColourReader`. */
export const COLOUR_READER_SOURCE: string = colourReader.toString();
