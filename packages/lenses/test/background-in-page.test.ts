import { fileURLToPath } from 'node:url';
import type { InstrumentedPage } from '@jayslifecode/lookover-core';
import { type FixtureServer, serveFixture } from '@jayslifecode/lookover-test-support';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  EFFECTIVE_BACKGROUND_SOURCE,
  type EffectiveBackground,
} from '../src/interaction/background-in-page.js';
import { parseCssColor, type Rgba } from '../src/interaction/contrast.js';
import { measureOn } from '../src/interaction/measure.js';
import { launchTestSession, type TestSession } from './helpers/session.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/measure', import.meta.url));
const BROWSER_TIMEOUT_MS = 30_000;
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

describe('EFFECTIVE_BACKGROUND_SOURCE', { timeout: BROWSER_TIMEOUT_MS }, () => {
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

  /** The background behind the element `selector` matches; fails the test when nothing does. */
  async function background(selector: string): Promise<EffectiveBackground> {
    const result = await measureOn<EffectiveBackground>(ipage.cdp, { selector }, EFFECTIVE_BACKGROUND_SOURCE);
    if (result === null) throw new Error(`no element matches ${selector}`);
    return result;
  }

  describe('on backgrounds.html', () => {
    beforeEach(() => open('backgrounds.html'));

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
});
