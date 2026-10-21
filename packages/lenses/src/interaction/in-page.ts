import { BUILD_SELECTOR_SOURCE, type SelectorCandidate } from '@jayslifecode/lookover-core';
import { COLOUR_READER_SOURCE, type ColourReader, type Painted } from './colour-in-page.js';

/*
 * Everything a lens measures inside the page. Each `*_SOURCE` is the source text of a function that
 * runs in the page, not in Node, so the functions here must stay self-contained: no imports and no
 * references to module scope (types are fine, they are erased). Their constants and helpers are
 * inside them; what they need from Node (the selector builder, the property list) is passed in by the
 * `*_SOURCE` wrapper.
 *
 * Element sources take the element as `this`: run them with `measureOn`. Element-less sources take
 * nothing: run them with `evaluateSource`. A selector comes back as the selector builder's pair
 * (`SelectorCandidate`); the Node side stores the one `stableSelector` picks.
 */

export type SelectorBuilder = (el: Element) => SelectorCandidate;

/**
 * The computed properties a hover, focus or active state shows itself through. `scale`, `translate`
 * and `rotate` are the individual transforms Tailwind v4's `hover:scale-*` and friends set instead of
 * `transform`; `background-image` carries a gradient hover.
 */
export const STATE_STYLE_PROPERTIES = [
  'outline-style',
  'outline-width',
  'outline-color',
  'outline-offset',
  'box-shadow',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-top-width',
  'background-color',
  'background-image',
  'color',
  'text-decoration-line',
  'text-decoration-color',
  'text-decoration-thickness',
  'transform',
  'scale',
  'translate',
  'rotate',
  'opacity',
  'filter',
  'cursor',
] as const;

export type StateStyleProperty = (typeof STATE_STYLE_PROPERTIES)[number];
/** Each tracked property's computed value, in the order of `STATE_STYLE_PROPERTIES`. */
export type StyleValues = Record<StateStyleProperty, string>;

export interface StyleSnapshot {
  self: StyleValues;
  /** The `::before` and `::after` pseudo-elements, which hold many focus rings; read even when absent. */
  before: StyleValues;
  after: StyleValues;
}

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

export interface TextSample {
  /** Whitespace collapsed, at most 80 characters. */
  text: string;
  /** Computed, in CSS pixels. */
  fontSize: number;
  fontWeight: number;
  /** The text colour in sRGB, `rgb(r, g, b)` or `rgba(r, g, b, a)`, for `parseCssColor`; `null` when it cannot be read. */
  color: string | null;
  /**
   * `'descendant'` when the colours above may not be the ones the text is painted in (see
   * `TEXT_SAMPLE_SOURCE`); `null` when they can be trusted.
   */
  uncertain: 'descendant' | null;
}

export interface PositiveTabindex {
  selector: SelectorCandidate;
  tabindex: number;
}

export interface OverflowOffender {
  selector: SelectorCandidate;
  /** The border box's right edge in document coordinates, CSS pixels. */
  right: number;
  width: number;
}

export interface ClippedText {
  selector: SelectorCandidate;
  /** The element's own text, whitespace collapsed, at most 80 characters. */
  text: string;
  scrollWidth: number;
  clientWidth: number;
}

export interface OverflowMeasure {
  /** The document's (`<html>`'s) scroll and client widths. */
  scrollWidth: number;
  clientWidth: number;
  offenders: OverflowOffender[];
  clipped: ClippedText[];
}

function styleSnapshot(this: Element, properties: readonly StateStyleProperty[]): StyleSnapshot {
  const read = (pseudo: string | null): StyleValues => {
    const style = getComputedStyle(this, pseudo);
    return Object.fromEntries(properties.map((name) => [name, style.getPropertyValue(name)])) as StyleValues;
  };
  return { self: read(null), before: read('::before'), after: read('::after') };
}

/**
 * The computed values of `STATE_STYLE_PROPERTIES` on the element and its `::before` and `::after`
 * (`StyleSnapshot`). Compare a snapshot taken at rest with one taken in a forced state.
 */
export const STYLE_SNAPSHOT_SOURCE = `function () { return (${styleSnapshot.toString()}).call(this, ${JSON.stringify(STATE_STYLE_PROPERTIES)}); }`;

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

