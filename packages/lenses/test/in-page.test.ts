import { fileURLToPath } from 'node:url';
import {
  extractElements,
  forcePseudoState,
  type InstrumentedPage,
  pushNodes,
  stableSelector,
} from '@jayslifecode/lookover-core';
import { type FixtureServer, serveFixture } from '@jayslifecode/lookover-test-support';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { parseCssColor, type Rgba } from '../src/interaction/contrast.js';
import {
  ACTIVE_ELEMENT_SOURCE,
  type ActiveElement,
  COMPONENT_NAME_SOURCE,
  EFFECTIVE_BACKGROUND_SOURCE,
  type EffectiveBackground,
  IS_INLINE_IN_TEXT_SOURCE,
  MEASURE_OVERFLOW_SOURCE,
  type OverflowMeasure,
  POSITIVE_TABINDEX_SOURCE,
  type PositiveTabindex,
  STATE_STYLE_PROPERTIES,
  STYLE_SNAPSHOT_SOURCE,
  type StyleSnapshot,
  TEXT_SAMPLE_SOURCE,
  type TextSample,
} from '../src/interaction/in-page.js';
import { evaluateSource, measureOn } from '../src/interaction/measure.js';
import { launchTestSession, type TestSession } from './helpers/session.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/measure', import.meta.url));
const BROWSER_TIMEOUT_MS = 30_000;
const MOBILE = { width: 390, height: 844 };
/** The canvas stores a colour in 8 bits per channel, alpha included, so a composite can be 1 off. */
const CHANNEL_TOLERANCE = 1;

function expectNear(actual: string | null, expected: Omit<Rgba, 'a'>): void {
  const color = actual === null ? null : parseCssColor(actual);
  if (color === null) throw new Error(`expected a colour, got ${actual}`);
  expect(Math.abs(color.r - expected.r)).toBeLessThanOrEqual(CHANNEL_TOLERANCE);
  expect(Math.abs(color.g - expected.g)).toBeLessThanOrEqual(CHANNEL_TOLERANCE);
  expect(Math.abs(color.b - expected.b)).toBeLessThanOrEqual(CHANNEL_TOLERANCE);
  expect(color.a).toBe(1);
}

