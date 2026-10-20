import type { Page } from 'playwright';
import type { TokenProperty, TokenSample } from './types.js';

/** Past this many rendered elements the walk stops: tokens are a sample, not an inventory. */
export const MAX_SAMPLED_ELEMENTS = 5000;

/** The most distinct values kept per property, the most used first. */
export const MAX_SAMPLES_PER_PROPERTY = 60;

/** One value an element renders for one property. */
interface TokenValue {
  property: TokenProperty;
  value: string;
}

/** How to read one property off a computed style, and which values do not count as a token. */
interface TokenRule {
  read: (style: CSSStyleDeclaration) => string;
  ignore: readonly string[];
}

/*
 * Everything from here to `TOKENS_SOURCE` runs in the page, not in Node. The functions are plain
 * top-level declarations so TypeScript checks them, but they are stringified and joined into one
 * scope: they may call each other by name and nothing else from this module (no imports, no
 * constants; the two limits are passed in). Add any new helper to `IN_PAGE_FUNCTIONS`.
 */

/** The first family of a computed `font-family` list, without its quotes. */
function firstFontFamily(fontFamily: string): string {
  const quoted = /^\s*(["'])(.*?)\1/.exec(fontFamily);
  const family = quoted === null ? (fontFamily.split(',')[0] ?? '') : (quoted[2] ?? '');
  return family.trim();
}

/** Declaration order is the order of the result: the keys are exactly the `TokenProperty`s. */
function tokenRules(): Record<TokenProperty, TokenRule> {
  const transparent = ['rgba(0, 0, 0, 0)', 'transparent'];
  const zero = ['0px'];
  return {
    color: { read: (style) => style.color, ignore: transparent },
    'background-color': { read: (style) => style.backgroundColor, ignore: transparent },
    'font-size': { read: (style) => style.fontSize, ignore: [] },
    'font-family': { read: (style) => firstFontFamily(style.fontFamily), ignore: [] },
    'border-radius': { read: (style) => style.borderRadius, ignore: zero },
    padding: { read: (style) => style.padding, ignore: zero },
    margin: { read: (style) => style.margin, ignore: zero },
  };
}

/** Markup that holds no rendered content, and everything inside an `<svg>` (the `<svg>` itself is kept). */
function isSkipped(el: Element): boolean {
  if (['script', 'style', 'noscript', 'template'].includes(el.localName)) {
    return true;
  }
  const parent = el.parentElement;
  return parent !== null && parent.closest('svg') !== null;
}

/** Whether a person can see the element: it has a border box and is not `visibility: hidden`. */
function isRendered(el: Element, style: CSSStyleDeclaration): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
}

/** The values one element renders, in `rules` order; empty and ignored values are not tokens. */
function valuesOf(style: CSSStyleDeclaration, rules: Record<TokenProperty, TokenRule>): TokenValue[] {
  const properties = Object.keys(rules) as TokenProperty[];
  return properties
    .map((property) => ({ property, value: rules[property].read(style) }))
    .filter(({ property, value }) => value !== '' && !rules[property].ignore.includes(value));
}

/** The values of the first `limit` rendered elements under `<body>`, in document order. */
function renderedValues(limit: number, rules: Record<TokenProperty, TokenRule>): TokenValue[] {
  // A document without a <body> (a frameset, say) has nothing to sample.
  const elements = Array.from(document.body?.querySelectorAll('*') ?? []);
  const values: TokenValue[] = [];
  let rendered = 0;
  for (const el of elements) {
    if (rendered >= limit) {
      break;
    }
    if (isSkipped(el)) {
      continue;
    }
    const style = getComputedStyle(el);
    if (isRendered(el, style)) {
      rendered += 1;
      values.push(...valuesOf(style, rules));
    }
  }
  return values;
}

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** Distinct values of one property with their counts: most used first, ties by value, at most `limit`. */
function rankValues(property: TokenProperty, values: readonly TokenValue[], limit: number): TokenSample[] {
  const counts = new Map<string, number>();
  for (const entry of values) {
    if (entry.property === property) {
      counts.set(entry.value, (counts.get(entry.value) ?? 0) + 1);
    }
  }
  return Array.from(counts, ([value, count]) => ({ property, value, count }))
    .sort((a, b) => b.count - a.count || compareText(a.value, b.value))
    .slice(0, limit);
}

function sampleTokens(maxElements: number, maxPerProperty: number): TokenSample[] {
  const rules = tokenRules();
  const values = renderedValues(maxElements, rules);
  const properties = Object.keys(rules) as TokenProperty[];
  return properties.flatMap((property) => rankValues(property, values, maxPerProperty));
}

const IN_PAGE_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  firstFontFamily,
  tokenRules,
  isSkipped,
  isRendered,
  valuesOf,
  renderedValues,
  compareText,
  rankValues,
  sampleTokens,
];

const TOKENS_SOURCE = `(() => {
${IN_PAGE_FUNCTIONS.map((fn) => fn.toString()).join('\n')}
return sampleTokens(${MAX_SAMPLED_ELEMENTS}, ${MAX_SAMPLES_PER_PROPERTY});
})()`;

/**
 * The colours, type sizes, font families, radii, paddings and margins the main frame renders, as
 * computed styles: per property, each distinct value with the number of elements that use it, the
 * most used first (ties by value, plain string order), at most `MAX_SAMPLES_PER_PROPERTY` of them.
 * Properties come in `TokenProperty` order.
 *
 * Walks the descendants of `<body>` in document order, until `MAX_SAMPLED_ELEMENTS` rendered
 * elements: those with a border box and not `visibility: hidden`. `<script>`, `<style>`,
 * `<noscript>`, `<template>` and everything inside an `<svg>` are not walked. Fully transparent
 * colours and `0px` radii, paddings and margins are not tokens; a font family is its first entry,
 * unquoted; padding and margin are the shorthand string Chromium computes (`8px 16px`). `<body>`
 * itself, shadow trees and other frames are not reached.
 *
 * One in-page evaluation, with no per-element protocol calls.
 */
export async function collectTokens(page: Page): Promise<TokenSample[]> {
  return page.evaluate<TokenSample[]>(TOKENS_SOURCE);
}