function componentName(this: Element): string | null {
  const FIBER_KEY_PREFIX = '__reactFiber$';
  /** A field only development builds put on a fiber (React 16 to 19). */
  const DEV_FIBER_FIELD = '_debugOwner';
  const REACT_INTERNALS = new Set(['Fragment', 'Suspense']);
  /** A fiber chain is finite; the cap only guards against a cycle in something that merely looks like one. */
  const MAX_DEPTH = 10_000;
  type Fiber = { type?: unknown; return?: Fiber | null };

  const nameOf = (type: unknown): string | null => {
    if (typeof type !== 'function') return null;
    const { displayName, name } = type as { displayName?: unknown; name?: unknown };
    const candidate = typeof displayName === 'string' && displayName !== '' ? displayName : name;
    const isAppComponent =
      typeof candidate === 'string' && /^[^a-z_]/.test(candidate) && !REACT_INTERNALS.has(candidate);
    return isAppComponent ? candidate : null;
  };

  const key = Object.keys(this).find((name) => name.startsWith(FIBER_KEY_PREFIX));
  let fiber =
    key === undefined ? null : ((this as unknown as Record<string, Fiber | undefined>)[key] ?? null);
  if (fiber === null || !(DEV_FIBER_FIELD in fiber)) return null;
  for (let depth = 0; fiber !== null && depth < MAX_DEPTH; depth += 1) {
    const name = nameOf(fiber.type);
    if (name !== null) return name;
    fiber = fiber.return ?? null;
  }
  return null;
}

/**
 * The name of the React component that rendered the element, from a React development build: the
 * node's `__reactFiber$…` property is its fiber, and `.return` leads up through the fibers of the
 * components around it. The first one whose `type` is a function or class wins, by `displayName` or
 * else `name`, unless that is a React internal (`Fragment`, `Suspense`) or starts with a lowercase
 * letter or `_` (helpers, wrappers). Host elements (`type` is the tag name) and React's own wrappers
 * (`type` is a symbol) are passed over. `null` on pages without React and in production builds:
 * their fibers have no `_debugOwner`, and their names are minified (`Ue`) rather than the source's.
 */
export const COMPONENT_NAME_SOURCE: string = componentName.toString();

function textSample(this: Element, colours: ColourReader): TextSample | null {
  const MAX_TEXT_LENGTH = 80;
  const TRANSPARENT = 'rgba(0, 0, 0, 0)';
  const raw = this instanceof HTMLElement ? this.innerText : (this.textContent ?? '');
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LENGTH);
  if (text === '') return null;
  const style = getComputedStyle(this);
  /** Whether the element is painted differently from `this`, so the text inside it may be too. */
  const looksDifferent = (el: Element): boolean => {
    const own = getComputedStyle(el);
    return (
      own.color !== style.color ||
      own.backgroundColor !== TRANSPARENT ||
      own.backgroundImage !== 'none' ||
      Number.parseFloat(own.opacity) < 1
    );
  };
  const hasText = (el: Element): boolean => (el.textContent ?? '').trim() !== '';
  const isDescendantPainted = Array.from(this.querySelectorAll('*')).some(
    (el) => hasText(el) && looksDifferent(el),
  );
  return {
    text,
    fontSize: Number.parseFloat(style.fontSize),
    fontWeight: Number.parseFloat(style.fontWeight),
    color: colours.asRgb(style.color),
    uncertain: isDescendantPainted ? 'descendant' : null,
  };
}

/**
 * The element's text as shown (`innerText`, whitespace collapsed, the first 80 characters) with the
 * computed font size, weight and colour that text contrast is judged by (`TextSample`); `null` when
 * the element shows no text. The colour is read the way `EFFECTIVE_BACKGROUND_SOURCE` reads a
 * background (see `colourReader`), so it is `rgb()` or `rgba()` whatever space it was computed in, or
 * `null` when the canvas cannot read it.
 *
 * The colour and the font are the element's own, but the text may belong to its descendants.
 * `uncertain` is `'descendant'` when any descendant element that holds text (anywhere in its subtree)
 * has a computed `color` different from the element's, a `background-color` that is not transparent, a
 * `background-image`, or an `opacity` below 1: the text is then painted in colours this sample does not
 * describe, and the caller should not judge it by them.
 */
export const TEXT_SAMPLE_SOURCE = `function () { return (${textSample.toString()}).call(this, (${COLOUR_READER_SOURCE})()); }`;

function isInlineInText(this: Element): boolean {
  if (!getComputedStyle(this).display.startsWith('inline')) return false;
  const siblings = Array.from(this.parentNode?.childNodes ?? []);
  return siblings.some(
    (node) => node !== this && node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
  );
}

/**
 * Whether the element sits in a line of text: its computed `display` starts with `inline` and its
 * parent has a text node with something other than whitespace beside it. Such a target is exempt from
 * the target-size rule.
 */
export const IS_INLINE_IN_TEXT_SOURCE: string = isInlineInText.toString();

function isInActiveDescendantWidget(this: Element): boolean {
  return this.parentElement?.closest('[aria-activedescendant]') != null;
}

/**
 * Whether the element is inside an element with `aria-activedescendant`: a listbox, a combobox popup
 * or a toolbar that keeps focus on itself and points at its active child. Those children are never
 * focused themselves, so the keyboard-reachability rule leaves them alone. Only ancestors count: an
 * element that names an active descendant itself (`div[role=combobox][aria-activedescendant]`) is the
 * widget, and it has to be focusable.
 */
export const IN_ACTIVEDESCENDANT_WIDGET_SOURCE: string = isInActiveDescendantWidget.toString();

