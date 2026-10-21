import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type {
  EvidenceRef,
  Finding,
  LensContext,
  LensSkip,
  OccurrenceFinding,
  StepFinding,
} from '@jayslifecode/lookover-core';
import { type FixtureServer, serveFixture } from '@jayslifecode/lookover-test-support';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MAX_CONTRAST_ELEMENTS, MUST_BE_FOCUSABLE_ROLES, measureStatic } from '../src/interaction/static.js';
import { MIN_TARGET_PX, passesTargetSize } from '../src/interaction/target-size.js';
import { createTestRun, type LensContextOptions, lensContextFor, type TestRun } from './helpers/context.js';
import { DEFAULT_TEST_VIEWPORT, launchTestSession, type TestSession } from './helpers/session.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/static', import.meta.url));
const BROWSER_TIMEOUT_MS = 60_000;
const CONTRAST_FAIL = 'interaction.text-contrast-fail';
const CONTRAST_LOW = 'interaction.text-contrast-low';
const TARGET_SIZE = 'interaction.target-size';
const KEYBOARD = 'interaction.keyboard-unreachable';
const POSITIVE_TABINDEX = 'interaction.positive-tabindex';
/** More controls than `MAX_CONTRAST_ELEMENTS`, each one judged for contrast. */
const OVER_THE_CAP = 5;

interface Measured {
  context: LensContext;
  findings: Finding[];
  skipped: LensSkip[];
}

describe('MUST_BE_FOCUSABLE_ROLES', () => {
  test('holds the roles that name a control a keyboard user has to be able to reach', () => {
    expect([...MUST_BE_FOCUSABLE_ROLES].sort()).toEqual(
      [
        'button',
        'checkbox',
        'combobox',
        'link',
        'searchbox',
        'slider',
        'spinbutton',
        'switch',
        'textbox',
      ].sort(),
    );
  });
});

