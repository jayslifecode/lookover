import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { EvidenceRef, Finding, LensContext, LensSkip, StepFinding } from '@jayslifecode/lookover-core';
import { type FixtureServer, serveFixture } from '@jayslifecode/lookover-test-support';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FocusStop } from '../src/interaction/states.js';
import { MAX_TAB_PRESSES, TRAP_REPEATS, tabWalk } from '../src/interaction/tab-walk.js';
import { createTestRun, lensContextFor, type TestRun } from './helpers/context.js';
import { DEFAULT_TEST_VIEWPORT, launchTestSession, type TestSession } from './helpers/session.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/tab', import.meta.url));
const BROWSER_TIMEOUT_MS = 60_000;
const FOCUS_HIDDEN = 'interaction.focus-hidden';
const FOCUS_TRAP = 'interaction.focus-trap';
/** The presses a walk is allowed: twice the focusable controls and five more, but never over the cap. */
const PRESSES_PER_CONTROL = 2;
const PRESS_HEADROOM = 5;
/** How long a focus handler holds the page, so a walk with a deadline is cut short part-way. */
const SLOW_FOCUS_MS = 150;
const DEADLINE_AFTER_MS = 450;
const TALL_PAGE_PX = 3000;
const SCROLLED_PX = 400;
const SKIP_LINK_BOX_X = 0;
/** More buttons than a walk may press Tab for. */
const OVER_THE_CAP = 5;

interface Walked {
  context: LensContext;
  focusOrder: FocusStop[];
  findings: Finding[];
  skipped: LensSkip[];
}

interface WalkOptions {
  /** The count of focusable controls the walk is told; by default the screen's own. */
  focusableCount?: number;
  /** Sets the page up after the screen was captured from it. */
  prepare?: (page: Page) => Promise<unknown>;
  /** Changes the context the lens is handed, just before the walk. */
  adjust?: (context: LensContext) => LensContext;
  deadline?: number;
}

function budgetFor(focusableCount: number): number {
  return Math.min(PRESSES_PER_CONTROL * focusableCount + PRESS_HEADROOM, MAX_TAB_PRESSES);
}

function focusableCountOf(context: LensContext): number {
  return context.screen.elements.filter((element) => element.focusable).length;
}

function asStep(finding: Finding | undefined): StepFinding {
  if (finding?.shape !== 'step') throw new Error('expected a step finding');
  return finding;
}

function forRule(findings: readonly Finding[], ruleId: string): StepFinding[] {
  return findings.filter((finding) => finding.rule.id === ruleId).map(asStep);
}

function selectorsOf(stops: readonly FocusStop[]): (string | null)[] {
  return stops.map((stop) => stop.selector);
}

function times(selector: string, count: number): string[] {
  return Array.from({ length: count }, () => selector);
}

