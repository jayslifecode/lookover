import { fileURLToPath } from 'node:url';
import type { Finding, InstrumentedPage, LensContext, StepFinding } from '@jayslifecode/lookover-core';
import { type FixtureServer, serveFixture } from '@jayslifecode/lookover-test-support';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { STATE_STYLE_PROPERTIES, type StyleSnapshot, type StyleValues } from '../src/interaction/in-page.js';
import {
  captureStates,
  focusIndicatorColor,
  type GalleryEntry,
  isBlurredOnlyIndicator,
  type StatesResult,
} from '../src/interaction/states.js';
import { createTestRun, lensContextFor, type TestRun } from './helpers/context.js';
import { launchTestSession, type TestSession } from './helpers/session.js';

/*
 * How the forced states tell where focus shows when forcing a pseudo-class is not enough: a focus style
 * set by script, and a focus mark drawn with more than one shadow.
 */

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/states', import.meta.url));
const BROWSER_TIMEOUT_MS = 60_000;
const FOCUS_VISIBLE = 'interaction.focus-visible-missing';
const INDICATOR_CONTRAST = 'interaction.focus-indicator-contrast';
const BLUE = 'rgb(29, 78, 216)';
/** Tailwind's `shadow-lg`, as Chromium computes it: two blurred layers of 10 % black. */
const SHADOW_LG = ['rgba(0, 0, 0, 0.1) 0px 10px 15px -3px', 'rgba(0, 0, 0, 0.1) 0px 4px 6px -4px'];
const EMPTY_LAYER = 'rgba(0, 0, 0, 0) 0px 0px 0px 0px';

/** A snapshot with nothing set but the `box-shadow` of the element itself. */
function withShadow(layers: readonly string[]): StyleSnapshot {
  const none = {
    ...(Object.fromEntries(STATE_STYLE_PROPERTIES.map((name) => [name, ''])) as StyleValues),
    'outline-style': 'none',
    'box-shadow': 'none',
  };
  const self = { ...none, 'box-shadow': layers.length === 0 ? 'none' : layers.join(', ') };
  return { self, before: none, after: none };
}

describe('focusIndicatorColor with blurred shadows', () => {
  const rest = withShadow([]);

  test('takes the crisp ring over a drop shadow that reaches further (focus:ring-2 focus:shadow-lg)', () => {
    const focus = withShadow([EMPTY_LAYER, EMPTY_LAYER, `${BLUE} 0px 0px 0px 2px`, ...SHADOW_LG]);

    expect(focusIndicatorColor(rest, focus)).toBe(BLUE);
    expect(isBlurredOnlyIndicator(rest, focus)).toBe(false);
  });

  test('has no colour to judge when focus adds only blurred layers, and says so', () => {
    const focus = withShadow(SHADOW_LG);

    expect(focusIndicatorColor(rest, focus)).toBeNull();
    expect(isBlurredOnlyIndicator(rest, focus)).toBe(true);
  });

  test('is not blurred-only when focus adds no shadow at all', () => {
    expect(isBlurredOnlyIndicator(rest, rest)).toBe(false);
  });
});

describe('captureStates on focus marks', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let browser: TestSession;
  let run: TestRun;
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
    run = await createTestRun(fixture.url);
    ipage = await browser.newPage();
  });

  afterEach(async () => {
    await ipage.close();
    await run.dispose();
  });

  async function capture(file: string): Promise<{ context: LensContext; result: StatesResult }> {
    await ipage.page.goto(`${fixture.url}/${file}`);
    const context = await lensContextFor(ipage, run.ctx);
    return { context, result: await captureStates(context, context.screen.elements) };
  }

  function selectorsFor(findings: readonly Finding[], ruleId: string): (string | undefined)[] {
    return findings
      .filter((finding): finding is StepFinding => finding.rule.id === ruleId && finding.shape === 'step')
      .map((finding) => finding.target?.selector);
  }

  function entryFor(result: StatesResult, selector: string): GalleryEntry {
    const entry = result.gallery.entries.find((candidate) => candidate.selector === selector);
    if (entry === undefined) throw new Error(`no gallery entry for ${selector}`);
    return entry;
  }

  describe('a focus style set by a focus listener (js-focus.html)', () => {
    test('is found by focusing the control for real, so only #none is reported', async () => {
      const { result } = await capture('js-focus.html');

      expect(selectorsFor(result.findings, FOCUS_VISIBLE)).toEqual(['#none']);
    });

    test('records which way the mark was found: forced, real, or neither', async () => {
      const { result } = await capture('js-focus.html');

      const marks = ['#js-class', '#js-attribute', '#js-faint', '#css-ring', '#none'].map((selector) => {
        const { focusMarkOn, focusMarkVia } = entryFor(result, selector);
        return [selector, focusMarkOn, focusMarkVia];
      });
      expect(marks).toEqual([
        ['#js-class', 'self', 'real'],
        ['#js-attribute', 'self', 'real'],
        ['#js-faint', 'self', 'real'],
        ['#css-ring', 'self', 'forced'],
        ['#none', null, null],
      ]);
    });

    test('keeps the look real focus gave, so the contrast of that mark is judged', async () => {
      const { result } = await capture('js-focus.html');

      expect(entryFor(result, '#js-class').states.focus?.self['outline-style']).toBe('solid');
      expect(selectorsFor(result.findings, INDICATOR_CONTRAST)).toEqual(['#js-faint']);
      const [faint] = result.findings.filter((finding) => finding.rule.id === INDICATOR_CONTRAST);
      expect(faint?.observed).toBe(
        'has a focus outline rgb(229, 231, 235) with 1.24:1 contrast against rgb(255, 255, 255)',
      );
    });

    test('blurs the control again and leaves no focus style behind', async () => {
      await capture('js-focus.html');

      const left = await ipage.page.evaluate(() => ({
        active: document.activeElement?.tagName,
        classes: ['js-class', 'js-faint'].map((id) => document.getElementById(id)?.className),
        attribute: document.getElementById('js-attribute')?.hasAttribute('data-focus-visible'),
      }));
      expect(left).toEqual({ active: 'BODY', classes: ['js-class', 'js-faint'], attribute: false });
    });
  });

  describe('a focus ring with a drop shadow (shadow.html)', () => {
    test('judges the ring, not the shadow that reaches further, and skips a shadow-only mark', async () => {
      const { result } = await capture('shadow.html');

      expect(selectorsFor(result.findings, INDICATOR_CONTRAST)).toEqual(['#faint-ring-and-shadow']);
      const [faint] = result.findings.filter((finding) => finding.rule.id === INDICATOR_CONTRAST);
      expect(faint?.observed).toBe(
        'has a focus outline rgb(229, 231, 235) with 1.24:1 contrast against rgb(255, 255, 255)',
      );
      expect(result.skipped).toEqual([{ reason: 'focus-indicator-blurred-only', count: 1 }]);
      expect(selectorsFor(result.findings, FOCUS_VISIBLE)).toEqual([]);
    });
  });
});