function positiveTabindex(buildSelector: SelectorBuilder): PositiveTabindex[] {
  return Array.from(document.querySelectorAll('[tabindex]')).flatMap((el) => {
    const tabindex = (el as Element & Partial<HTMLOrSVGElement>).tabIndex ?? 0;
    return tabindex > 0 ? [{ selector: buildSelector(el), tabindex }] : [];
  });
}

/**
 * Every element whose `tabindex` is above 0, in document order, as
 * `{ selector: { selector, path }, tabindex }[]` (`PositiveTabindex[]`). `selector` is the selector
 * builder's pair; the Node side stores the one `stableSelector` picks.
 */
export const POSITIVE_TABINDEX_SOURCE = `() => (${positiveTabindex.toString()})(${BUILD_SELECTOR_SOURCE})`;

function measureOverflow(buildSelector: SelectorBuilder): OverflowMeasure {
  const MAX_ELEMENTS = 5000;
  const MAX_OFFENDERS = 5;
  const MAX_CLIPPED = 10;
  const MAX_TEXT_LENGTH = 80;
  const TOLERANCE_PX = 1;
  const { scrollWidth, clientWidth } = document.documentElement;
  const ownText = (el: Element): string =>
    Array.from(el.childNodes, (node) => (node.nodeType === Node.TEXT_NODE ? (node.textContent ?? '') : ' '))
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TEXT_LENGTH);
  const VISUALLY_HIDDEN_MAX_PX = 1;
  const isClipping = (style: CSSStyleDeclaration): boolean =>
    (style.overflowX === 'hidden' || style.overflowX === 'clip') &&
    style.whiteSpace === 'nowrap' &&
    style.textOverflow !== 'ellipsis';
  /** Text for screen readers only (an `sr-only` utility): nobody sees it, so nobody sees it cut off. */
  const isVisuallyHidden = (style: CSSStyleDeclaration, rect: DOMRect): boolean =>
    (rect.width <= VISUALLY_HIDDEN_MAX_PX && rect.height <= VISUALLY_HIDDEN_MAX_PX) ||
    style.getPropertyValue('clip') !== 'auto' ||
    style.getPropertyValue('clip-path') !== 'none';

  /** Boxes whose overflow the page does not scroll for: their content scrolls or is clipped in them. */
  const containers = new Set<Element>();
  const wide: { el: Element; right: number; width: number }[] = [];
  const clipped: ClippedText[] = [];
  for (const el of Array.from(document.querySelectorAll('body *')).slice(0, MAX_ELEMENTS)) {
    const style = getComputedStyle(el);
    const isContained =
      (el.parentElement !== null && containers.has(el.parentElement)) || style.position === 'fixed';
    if (isContained || style.overflowX !== 'visible') containers.add(el);
    const rect = el.getBoundingClientRect();
    const right = rect.right + window.scrollX;
    if (!isContained && rect.width > 0 && right > clientWidth + TOLERANCE_PX) {
      wide.push({ el, right, width: rect.width });
    }
    const isCandidate = clipped.length < MAX_CLIPPED && isClipping(style) && !isVisuallyHidden(style, rect);
    const text = isCandidate ? ownText(el) : '';
    if (text !== '' && el.scrollWidth > el.clientWidth + TOLERANCE_PX) {
      clipped.push({
        selector: buildSelector(el),
        text,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      });
    }
  }
  const offenders = wide
    .toSorted((a, b) => b.right - a.right)
    .slice(0, MAX_OFFENDERS)
    .map(({ el, right, width }) => ({ selector: buildSelector(el), right, width }));
  return { scrollWidth, clientWidth, offenders, clipped };
}

/**
 * The document's horizontal overflow, from the first 5000 elements in `<body>`, as
 * `{ scrollWidth, clientWidth, offenders: { selector: { selector, path }, right, width }[],
 * clipped: { selector: { selector, path }, text, scrollWidth, clientWidth }[] }` (`OverflowMeasure`).
 * Each `selector` is the selector builder's pair; the Node side stores the one `stableSelector` picks.
 *
 * - `offenders`: the 5 elements whose border box reaches furthest past the document's client width
 *   (by more than 1 px), furthest first. An element is passed over when the page does not scroll for
 *   its overflow: it is inside a box that scrolls or clips horizontally itself (`overflow-x` other
 *   than `visible`: a table's scrolling wrapper, a carousel's track), or it is `position: fixed` or
 *   inside a fixed box (those do not extend the document).
 * - `clipped`: the first 10 elements that cut their own text off without saying so: `overflow-x`
 *   `hidden` or `clip`, `white-space: nowrap`, no `text-overflow: ellipsis`, text of their own, and
 *   content wider than the box (`scrollWidth > clientWidth + 1`). Text hidden for screen readers only
 *   is passed over: a border box of at most 1×1 px, or a `clip` other than `auto`, or a `clip-path`
 *   other than `none` (the `sr-only` utilities).
 */
export const MEASURE_OVERFLOW_SOURCE = `() => (${measureOverflow.toString()})(${BUILD_SELECTOR_SOURCE})`;