describe('tabWalk', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let browser: TestSession;
  let run: TestRun;

  beforeAll(async () => {
    fixture = await serveFixture(FIXTURE_DIR);
    browser = await launchTestSession();
    run = await createTestRun(fixture.url);
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await browser.close();
    await fixture.close();
    await run.dispose();
  }, BROWSER_TIMEOUT_MS);

  /** Opens the page, captures its screen, lets `options.prepare` set it up and walks it. */
  async function walk(file: string, options: WalkOptions = {}): Promise<Walked> {
    const ipage = await browser.newPage();
    try {
      await ipage.page.goto(`${fixture.url}/${file}`);
      const base = await lensContextFor(ipage, run.ctx);
      await options.prepare?.(ipage.page);
      const adjusted = options.adjust?.(base) ?? base;
      const context = { ...adjusted, deadline: options.deadline ?? adjusted.deadline };
      return { context, ...(await tabWalk(context, options.focusableCount ?? focusableCountOf(context))) };
    } finally {
      await ipage.close();
    }
  }

  async function readJson(ref: EvidenceRef): Promise<unknown> {
    return JSON.parse(await readFile(run.ctx.evidence.resolve(ref), 'utf8'));
  }

  describe('the focus order on order.html', () => {
    test('lists the skip link and the five controls in DOM order, one stop for each Tab press', async () => {
      const { focusOrder, skipped } = await walk('order.html');

      expect(selectorsOf(focusOrder)).toEqual(['#skip', '#first', '#second', '#faint', '#fourth', '#away']);
      expect(focusOrder.map((stop) => stop.index)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(focusOrder.map((stop) => stop.tag)).toEqual(['a', 'button', 'button', 'a', 'button', 'a']);
      expect(skipped).toEqual([]);
    });

    test('reports focus on the opacity: 0 link and the link off the page, and not on the skip link', async () => {
      const { focusOrder, findings } = await walk('order.html');

      expect(focusOrder.map((stop) => [stop.selector, stop.hidden])).toEqual([
        ['#skip', null],
        ['#first', null],
        ['#second', null],
        ['#faint', 'opacity'],
        ['#fourth', null],
        ['#away', 'offscreen'],
      ]);
      expect(findings.map((finding) => finding.rule.id)).toEqual([FOCUS_HIDDEN, FOCUS_HIDDEN]);
      expect(forRule(findings, FOCUS_HIDDEN).map((finding) => finding.target?.selector)).toEqual([
        '#faint',
        '#away',
      ]);
    });

    test('reads the skip link after its slide-in transition has finished, so it is in view', async () => {
      const { focusOrder } = await walk('order.html');
      const [skip] = focusOrder;

      expect(skip?.box.x).toBe(SKIP_LINK_BOX_X);
      expect(skip?.box.width).toBeGreaterThan(0);
    });

    test('describes the finding on the faint link: element, observation, trace and measurements', async () => {
      const { context, findings } = await walk('order.html');
      const [faint] = forRule(findings, FOCUS_HIDDEN);
      const { url } = context.screen;
      const element = context.screen.elements.find((candidate) => candidate.selector === '#faint');

      expect(faint).toMatchObject({
        source: 'interaction',
        severity: 'medium',
        status: 'candidate',
        screenId: 'screen-1',
        key: '/order.html|#faint',
        observed: 'takes keyboard focus on Tab press 4 but cannot be seen: it is fully transparent',
        target: { selector: '#faint', role: 'link', name: 'Faint link', componentName: null },
      });
      expect(faint?.target?.box).toEqual(element?.box);
      expect(faint?.trace).toEqual({
        route: '/order.html',
        url,
        viewport: DEFAULT_TEST_VIEWPORT,
        steps: [
          { kind: 'navigate', url },
          { kind: 'set-viewport', viewport: DEFAULT_TEST_VIEWPORT },
          { kind: 'press', key: 'Tab', times: 4 },
          { kind: 'measure', what: 'bounding box and visibility of document.activeElement' },
        ],
      });
      const [measurements, ...rest] = faint?.evidence ?? [];
      expect(rest).toEqual([]);
      expect(measurements).toMatchObject({ kind: 'measurements' });
      expect(await readJson((measurements as { ref: EvidenceRef }).ref)).toMatchObject({
        selector: '#faint',
        press: 4,
        hidden: 'opacity',
      });
    });

    test('presses Tab as many times as it took to reach the link off the page', async () => {
      const { findings } = await walk('order.html');
      const away = forRule(findings, FOCUS_HIDDEN).find((finding) => finding.target?.selector === '#away');

      expect(away?.trace.steps).toContainEqual({ kind: 'press', key: 'Tab', times: 6 });
      expect(away?.observed).toBe(
        'takes keyboard focus on Tab press 6 but cannot be seen: it is outside the page',
      );
    });

    test('targets a stop the accessibility tree did not list by its tag and its own box', async () => {
      const { focusOrder, findings } = await walk('order.html', {
        focusableCount: 6,
        adjust: (context) => ({ ...context, screen: { ...context.screen, elements: [] } }),
      });
      const faint = focusOrder.find((stop) => stop.selector === '#faint');

      expect(forRule(findings, FOCUS_HIDDEN)[0]?.target).toEqual({
        selector: '#faint',
        role: 'a',
        name: '',
        componentName: null,
        box: faint?.box,
      });
    });

    test('starts at the top of the page whatever had focus, and wherever the page was scrolled', async () => {
      const { focusOrder } = await walk('order.html', {
        prepare: async (page) => {
          await page.evaluate(`(() => {
            const spacer = document.createElement('div');
            spacer.style.height = '${TALL_PAGE_PX}px';
            document.body.append(spacer);
          })()`);
          await page.focus('#fourth');
          await page.evaluate(`window.scrollTo(0, ${SCROLLED_PX})`);
        },
      });

      expect(selectorsOf(focusOrder)[0]).toBe('#skip');
      expect(focusOrder).toHaveLength(6);
    });
  });

  describe('a focus trap on trap.html', () => {
    test('reports the control that keeps focus, once, and stops walking there', async () => {
      const { focusOrder, findings, skipped } = await walk('trap.html');

      expect(selectorsOf(focusOrder)).toEqual(['#before', ...times('#stuck', TRAP_REPEATS)]);
      expect(focusOrder.length).toBeLessThan(MAX_TAB_PRESSES);
      expect(findings.map((finding) => finding.rule.id)).toEqual([FOCUS_TRAP]);
      expect(skipped).toEqual([]);
    });

    test('describes the finding: element, observation, trace and measurements', async () => {
      const { context, findings } = await walk('trap.html');
      const [trap] = forRule(findings, FOCUS_TRAP);
      const { url } = context.screen;

      expect(trap).toMatchObject({
        severity: 'high',
        key: '/trap.html|#stuck',
        observed: `keeps keyboard focus when Tab is pressed ${TRAP_REPEATS} times in a row, so a keyboard user cannot move past it`,
        target: { selector: '#stuck', role: 'textbox', name: 'Stuck', componentName: null },
      });
      expect(trap?.trace.steps).toEqual([
        { kind: 'navigate', url },
        { kind: 'set-viewport', viewport: DEFAULT_TEST_VIEWPORT },
        { kind: 'press', key: 'Tab', times: TRAP_REPEATS + 1 },
        { kind: 'measure', what: 'document.activeElement after each of the last Tab presses' },
      ]);
      const measurements = trap?.evidence[0];
      expect(await readJson((measurements as { ref: EvidenceRef }).ref)).toMatchObject({
        selector: '#stuck',
        press: TRAP_REPEATS + 1,
        repeats: TRAP_REPEATS,
      });
    });

    test('stops at the repeats but reports nothing when the screen has only one focusable control', async () => {
      const { focusOrder, findings, skipped } = await walk('trap.html', { focusableCount: 1 });

      expect(focusOrder).toHaveLength(TRAP_REPEATS + 1);
      expect(findings).toEqual([]);
      expect(skipped).toEqual([]);
    });

    test('catches a control that is the first stop itself and keeps focus', async () => {
      const { focusOrder, findings } = await walk('trap.html', {
        prepare: (page) => page.evaluate("document.querySelector('#before').remove()"),
        focusableCount: 2,
      });

      expect(selectorsOf(focusOrder)).toEqual(times('#stuck', TRAP_REPEATS));
      expect(forRule(findings, FOCUS_TRAP).map((finding) => finding.target?.selector)).toEqual(['#stuck']);
    });
  });

  describe('where a walk ends', () => {
    test('does not call Tab presses inside an iframe a trap: its frame keeps focus while they run', async () => {
      const { focusOrder, findings, skipped } = await walk('frame.html');
      const selectors = selectorsOf(focusOrder);

      expect(selectors[0]).toBe('#before');
      expect(selectors.at(-1)).toBe('#after');
      expect(selectors.filter((selector) => selector === '#payment').length).toBeGreaterThan(TRAP_REPEATS);
      expect(findings).toEqual([]);
      expect(skipped).toEqual([]);
    });

    test('stops when focus comes back to the first stop', async () => {
      const { focusOrder, skipped } = await walk('order.html', {
        prepare: async (page) => {
          // A page that sends Tab from its last control to its first, as a modal dialog does.
          await page.evaluate(`document.querySelector('#away').addEventListener('keydown', (event) => {
            if (event.key !== 'Tab') return;
            event.preventDefault();
            document.querySelector('#skip').focus();
          })`);
        },
      });

      expect(focusOrder).toHaveLength(6);
      expect(selectorsOf(focusOrder)[0]).toBe('#skip');
      expect(skipped).toEqual([]);
    });

    test('keeps to the presses it is allowed and says the rest of the page was not walked', async () => {
      const { focusOrder, skipped } = await walk('order.html', { focusableCount: 0 });

      expect(focusOrder).toHaveLength(budgetFor(0));
      expect(skipped).toEqual([{ reason: 'tab-presses-cap', count: 1 }]);
    });

    test(`never presses Tab more than ${MAX_TAB_PRESSES} times, whatever the screen holds`, async () => {
      const ipage = await browser.newPage();
      try {
        const buttons = Array.from(
          { length: MAX_TAB_PRESSES + OVER_THE_CAP },
          (_, index) => `<button type="button">Item ${index}</button>`,
        );
        await ipage.page.setContent(`<body>${buttons.join('')}</body>`);
        const context = await lensContextFor(ipage, run.ctx);

        const { focusOrder, skipped } = await tabWalk(context, MAX_TAB_PRESSES * PRESSES_PER_CONTROL);

        expect(focusOrder).toHaveLength(MAX_TAB_PRESSES);
        expect(skipped).toEqual([{ reason: 'tab-presses-cap', count: 1 }]);
      } finally {
        await ipage.close();
      }
    });
  });

  describe('a stop that cannot be addressed', () => {
    test('is kept in the focus order without a selector, not reported, and counted as skipped', async () => {
      const { focusOrder, findings, skipped } = await walk('order.html', {
        prepare: async (page) => {
          // A page whose own `querySelector` cannot find the faint link again, so no selector resolves to it.
          await page.evaluate(`(() => {
            const find = document.querySelector.bind(document);
            document.querySelector = (selector) => (selector.includes('faint') ? null : find(selector));
          })()`);
        },
      });
      const unaddressable = focusOrder.find((stop) => stop.selector === null);

      expect(unaddressable).toMatchObject({ index: 4, tag: 'a', hidden: 'opacity' });
      expect(selectorsOf(focusOrder)).toHaveLength(6);
      expect(forRule(findings, FOCUS_HIDDEN).map((finding) => finding.target?.selector)).toEqual(['#away']);
      expect(skipped).toEqual([{ reason: 'focus-stop-unaddressable', count: 1 }]);
    });
  });

  describe('the deadline', () => {
    test('a deadline that has passed stops the walk before the first press and counts them all', async () => {
      const { focusOrder, findings, skipped, context } = await walk('order.html', {
        deadline: performance.now() - 1,
      });

      expect(focusOrder).toEqual([]);
      expect(findings).toEqual([]);
      expect(skipped).toEqual([{ reason: 'time-budget', count: budgetFor(focusableCountOf(context)) }]);
    });

    test('a deadline reached part-way through keeps the stops so far and counts the presses not made', async () => {
      const { focusOrder, skipped, context } = await walk('order.html', {
        prepare: async (page) => {
          await page.evaluate(`document.addEventListener('focusin', () => {
            const until = performance.now() + ${SLOW_FOCUS_MS};
            while (performance.now() < until);
          })`);
        },
        adjust: (context) => ({ ...context, deadline: performance.now() + DEADLINE_AFTER_MS }),
      });

      const budget = budgetFor(focusableCountOf(context));
      expect(focusOrder.length).toBeGreaterThan(0);
      expect(focusOrder.length).toBeLessThan(6);
      expect(skipped).toEqual([{ reason: 'time-budget', count: budget - focusOrder.length }]);
    });
  });
});
