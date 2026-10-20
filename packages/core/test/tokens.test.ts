import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BrowserSession, type InstrumentedPage } from '../src/browser/session.js';
import { collectTokens, MAX_SAMPLED_ELEMENTS, MAX_SAMPLES_PER_PROPERTY } from '../src/map/tokens.js';
import type { TokenProperty, TokenSample } from '../src/map/types.js';
import { type FixtureServer, serveFixture } from './fixtures/serve.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/tokens', import.meta.url));
const BROWSER_TIMEOUT_MS = 30_000;
const VIEWPORT = { name: 'desktop', width: 1280, height: 800 };

const BRAND_BLUE = 'rgb(47, 107, 224)';
const NEAR_BRAND_BLUE = 'rgb(45, 102, 214)';
const TOKEN_PROPERTIES: readonly TokenProperty[] = [
  'color',
  'background-color',
  'font-size',
  'font-family',
  'border-radius',
  'padding',
  'margin',
];

const SVG_ROOT_COLOR = 'rgb(21, 22, 23)';
/** Colours the fixture gives to elements that are not rendered for a person (see the fixture). */
const HIDDEN_COLORS = [
  'rgb(1, 2, 3)', // visibility: hidden
  'rgb(4, 5, 6)', // display: none
  'rgb(7, 8, 9)', // a box with no size
  'rgb(10, 11, 12)', // inside an <svg>
  'rgb(13, 14, 15)', // a <script> forced to display
];

function samplesOf(samples: readonly TokenSample[], property: TokenProperty): TokenSample[] {
  return samples.filter((sample) => sample.property === property);
}

function valuesOf(samples: readonly TokenSample[], property: TokenProperty): string[] {
  return samplesOf(samples, property).map((sample) => sample.value);
}

/** A page of `<div>`s, one per colour, in the order given. */
function divsColoured(colors: readonly string[]): string {
  return colors.map((color) => `<div style="color: ${color}">text</div>`).join('');
}

