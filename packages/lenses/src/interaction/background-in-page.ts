import { COLOUR_READER_SOURCE, type ColourReader, type Painted } from './colour-in-page.js';

/*
 * The background behind an element, measured in the page. Like `in-page.ts`, the function here runs in
 * the page, so it stays self-contained: no imports and no references to module scope (types are fine,
 * they are erased); what it needs is passed in by `EFFECTIVE_BACKGROUND_SOURCE`.
 */

/** Why a background cannot be trusted; see `EFFECTIVE_BACKGROUND_SOURCE`. */
export type BackgroundUncertainty =
  | 'background-image'
  | 'opacity'
  | 'mix-blend-mode'
  | 'filter'
  | 'backdrop-filter'
  | 'never-opaque'
  | 'colour-unparseable';

export interface EffectiveBackground {
  /** `rgb(r, g, b)`, opaque; `null` exactly when `uncertain` is set. */
  color: string | null;
  uncertain: BackgroundUncertainty | null;
}

function effectiveBackground(this: Element, colours: ColourReader): EffectiveBackground {
  const OPAQUE_ALPHA = 0.999;
  type Layer = Painted;
  /** `bottom` under `top`, source-over. */
  const under = (top: Layer, bottom: Layer): Layer => {
    const a = top.a + bottom.a * (1 - top.a);
    const mix = (t: number, u: number): number =>
      a === 0 ? 0 : (t * top.a + u * bottom.a * (1 - top.a)) / a;
    return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
  };
  /**
   * Opacity, blending and filters change everything inside the box, so they count all the way up;
   * an image or a backdrop filter only matters until an opaque layer covers it.
   */
  const reasonAt = (style: CSSStyleDeclaration, isCovered: boolean): BackgroundUncertainty | null => {
    if (!isCovered && style.backgroundImage !== 'none') return 'background-image';
    if (Number.parseFloat(style.opacity) < 1) return 'opacity';
    if (style.mixBlendMode !== 'normal') return 'mix-blend-mode';
    if (style.filter !== 'none') return 'filter';
    if (!isCovered && style.getPropertyValue('backdrop-filter') !== 'none') return 'backdrop-filter';
    return null;
  };

  let color: Layer = { r: 0, g: 0, b: 0, a: 0 };
  for (let node: Element | null = this; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    const isCovered = color.a >= OPAQUE_ALPHA;
    const reason = reasonAt(style, isCovered);
    if (reason !== null) return { color: null, uncertain: reason };
    if (isCovered) continue;
    const painted = colours.paint(style.backgroundColor);
    if (painted === null) return { color: null, uncertain: 'colour-unparseable' };
    color = under(color, painted);
  }
  if (color.a < OPAQUE_ALPHA) return { color: null, uncertain: 'never-opaque' };
  const channel = (value: number): number => Math.round(value);
  return { color: `rgb(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)})`, uncertain: null };
}

/**
 * The colour behind the element's text (`EffectiveBackground`): from the element up through its
 * ancestors to `<html>`, each `background-color` is composited under the ones above it (source-over)
 * until the stack is opaque (alpha ≥ 0.999). Colours are read as Chromium paints them (see
 * `colourReader`), so `lab()`, `oklch()` and every other computed syntax come back as `rgb()`.
 *
 * The colour is not trusted, and `uncertain` names the first reason met on the way up, when a layer
 * has a `background-image` (an image or a gradient) or a `backdrop-filter` before the stack is opaque,
 * when the element or any ancestor has `opacity` below 1, a `mix-blend-mode` or a `filter` (they
 * change the colours of everything inside), or when no layer up to `<html>` makes it opaque
 * (`never-opaque`: the browser's canvas colour shows through, and that depends on the colour scheme).
 * A background colour the canvas cannot read is `colour-unparseable`.
 */
export const EFFECTIVE_BACKGROUND_SOURCE = `function () { return (${effectiveBackground.toString()}).call(this, (${COLOUR_READER_SOURCE})()); }`;