describe('measureStatic', { timeout: BROWSER_TIMEOUT_MS }, () => {
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

  /** Opens the page, measures every element extracted from it, and closes the page again. */
  async function measure(file: string, options: LensContextOptions = {}): Promise<Measured> {
    const ipage = await browser.newPage();
    try {
      await ipage.page.goto(`${fixture.url}/${file}`);
      const context = await lensContextFor(ipage, run.ctx, options);
      return { context, ...(await measureStatic(context, context.screen.elements)) };
    } finally {
      await ipage.close();
    }
  }

  function asStep(finding: Finding | undefined): StepFinding {
    if (finding?.shape !== 'step') throw new Error('expected a step finding');
    return finding;
  }

  function asOccurrence(finding: Finding | undefined): OccurrenceFinding {
    if (finding?.shape !== 'occurrence') throw new Error('expected an occurrence finding');
    return finding;
  }

  function forRule(findings: readonly Finding[], ruleId: string): Finding[] {
    return findings.filter((finding) => finding.rule.id === ruleId);
  }

  function selectorsFor(findings: readonly Finding[], ruleId: string): (string | undefined)[] {
    return forRule(findings, ruleId).map((finding) => asStep(finding).target?.selector);
  }

  function findingFor(findings: readonly Finding[], ruleId: string, selector: string): StepFinding {
    const found = forRule(findings, ruleId).find((finding) => asStep(finding).target?.selector === selector);
    return asStep(found);
  }

  async function readJson(ref: EvidenceRef): Promise<unknown> {
    return JSON.parse(await readFile(run.ctx.evidence.resolve(ref), 'utf8'));
  }

  describe('text contrast on contrast-overlap.html', () => {
    test('skips white text over a dark image beside it rather than judge it against the white body', async () => {
      const { findings, skipped } = await measure('contrast-overlap.html');

      expect(selectorsFor(findings, CONTRAST_FAIL)).toEqual(['#fail']);
      expect(skipped).toEqual([{ reason: 'background-uncertain:overlapped', count: 1 }]);
    });
  });

  describe('text contrast on contrast.html', () => {
    test('reports #fail as unreadable and #low as low, and #large-ok, #on-image and #ok not at all', async () => {
      const { findings } = await measure('contrast.html');

      expect(selectorsFor(findings, CONTRAST_FAIL)).toEqual(['#fail']);
      expect(selectorsFor(findings, CONTRAST_LOW)).toEqual(['#low']);
    });

    test('skips #on-image, whose background is a gradient, and #disabled-faint, and says why', async () => {
      const { skipped } = await measure('contrast.html');

      expect(skipped).toEqual([
        { reason: 'background-uncertain:background-image', count: 1 },
        { reason: 'disabled', count: 1 },
      ]);
    });

    test('does not judge the faded text of a disabled control: inactive components are exempt', async () => {
      const { context, findings } = await measure('contrast.html');
      const faint = context.screen.elements.find((element) => element.selector === '#disabled-faint');

      expect(faint).toMatchObject({ disabled: true });
      expect(selectorsFor(findings, CONTRAST_FAIL)).not.toContain('#disabled-faint');
      expect(selectorsFor(findings, CONTRAST_LOW)).not.toContain('#disabled-faint');
    });

    test('an unreadable finding carries the colours, the ratio and its trace', async () => {
      const { context, findings } = await measure('contrast.html');
      const finding = findingFor(findings, CONTRAST_FAIL, '#fail');
      const { url } = context.screen;

      expect(finding).toMatchObject({
        source: 'interaction',
        severity: 'high',
        status: 'candidate',
        screenId: 'screen-1',
        key: '/contrast.html|#fail',
        observed: '"Grey on grey" is rgb(156, 163, 175) on rgb(229, 231, 235), 2.05:1 (needs 4.5:1)',
        target: {
          selector: '#fail',
          role: 'button',
          name: 'Grey on grey',
          componentName: null,
          signature: 'button',
        },
      });
      expect(finding.trace).toEqual({
        route: '/contrast.html',
        url,
        viewport: DEFAULT_TEST_VIEWPORT,
        steps: [
          { kind: 'navigate', url },
          { kind: 'set-viewport', viewport: DEFAULT_TEST_VIEWPORT },
          { kind: 'measure', what: 'text colour, background colour and contrast ratio' },
        ],
      });
      const [measurements, ...rest] = finding.evidence;
      expect(rest).toEqual([]);
      expect(measurements).toMatchObject({ kind: 'measurements' });
      expect(await readJson((measurements as { ref: EvidenceRef }).ref)).toEqual({
        selector: '#fail',
        colour: 'rgb(156, 163, 175)',
        background: 'rgb(229, 231, 235)',
        ratio: 2.05,
        required: 4.5,
        fontSize: 16,
        fontWeight: 400,
      });
    });

    test('a low finding is medium severity and needs 4.5:1 at 16 px', async () => {
      const { findings } = await measure('contrast.html');

      expect(findingFor(findings, CONTRAST_LOW, '#low')).toMatchObject({
        severity: 'medium',
        observed: '"Nearly legible" is rgb(123, 123, 123) on rgb(255, 255, 255), 4.23:1 (needs 4.5:1)',
      });
    });

    test('finds nothing else on the page: no target is small, none is out of the Tab order', async () => {
      const { findings } = await measure('contrast.html');

      expect(findings.map((finding) => finding.rule.id).sort()).toEqual([CONTRAST_FAIL, CONTRAST_LOW]);
    });
  });

  describe('text contrast edge cases on contrast-edge.html', () => {
    test('blends translucent text over the background before taking the ratio', async () => {
      const { findings } = await measure('contrast-edge.html');

      expect(findingFor(findings, CONTRAST_FAIL, '#translucent').observed).toBe(
        '"Faint ink" is rgba(0, 0, 0, 0.3) on rgb(255, 255, 255), 2.11:1 (needs 4.5:1)',
      );
    });

    test('rounds the ratio once: 2.995 reads, compares and is stored as 3, so it is low and not unreadable', async () => {
      const { findings } = await measure('contrast-edge.html');
      const finding = findingFor(findings, CONTRAST_LOW, '#rounds-to-three');
      const measurements = finding.evidence[0];

      expect(selectorsFor(findings, CONTRAST_FAIL)).not.toContain('#rounds-to-three');
      expect(finding.observed).toBe(
        '"Just at three" is rgb(149, 149, 149) on rgb(255, 255, 255), 3.00:1 (needs 4.5:1)',
      );
      expect(await readJson((measurements as { ref: EvidenceRef }).ref)).toMatchObject({ ratio: 3 });
    });

    test('judges text in lab(), oklab() and a wide-gamut space by the colour Chromium paints', async () => {
      const { findings } = await measure('contrast-edge.html');

      expect(selectorsFor(findings, CONTRAST_FAIL)).toEqual(['#translucent', '#lab-faint']);
      expect(selectorsFor(findings, CONTRAST_LOW)).toEqual(['#rounds-to-three', '#wide-gamut', '#oklab-low']);
      expect(findingFor(findings, CONTRAST_FAIL, '#lab-faint').observed).toBe(
        '"Grey in lab()" is rgb(171, 171, 171) on rgb(255, 255, 255), 2.30:1 (needs 4.5:1)',
      );
      expect(findingFor(findings, CONTRAST_LOW, '#wide-gamut').observed).toBe(
        '"Display P3 red" is rgb(255, 0, 0) on rgb(255, 255, 255), 4.00:1 (needs 4.5:1)',
      );
    });

    test('skips a background that opacity makes untrustworthy, and says why', async () => {
      const { skipped } = await measure('contrast-edge.html');

      expect(skipped).toEqual([{ reason: 'background-uncertain:opacity', count: 1 }]);
    });
  });

  describe('text contrast with the text in descendants, on contrast-descendant.html', () => {
    test('skips the anchors whose text sits in a child with its own colour or background, and judges the rest', async () => {
      const { findings, skipped } = await measure('contrast-descendant.html');

      // #white-on-black would read 1.1:1 on its own colour and be reported though its visible text is white
      // on black; #badge-host has a badge whose own white-on-blue text is not what the anchor's colours say.
      expect(skipped).toEqual([{ reason: 'text-colour-uncertain:descendant', count: 2 }]);
      expect(selectorsFor(findings, CONTRAST_FAIL)).toEqual(['#plain-faint']);
      expect(selectorsFor(findings, CONTRAST_LOW)).toEqual([]);
    });
  });

  describe('text contrast on a crowded screen', () => {
    test(`judges at most ${MAX_CONTRAST_ELEMENTS} elements and counts the rest as skipped`, async () => {
      const ipage = await browser.newPage();
      try {
        const buttons = Array.from(
          { length: MAX_CONTRAST_ELEMENTS + OVER_THE_CAP },
          (_, index) =>
            `<button type="button" style="width: 120px; height: 40px; margin: 8px">Item ${index}</button>`,
        );
        await ipage.page.setContent(`<body style="background: #fff">${buttons.join('')}</body>`);
        const context = await lensContextFor(ipage, run.ctx);

        const { skipped } = await measureStatic(context, context.screen.elements);

        expect(context.screen.elements).toHaveLength(MAX_CONTRAST_ELEMENTS + OVER_THE_CAP);
        expect(skipped).toEqual([{ reason: 'contrast-elements-cap', count: OVER_THE_CAP }]);
      } finally {
        await ipage.close();
      }
    });
  });

  describe('target size', () => {
    test('reports the two crowded 16 px buttons and the crowded custom checkbox, and nothing exempt', async () => {
      const { findings } = await measure('targets.html');

      // #lone is as small as #icon but has room around it; #big and #big-next are large enough; #inline,
      // #check, #radio, #pick and #off are exempt.
      expect(selectorsFor(findings, TARGET_SIZE)).toEqual(['#icon', '#icon-next', '#custom-check']);
    });

    test('the exempt controls are small and crowded, so only their exemption keeps them off the list', async () => {
      const { context } = await measure('targets.html');
      const { elements } = context.screen;
      const passesBySize = (selector: string): boolean => {
        const target = elements.find((element) => element.selector === selector);
        if (target === undefined) throw new Error(`no element ${selector} on the screen`);
        const others = elements.filter((element) => element !== target).map((element) => element.box);
        return passesTargetSize(target.box, others).ok;
      };

      expect(['#inline', '#check', '#radio', '#pick', '#off'].filter(passesBySize)).toEqual([]);
    });

    test('does not count a listbox as crowding the option rows inside it', async () => {
      const { context, findings } = await measure('listbox.html');
      const rows = context.screen.elements.filter((element) => element.role === 'option');

      // The rows are under 24 px tall and 4 px apart (14 px from one centre to the next row), so the
      // listbox around them is the only thing that could put one inside another's 24 px circle.
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.box.height < MIN_TARGET_PX)).toBe(true);
      expect(selectorsFor(findings, TARGET_SIZE)).toEqual([]);
    });

    test('says how big the target is and how far the nearest other one is from its centre', async () => {
      const { context, findings } = await measure('targets.html');
      const finding = findingFor(findings, TARGET_SIZE, '#icon');
      const { url } = context.screen;

      expect(finding).toMatchObject({
        source: 'interaction',
        severity: 'medium',
        key: '/targets.html|#icon',
        observed: '16×16 px, nearest other target 12 px away',
        target: {
          selector: '#icon',
          role: 'button',
          name: 'Close',
          componentName: null,
          signature: 'button.at.small',
        },
      });
      expect(finding.trace.steps).toEqual([
        { kind: 'navigate', url },
        { kind: 'set-viewport', viewport: DEFAULT_TEST_VIEWPORT },
        { kind: 'measure', what: 'size and the distance to the nearest other target' },
      ]);
      expect(await readJson((finding.evidence[0] as { ref: EvidenceRef }).ref)).toEqual({
        selector: '#icon',
        width: 16,
        height: 16,
        nearest: 12,
      });
    });
  });

  describe('keyboard reachability on keyboard.html', () => {
    test('reports the divs and the span that look like controls and cannot be focused', async () => {
      const { findings } = await measure('keyboard.html');

      // Not #tab-zero (reachable), #roving (focusable by a script), #disabled, #list or #apple (an option is
      // not a role that must be reachable), #bold or #italic (their toolbar points at them with
      // aria-activedescendant, so they are never focused themselves). #combo names an active descendant
      // itself and cannot be focused: it is a control, not the child of one.
      expect(selectorsFor(findings, KEYBOARD)).toEqual(['#no-tab', '#span-link', '#combo']);
    });

    test('names the control and what is wrong', async () => {
      const { context, findings } = await measure('keyboard.html');
      const finding = findingFor(findings, KEYBOARD, '#no-tab');
      const { url } = context.screen;

      expect(finding).toMatchObject({
        source: 'interaction',
        severity: 'high',
        key: '/keyboard.html|#no-tab',
        observed: 'cannot receive keyboard focus',
        target: {
          selector: '#no-tab',
          role: 'button',
          name: 'Delete',
          componentName: null,
          signature: 'div',
        },
      });
      expect(finding.trace.steps).toEqual([
        { kind: 'navigate', url },
        { kind: 'set-viewport', viewport: DEFAULT_TEST_VIEWPORT },
        { kind: 'measure', what: 'whether the element can receive focus' },
      ]);
      expect(await readJson((finding.evidence[0] as { ref: EvidenceRef }).ref)).toEqual({
        selector: '#no-tab',
        role: 'button',
        tag: 'div',
        focusable: false,
      });
    });
  });

  describe('positive tabindex', () => {
    test('is one finding for the screen with one occurrence per element, in document order', async () => {
      const { context, findings } = await measure('keyboard.html');
      const [finding, ...rest] = forRule(findings, POSITIVE_TABINDEX);
      const { url } = context.screen;

      expect(rest).toEqual([]);
      const occurrence = asOccurrence(finding);
      expect(occurrence).toMatchObject({
        source: 'interaction',
        severity: 'low',
        key: '/keyboard.html',
        observed: 'sets a tabindex above 0 on 2 elements',
      });
      expect(occurrence.occurrences).toEqual([
        {
          screenId: 'screen-1',
          route: '/keyboard.html',
          url,
          viewport: DEFAULT_TEST_VIEWPORT,
          selector: '#pos-three',
          measured: { tabindex: 3 },
        },
        {
          screenId: 'screen-1',
          route: '/keyboard.html',
          url,
          viewport: DEFAULT_TEST_VIEWPORT,
          selector: '#pos-one',
          measured: { tabindex: 1 },
        },
      ]);
    });

    test('is nothing on a page with no tabindex above 0', async () => {
      const { findings } = await measure('targets.html');

      expect(forRule(findings, POSITIVE_TABINDEX)).toEqual([]);
    });
  });

  describe('the deadline', () => {
    test('leaves every element unmeasured once it has passed, and says how many', async () => {
      const { context, findings, skipped } = await measure('contrast.html', { deadline: 0 });
      const count = context.screen.elements.length;

      expect(findings).toEqual([]);
      expect(skipped).toEqual([
        { reason: 'time-budget:text-contrast', count },
        { reason: 'time-budget:target-size', count },
        { reason: 'time-budget:keyboard-reachability', count },
      ]);
    });
  });
});