describe('collectTokens', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let session: BrowserSession;
  let ipage: InstrumentedPage;

  beforeAll(async () => {
    fixture = await serveFixture(FIXTURE_DIR);
    session = await BrowserSession.launch({ viewport: VIEWPORT, allowHosts: [], onEvent: () => {} });
    ipage = await session.newPage();
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await session.close();
    await fixture.close();
  }, BROWSER_TIMEOUT_MS);

  describe('on the tokens fixture', () => {
    let samples: TokenSample[];

    beforeAll(async () => {
      await ipage.page.goto(`${fixture.url}/index.html`);
      samples = await collectTokens(ipage.page);
    }, BROWSER_TIMEOUT_MS);

    test('counts the two blues separately, the more used one first', () => {
      const blues = samplesOf(samples, 'color').filter(({ value }) =>
        [BRAND_BLUE, NEAR_BRAND_BLUE].includes(value),
      );

      expect(blues).toEqual([
        { property: 'color', value: BRAND_BLUE, count: 20 },
        { property: 'color', value: NEAR_BRAND_BLUE, count: 2 },
      ]);
    });

    test('leaves out elements that are hidden, empty, inside an svg or not content', () => {
      const colors = valuesOf(samples, 'color');

      for (const hidden of HIDDEN_COLORS) {
        expect(colors).not.toContain(hidden);
      }
    });

    test('samples a visible child of a hidden parent', () => {
      expect(valuesOf(samples, 'color')).toContain('rgb(12, 34, 56)');
    });

    test('samples the svg element itself, though not what is inside it', () => {
      expect(valuesOf(samples, 'color')).toContain(SVG_ROOT_COLOR);
    });

    test('samples descendants of the body, not the body itself', () => {
      expect(valuesOf(samples, 'background-color')).not.toContain('rgb(250, 250, 250)');
    });

    test('omits transparent backgrounds and zero radii, padding and margins', () => {
      expect(valuesOf(samples, 'background-color')).not.toContain('rgba(0, 0, 0, 0)');
      expect(valuesOf(samples, 'background-color')).toEqual(
        expect.arrayContaining(['rgb(240, 244, 255)', 'rgb(255, 255, 255)']),
      );
      for (const property of ['border-radius', 'padding', 'margin'] as const) {
        expect(valuesOf(samples, property)).not.toContain('0px');
      }
    });

    test('counts radii: 6px five times, 8px once', () => {
      expect(samplesOf(samples, 'border-radius')).toEqual([
        { property: 'border-radius', value: '6px', count: 5 },
        { property: 'border-radius', value: '8px', count: 1 },
      ]);
    });

    test('reports padding and margin as the shorthand the browser computes', () => {
      expect(samplesOf(samples, 'padding')).toEqual([
        { property: 'padding', value: '8px 16px', count: 5 },
        { property: 'padding', value: '16px', count: 1 },
      ]);
      expect(samplesOf(samples, 'margin')).toEqual([{ property: 'margin', value: '0px 0px 12px', count: 5 }]);
    });

    test('finds the three font sizes the page uses', () => {
      expect(valuesOf(samples, 'font-size').sort()).toEqual(['14px', '16px', '24px']);
    });

    test('keeps the first font family only, without quotes', () => {
      const families = valuesOf(samples, 'font-family');

      expect(families).toEqual(expect.arrayContaining(['Helvetica Neue', 'Georgia', 'Courier New']));
      for (const family of families) {
        expect(family).not.toMatch(/["',]/);
      }
    });

    test('groups by property in declaration order, each most used first then by value', () => {
      const order = [...new Set(samples.map((sample) => sample.property))];

      expect(order).toEqual(TOKEN_PROPERTIES.filter((property) => order.includes(property)));
      for (const property of TOKEN_PROPERTIES) {
        const ofProperty = samplesOf(samples, property);
        const sorted = [...ofProperty].sort(
          (a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
        );
        expect(ofProperty).toEqual(sorted);
      }
    });
  });

  describe('on a generated page', () => {
    test('returns at most 60 samples per property, keeping the most used and then the smallest strings', async () => {
      const popular = [1, 2, 3, 4, 5].map((n) => `rgb(${n}, 200, 0)`);
      const once = Array.from({ length: 65 }, (_, n) => `rgb(${n + 1}, 0, 0)`);
      await ipage.page.setContent(divsColoured([...popular, ...popular, ...popular, ...once]));

      const colors = samplesOf(await collectTokens(ipage.page), 'color');

      expect(colors).toHaveLength(MAX_SAMPLES_PER_PROPERTY);
      expect(colors.slice(0, popular.length)).toEqual(
        [...popular].sort().map((value) => ({ property: 'color', value, count: 3 })),
      );
      // Plain string order, not numeric: `rgb(10, 0, 0)` comes before `rgb(2, 0, 0)`.
      expect(colors.slice(popular.length).map(({ value }) => value)).toEqual(
        [...once].sort().slice(0, MAX_SAMPLES_PER_PROPERTY - popular.length),
      );
    });

    test('stops after 5000 rendered elements', async () => {
      const early = 'rgb(20, 40, 60)';
      const late = 'rgb(60, 40, 20)';
      const beyond = 100;
      await ipage.page.setContent(
        divsColoured([
          ...Array.from({ length: MAX_SAMPLED_ELEMENTS }, () => early),
          ...Array.from({ length: beyond }, () => late),
        ]),
      );

      const colors = samplesOf(await collectTokens(ipage.page), 'color');

      expect(MAX_SAMPLED_ELEMENTS).toBe(5000);
      expect(colors).toEqual([{ property: 'color', value: early, count: MAX_SAMPLED_ELEMENTS }]);
    });

    test('does not spend the limit on elements that are not rendered', async () => {
      const hiddenCount = MAX_SAMPLED_ELEMENTS + 50;
      const hidden = Array.from({ length: hiddenCount }, () => '<p style="display: none">gone</p>').join('');
      await ipage.page.setContent(`${hidden}${divsColoured(['rgb(9, 9, 9)'])}`);

      const colors = samplesOf(await collectTokens(ipage.page), 'color');

      expect(colors).toEqual([{ property: 'color', value: 'rgb(9, 9, 9)', count: 1 }]);
    });
  });

  test('returns no samples for a page without content', async () => {
    await ipage.page.goto('about:blank');

    expect(await collectTokens(ipage.page)).toEqual([]);
  });
});