describe('in-page measurement sources', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let browser: TestSession;
  let ipage: InstrumentedPage;

  beforeAll(async () => {
    fixture = await serveFixture(FIXTURE_DIR);
    browser = await launchTestSession();
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await browser.close();
    await fixture.close();
  }, BROWSER_TIMEOUT_MS);

  beforeEach(async () => {
    ipage = await browser.newPage();
  });

  afterEach(async () => {
    await ipage.close();
  });

  async function open(file: string): Promise<void> {
    await ipage.page.goto(`${fixture.url}/${file}`);
  }

  /** Runs `source` on the element `selector` matches; fails the test when nothing does. */
  async function measure<T>(selector: string, source: string): Promise<T> {
    const result = await measureOn<T>(ipage.cdp, { selector }, source);
    if (result === null) throw new Error(`no element matches ${selector}`);
    return result;
  }

  describe('EFFECTIVE_BACKGROUND_SOURCE', () => {
    beforeEach(() => open('backgrounds.html'));

    const background = (selector: string) =>
      measure<EffectiveBackground>(selector, EFFECTIVE_BACKGROUND_SOURCE);

    test('reports the colour of the opaque card under the text', async () => {
      expect(await background('#on-card')).toEqual({ color: 'rgb(30, 41, 59)', uncertain: null });
    });

    test('converts a Tailwind v4 oklch() background to the rgb() Chromium paints, as parseCssColor does', async () => {
      const { color, uncertain } = await background('#on-oklch-card');
      const computed = await ipage.page.evaluate(
        () => getComputedStyle(document.querySelector('#oklch-card') ?? document.body).backgroundColor,
      );
      const parsed = parseCssColor(computed);
      if (parsed === null) throw new Error(`parseCssColor could not read ${computed}`);

      expect(computed).toBe('oklch(0.488 0.243 264.376)');
      expect(uncertain).toBeNull();
      expectNear(color, { r: 20, g: 71, b: 230 });
      expectNear(color, parsed);
    });

    test('composites a half-transparent layer over the white beneath it', async () => {
      const { color, uncertain } = await background('#on-veil');

      expect(uncertain).toBeNull();
      expectNear(color, { r: 128, g: 128, b: 128 });
    });

    test('ignores a gradient that an opaque card covers', async () => {
      expect(await background('#card-over-image')).toEqual({ color: 'rgb(255, 255, 255)', uncertain: null });
    });

    test.each([
      ['#on-image', 'background-image'],
      ['#faded', 'opacity'],
      ['#faded-card', 'opacity'],
      ['#image-in-faded', 'background-image'],
      ['#blended', 'mix-blend-mode'],
      ['#filtered', 'filter'],
      ['#frosted', 'backdrop-filter'],
      ['#bare', 'never-opaque'],
    ])('gives no colour for %s, naming the first reason on the way up: %s', async (selector, reason) => {
      expect(await background(selector)).toEqual({ color: null, uncertain: reason });
    });
  });

  describe('IS_INLINE_IN_TEXT_SOURCE', () => {
    beforeEach(() => open('inline.html'));

    test.each([
      ['#in-sentence', true],
      ['#inline-block', true],
      ['#alone', false],
      ['#block', false],
      ['#block-alone', false],
    ])('%s is inline in text: %s', async (selector, expected) => {
      expect(await measure<boolean>(selector, IS_INLINE_IN_TEXT_SOURCE)).toBe(expected);
    });
  });

  describe('TEXT_SAMPLE_SOURCE', () => {
    beforeEach(() => open('text.html'));

    test('reports the text with its computed size, weight and colour', async () => {
      expect(await measure<TextSample>('#heading', TEXT_SAMPLE_SOURCE)).toEqual({
        text: 'Account settings',
        fontSize: 24,
        fontWeight: 700,
        color: 'rgb(17, 24, 39)',
      });
    });

    test('collapses whitespace and keeps the first 80 characters', async () => {
      const sample = await measure<TextSample>('#long', TEXT_SAMPLE_SOURCE);

      expect(sample.text).toBe(
        'This paragraph runs on well past the eighty characters a sample keeps, across li',
      );
      expect(sample.text).toHaveLength(80);
    });

    test('passes a computed oklch() colour through for the Node side to parse', async () => {
      const sample = await measure<TextSample>('#oklch', TEXT_SAMPLE_SOURCE);

      expect(sample.color).toBe('oklch(0.488 0.243 264.376)');
    });

    test('is null for an element without text', async () => {
      expect(await measureOn(ipage.cdp, { selector: '#icon' }, TEXT_SAMPLE_SOURCE)).toBeNull();
    });
  });

  describe('STYLE_SNAPSHOT_SOURCE', () => {
    beforeEach(() => open('snapshot.html'));

    test('tracks the same properties on the element, ::before and ::after', async () => {
      const snapshot = await measure<StyleSnapshot>('#styled', STYLE_SNAPSHOT_SOURCE);

      for (const part of [snapshot.self, snapshot.before, snapshot.after]) {
        expect(Object.keys(part)).toEqual([...STATE_STYLE_PROPERTIES]);
      }
    });

    test('reads computed values', async () => {
      const { self, before, after } = await measure<StyleSnapshot>('#styled', STYLE_SNAPSHOT_SOURCE);

      expect(self).toMatchObject({
        'outline-style': 'dashed',
        'outline-width': '2px',
        'outline-color': 'rgb(255, 0, 0)',
        'outline-offset': '3px',
        'box-shadow': 'rgb(0, 0, 255) 0px 0px 0px 4px',
        'border-top-color': 'rgb(0, 128, 0)',
        'border-top-width': '1px',
        'background-color': 'rgb(250, 250, 250)',
        color: 'rgb(17, 24, 39)',
        'text-decoration-line': 'underline',
        'text-decoration-color': 'rgb(5, 6, 7)',
        cursor: 'pointer',
        opacity: '0.9',
      });
      expect(before['outline-color']).toBe('rgb(1, 2, 3)');
      expect(after.color).toBe('rgb(4, 5, 6)');
    });

    test('sees a forced :hover when measured by backend node id', async () => {
      const { elements } = await extractElements(ipage);
      const element = elements.find((candidate) => candidate.selector === '#styled');
      if (element?.backendNodeId === undefined) throw new Error('expected #styled with a backend node id');
      const [nodeId = 0] = await pushNodes(ipage.cdp, [element.backendNodeId]);

      // By backend node id, not by selector: finding it by selector requests the document, which
      // drops the states forced through the node ids handed out before.
      await forcePseudoState(ipage.cdp, nodeId, ['hover']);
      const hovered = await measureOn<StyleSnapshot>(ipage.cdp, element, STYLE_SNAPSHOT_SOURCE);
      await forcePseudoState(ipage.cdp, nodeId, []);
      const rest = await measureOn<StyleSnapshot>(ipage.cdp, element, STYLE_SNAPSHOT_SOURCE);

      expect(hovered?.self['background-color']).toBe('rgb(229, 231, 235)');
      expect(rest?.self['background-color']).toBe('rgb(250, 250, 250)');
    });
  });

  describe('COMPONENT_NAME_SOURCE', () => {
    beforeEach(() => open('component.html'));

    test.each([
      ['#save', 'SaveButton'],
      ['#card', 'ProfileCard'],
      ['#internals-only', null],
      ['#plain', null],
      ['#production', null],
    ])('names the component of %s: %s', async (selector, expected) => {
      expect(await measureOn(ipage.cdp, { selector }, COMPONENT_NAME_SOURCE)).toBe(expected);
    });

    test('is null on a page without React', async () => {
      await open('inline.html');

      expect(await measureOn(ipage.cdp, { selector: '#in-sentence' }, COMPONENT_NAME_SOURCE)).toBeNull();
    });
  });

  describe('POSITIVE_TABINDEX_SOURCE', () => {
    test('lists the elements with a positive tabindex, in document order', async () => {
      await open('focus.html');

      const found = await evaluateSource<PositiveTabindex[]>(ipage.page, POSITIVE_TABINDEX_SOURCE);

      expect(found.map(({ selector, tabindex }) => [stableSelector(selector), tabindex])).toEqual([
        ['#third', 3],
        ['body > button:nth-of-type(4)', 1],
        ['a[href="#c"]', 2],
      ]);
      expect(found[0]?.selector).toEqual({ selector: '#third', path: 'body > input:nth-of-type(1)' });
    });
  });

  describe('ACTIVE_ELEMENT_SOURCE', () => {
    beforeEach(() => open('focus.html'));

    async function focusOn(selector: string): Promise<ActiveElement> {
      await ipage.page.focus(selector);
      return evaluateSource<ActiveElement>(ipage.page, ACTIVE_ELEMENT_SOURCE);
    }

    test('describes a focused control that can be seen', async () => {
      const active = await focusOn('#shown');

      expect(active).toMatchObject({ tag: 'button', isBody: false, hidden: null });
      expect(active.selector).toEqual({ selector: '#shown', path: 'body > button:nth-of-type(1)' });
      expect(active.box).toMatchObject({ x: 0, y: 0 });
      expect(active.box.width).toBeGreaterThan(0);
    });

    test('reports the body, without a selector, when nothing has focus', async () => {
      const active = await evaluateSource<ActiveElement>(ipage.page, ACTIVE_ELEMENT_SOURCE);

      expect(active).toMatchObject({ selector: null, tag: 'body', isBody: true, hidden: null });
    });

    test.each([
      ['#transparent', 'opacity'],
      ['#in-transparent', 'opacity'],
      ['#offscreen', 'offscreen'],
      ['#zero', 'zero-size'],
    ])('says why focus on %s cannot be seen: %s', async (selector, reason) => {
      expect((await focusOn(selector)).hidden).toBe(reason);
    });

    test('says when the focused element is visibility: hidden', async () => {
      // Chromium moves focus off an element that turns `visibility: hidden` at its next update, so the
      // source runs in the same task as the change, as it would from a focus handler that hides.
      const active = await ipage.page.evaluate<ActiveElement>(`(() => {
        const control = document.querySelector('#hiding');
        control.focus();
        control.style.visibility = 'hidden';
        return (${ACTIVE_ELEMENT_SOURCE})();
      })()`);

      expect(active.hidden).toBe('visibility');
    });
  });

  describe('MEASURE_OVERFLOW_SOURCE', () => {
    beforeEach(() => ipage.page.setViewportSize(MOBILE));

    test('names the element past the right edge and the caption cut off without an ellipsis', async () => {
      await open('overflow.html');

      const overflow = await evaluateSource<OverflowMeasure>(ipage.page, MEASURE_OVERFLOW_SOURCE);

      expect(overflow).toMatchObject({ scrollWidth: 600, clientWidth: MOBILE.width });
      expect(overflow.offenders).toEqual([
        { selector: { selector: '#banner', path: 'body > div:nth-of-type(1)' }, right: 600, width: 600 },
      ]);
      expect(overflow.clipped.map(({ selector }) => selector.selector)).toEqual(['#caption']);
      expect(overflow.clipped[0]).toMatchObject({
        text: 'A caption far too long to fit in two hundred pixels on one line',
        clientWidth: 200,
      });
      expect(overflow.clipped[0]?.scrollWidth).toBeGreaterThan(201);
    });

    test('keeps the five widest offenders, widest first, and the first ten clipped captions', async () => {
      await open('overflow-many.html');

      const overflow = await evaluateSource<OverflowMeasure>(ipage.page, MEASURE_OVERFLOW_SOURCE);

      expect(overflow.offenders.map(({ selector }) => selector.selector)).toEqual([
        '#w1000',
        '#w900',
        '#w800',
        '#w700',
        '#w600',
      ]);
      expect(overflow.clipped).toHaveLength(10);
      expect(overflow.clipped[9]?.text).toBe('Caption ten, much too long for its box');
    });

    test('reports nothing on a page that fits', async () => {
      await open('inline.html');

      expect(await evaluateSource<OverflowMeasure>(ipage.page, MEASURE_OVERFLOW_SOURCE)).toEqual({
        scrollWidth: MOBILE.width,
        clientWidth: MOBILE.width,
        offenders: [],
        clipped: [],
      });
    });
  });
});
