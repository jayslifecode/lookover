import { fileURLToPath } from 'node:url';
import type { Finding, InstrumentedPage, LensContext, StepFinding } from '@jayslifecode/lookover-core';
import { type FixtureServer, serveFixture } from '@jayslifecode/lookover-test-support';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { captureStates, type GalleryEntry, type StatesResult } from '../src/interaction/states.js';
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
});
