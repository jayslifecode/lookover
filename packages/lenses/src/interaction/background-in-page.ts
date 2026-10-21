import { COLOUR_READER_SOURCE, type ColourReader, type Painted } from './colour-in-page.js';
import { PLACE_IN_VIEW_SOURCE, type Placement } from './place-in-page.js';

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
  | 'colour-unparseable'
  | 'overlapped'
  | 'off-viewport';

export interface EffectiveBackground {
  /** `rgb(r, g, b)`, opaque; `null` exactly when `uncertain` is set. */
  color: string | null;
  uncertain: BackgroundUncertainty | null;
}

function effectiveBackground(
  this: Element,
  colours: ColourReader,
  placeInView: (this: Element) => Placement | null,
): EffectiveBackground {
  const OPAQUE_ALPHA = 0.999;
  /** The replaced elements: what they paint is not a colour the walk can read. */
  const REPLACED = 'img, video, canvas, picture, svg, iframe, object, embed';
  /** What Chromium paints the canvas with when nothing asks for a dark one. */
  const WHITE_CANVAS: Painted = { r: 255, g: 255, b: 255, a: 1 };
  const DARK = /\bdark\b/;
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

  /**
   * Whether the canvas under `<html>` is white: neither the root's computed `color-scheme`, nor a
   * `<meta name="color-scheme">`, nor the preferred colour scheme asks for a dark one.
   */
  const isCanvasWhite = (): boolean => {
    const meta = document.querySelector('meta[name="color-scheme"]')?.getAttribute('content') ?? '';
    return (
      !DARK.test(getComputedStyle(document.documentElement).colorScheme) &&
      !DARK.test(meta) &&
      !matchMedia('(prefers-color-scheme: dark)').matches
    );
  };
  /** The element's ancestors, across the shadow roots it is in. */
  const ancestorsOf = (element: Element): Set<Element> => {
    const found = new Set<Element>();
    let node: Node | null = element;
    while (node !== null) {
      const root: Node = node.getRootNode();
      node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
      if (node instanceof Element) found.add(node);
    }
    return found;
  };
  const intersects = (a: DOMRect, b: DOMRect): boolean =>
    a.width > 0 &&
    a.height > 0 &&
    a.left < b.right &&
    a.right > b.left &&
    a.top < b.bottom &&
    a.bottom > b.top;
  /**
   * Whether something that is not one of the element's ancestors is painted between it and `top`, the
   * layer that made the background opaque: an element hit-testing finds beneath it at its centre, or a
   * replaced element inside `top` whose box meets the element's (hit-testing passes over one with
   * `pointer-events: none`).
   */
  const isOverlapped = (stack: readonly Element[], top: Element): boolean => {
    const ancestors = ancestorsOf(this);
    const at = stack.indexOf(this);
    // The element's own opaque background covers whatever hit-testing finds beneath it.
    const isOwnBackground = top === this && at !== -1;
    const beneath = at === -1 ? stack.filter((element) => !this.contains(element)) : stack.slice(at + 1);
    const topAt = beneath.indexOf(top);
    const between = isOwnBackground ? [] : beneath.slice(0, topAt === -1 ? beneath.length : topAt);
    if (between.some((element) => !ancestors.has(element))) return true;
    const box = this.getBoundingClientRect();
    return Array.from(top.querySelectorAll(REPLACED)).some(
      (element) => !this.contains(element) && intersects(element.getBoundingClientRect(), box),
    );
  };

  const placement = placeInView.call(this);
  if (placement === null) return { color: null, uncertain: 'off-viewport' };
  const { rect, viewportWidth, viewportHeight } = placement;
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  if (x < 0 || y < 0 || x >= viewportWidth || y >= viewportHeight) {
    return { color: null, uncertain: 'off-viewport' };
  }
  const stack = document.elementsFromPoint(x, y);

  let color: Layer = { r: 0, g: 0, b: 0, a: 0 };
  let top: Element = this;
  for (let node: Element | null = this; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    const isCovered = color.a >= OPAQUE_ALPHA;
    const reason = reasonAt(style, isCovered);
    if (reason !== null) return { color: null, uncertain: reason };
    if (isCovered) continue;
    const painted = colours.paint(style.backgroundColor);
    if (painted === null) return { color: null, uncertain: 'colour-unparseable' };
    color = under(color, painted);
    top = node;
  }
  if (color.a < OPAQUE_ALPHA && top === document.documentElement && isCanvasWhite()) {
    color = under(color, WHITE_CANVAS);
  }
  if (color.a < OPAQUE_ALPHA) return { color: null, uncertain: 'never-opaque' };
  if (isOverlapped(stack, top)) return { color: null, uncertain: 'overlapped' };
  const channel = (value: number): number => Math.round(value);
  return { color: `rgb(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)})`, uncertain: null };
}

/**
 * The colour behind the element's text (`EffectiveBackground`): from the element up through its
 * ancestors to `<html>`, each `background-color` is composited under the ones above it (source-over)
 * until the stack is opaque (alpha ≥ 0.999). Colours are read as Chromium paints them (see
 * `colourReader`), so `lab()`, `oklch()` and every other computed syntax come back as `rgb()`.
 *
 * The walk sees ancestors only, so the element is first scrolled into view (`placeInView`) and the
 * elements at its centre listed (`document.elementsFromPoint`): when one painted beneath it is not one
 * of its ancestors (a positioned sibling, a hero image, a portal), before the layer that made the stack
 * opaque, the colour is not trusted (`overlapped`); nor when a replaced element (`img`, `video`,
 * `canvas`, `picture`, `svg`, `iframe`, `object`, `embed`) inside that layer, and not inside the
 * element itself, has a box that meets the element's, since hit-testing passes over a decoration with
 * `pointer-events: none`. An element whose centre is still outside the viewport once scrolled cannot be
 * looked at this way (`off-viewport`).
 *
 * The colour is not trusted either, and `uncertain` names the first reason met on the way up, when a
 * layer has a `background-image` (an image or a gradient) or a `backdrop-filter` before the stack is
 * opaque, when the element or any ancestor has `opacity` below 1, a `mix-blend-mode` or a `filter` (they
 * change the colours of everything inside). When no layer up to `<html>` makes it opaque, the browser's
 * canvas shows through: it is taken as white when nothing asks for a dark one (the root's computed
 * `color-scheme`, a `color-scheme` meta tag and the preferred colour scheme do not say `dark`), since
 * Chromium paints it white then; otherwise its colour is not known (`never-opaque`), and neither is it
 * for an element whose walk ends at a shadow root rather than at `<html>`.
 * A background colour the canvas cannot read is `colour-unparseable`. The reasons of the walk come
 * before `overlapped`.
 */
export const EFFECTIVE_BACKGROUND_SOURCE = `function () { return (${effectiveBackground.toString()}).call(this, (${COLOUR_READER_SOURCE})(), ${PLACE_IN_VIEW_SOURCE}); }`;
