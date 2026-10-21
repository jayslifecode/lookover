import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type {
  ElementRef,
  EvidenceRef,
  Finding,
  InstrumentedPage,
  LensContext,
  StepFinding,
} from '@jayslifecode/lookover-core';
import { type FixtureServer, serveFixture } from '@jayslifecode/lookover-test-support';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { STATE_STYLE_PROPERTIES, type StyleSnapshot, type StyleValues } from '../src/interaction/in-page.js';
import {
  CROP_PADDING_PX,
  captureStates,
  focusIndicatorColor,
  focusMarkOf,
  type GalleryEntry,
  MAX_FOCUS_WITHIN_DEPTH,
  MAX_GALLERY_ELEMENTS,
  MAX_STATE_ELEMENTS,
  type StatesResult,
  stateDiffers,
} from '../src/interaction/states.js';
import { createTestRun, type LensContextOptions, lensContextFor, type TestRun } from './helpers/context.js';
import { DEFAULT_TEST_VIEWPORT, launchTestSession, type TestSession } from './helpers/session.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/states', import.meta.url));
const BROWSER_TIMEOUT_MS = 60_000;
const FOCUS_VISIBLE = 'interaction.focus-visible-missing';
const INDICATOR_CONTRAST = 'interaction.focus-indicator-contrast';
const HOVER_MISSING = 'interaction.hover-state-missing';
const ALL_STATES = ['rest', 'hover', 'focus', 'active'];
/** The rest background of every button in ring.html (#f9fafb). */
const REST_BUTTON_BACKGROUND = 'rgb(249, 250, 251)';
/** Where a PNG's IHDR chunk keeps the width and the height. */
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;

const BLUE = 'rgb(29, 78, 216)';
const CLEAR = 'rgba(0, 0, 0, 0)';
const NO_SHADOW_LAYER = `${CLEAR} 0px 0px 0px 0px`;
const AT_REST: StyleValues = {
  ...(Object.fromEntries(STATE_STYLE_PROPERTIES.map((name) => [name, ''])) as StyleValues),
  'outline-style': 'none',
  'outline-width': '0px',
  'outline-color': 'rgb(17, 24, 39)',
  'box-shadow': 'none',
  'background-color': REST_BUTTON_BACKGROUND,
  color: 'rgb(17, 24, 39)',
  cursor: 'default',
};

/** A snapshot whose element, `::before` and `::after` all hold the rest values, with `self` changed. */
function snapshot(self: Partial<StyleValues> = {}, after: Partial<StyleValues> = {}): StyleSnapshot {
  return { self: { ...AT_REST, ...self }, before: AT_REST, after: { ...AT_REST, ...after } };
}

describe('stateDiffers', () => {
  test('is false when nothing tracked changed', () => {
    expect(stateDiffers(snapshot(), snapshot())).toBe(false);
  });

  test('is true when the element itself changed, the cursor included', () => {
    expect(stateDiffers(snapshot(), snapshot({ 'background-color': 'rgb(229, 231, 235)' }))).toBe(true);
    expect(stateDiffers(snapshot(), snapshot({ cursor: 'pointer' }))).toBe(true);
  });

  test('is true when only a pseudo-element changed', () => {
    expect(stateDiffers(snapshot(), snapshot({}, { 'outline-style': 'solid' }))).toBe(true);
    const before: StyleSnapshot = {
      ...snapshot(),
      before: { ...AT_REST, 'box-shadow': `${BLUE} 0px 0px 0px 2px` },
    };
    expect(stateDiffers(snapshot(), before)).toBe(true);
  });

  test('is false when the outline stays none, whatever its width, colour and offset do', () => {
    const undrawn: Partial<StyleValues> = {
      'outline-width': '2px',
      'outline-color': BLUE,
      'outline-offset': '2px',
    };

    expect(stateDiffers(snapshot(), snapshot(undrawn))).toBe(false);
    expect(stateDiffers(snapshot(), snapshot({}, undrawn))).toBe(false);
  });

  test('is true when the outline is drawn in either state', () => {
    const drawn: Partial<StyleValues> = { 'outline-style': 'solid', 'outline-width': '2px' };

    expect(stateDiffers(snapshot(), snapshot(drawn))).toBe(true);
    expect(stateDiffers(snapshot(drawn), snapshot())).toBe(true);
    expect(stateDiffers(snapshot(drawn), snapshot({ ...drawn, 'outline-color': BLUE }))).toBe(true);
  });
});

describe('focusIndicatorColor', () => {
  const outline = (color: string, style = 'solid'): Partial<StyleValues> => ({
    'outline-style': style,
    'outline-width': '2px',
    'outline-color': color,
  });

  test('is the colour of an outline that appears', () => {
    expect(focusIndicatorColor(snapshot(), snapshot(outline(BLUE)))).toBe(BLUE);
  });

  test('is the colour of an outline that was there but transparent', () => {
    expect(focusIndicatorColor(snapshot(outline(CLEAR)), snapshot(outline(BLUE)))).toBe(BLUE);
  });

  test('is the colour of a box-shadow that appears', () => {
    expect(focusIndicatorColor(snapshot(), snapshot({ 'box-shadow': `${BLUE} 0px 0px 0px 3px` }))).toBe(BLUE);
  });

  test('passes over a transparent outline to the ring drawn with box-shadow', () => {
    const focus = snapshot({ ...outline(CLEAR), 'box-shadow': `${BLUE} 0px 0px 0px 3px` });

    expect(focusIndicatorColor(snapshot(), focus)).toBe(BLUE);
  });

  test('takes the outermost new layer of a ring with an offset, not the offset or empty layers', () => {
    // Tailwind's `ring-2 ring-offset-2`: empty layers, a white offset, the ring around it.
    const ring = 'oklch(0.546 0.245 262.881)';
    const layers = [
      NO_SHADOW_LAYER,
      `rgb(255, 255, 255) 0px 0px 0px 2px`,
      `${ring} 0px 0px 0px 4px`,
      NO_SHADOW_LAYER,
    ];

    expect(focusIndicatorColor(snapshot(), snapshot({ 'box-shadow': layers.join(', ') }))).toBe(ring);
  });

  test('is null when the mark is a fill or text change, an inset ring, a shadow already there or on ::after', () => {
    const shadow = `${BLUE} 0px 0px 0px 3px`;

    expect(focusIndicatorColor(snapshot(), snapshot({ 'background-color': BLUE }))).toBeNull();
    expect(focusIndicatorColor(snapshot(), snapshot({ 'box-shadow': `${shadow} inset` }))).toBeNull();
    expect(
      focusIndicatorColor(snapshot({ 'box-shadow': shadow }), snapshot({ 'box-shadow': shadow })),
    ).toBeNull();
    expect(focusIndicatorColor(snapshot(), snapshot({}, outline(BLUE)))).toBeNull();
  });

  test("is null for the browser's own ring, which it paints itself in a colour that depends on the platform", () => {
    expect(focusIndicatorColor(snapshot(), snapshot(outline('rgb(0, 95, 204)', 'auto')))).toBeNull();
  });
});

describe('focusMarkOf', () => {
  const ring = snapshot({ 'box-shadow': `${BLUE} 0px 0px 0px 3px` });

  test('is the control itself when it changes, whatever its ancestors do', () => {
    const rest = { self: snapshot(), ancestors: [snapshot()] };

    expect(focusMarkOf(rest, { self: snapshot({ 'outline-style': 'auto' }), ancestors: [ring] })).toBe(
      'self',
    );
  });

  test('is the first ancestor that changes, counted from the parent', () => {
    const rest = { self: snapshot(), ancestors: [snapshot(), snapshot(), snapshot()] };

    expect(focusMarkOf(rest, { self: snapshot(), ancestors: [snapshot(), ring, ring] })).toBe('ancestor:2');
  });

  test('is null when neither the control nor an ancestor changes', () => {
    const rest = { self: snapshot(), ancestors: [snapshot()] };

    expect(focusMarkOf(rest, { self: snapshot(), ancestors: [snapshot()] })).toBeNull();
    expect(
      focusMarkOf({ self: snapshot(), ancestors: [] }, { self: snapshot(), ancestors: [ring] }),
    ).toBeNull();
  });
});

describe('captureStates', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let browser: TestSession;

  beforeAll(async () => {
    fixture = await serveFixture(FIXTURE_DIR);
    browser = await launchTestSession();
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await browser.close();
    await fixture.close();
  }, BROWSER_TIMEOUT_MS);

  function asStep(finding: Finding | undefined): StepFinding {
    if (finding?.shape !== 'step') throw new Error('expected a step finding');
    return finding;
  }

  function selectorsFor(findings: readonly Finding[], ruleId: string): (string | undefined)[] {
    return findings.filter((finding) => finding.rule.id === ruleId).map((f) => asStep(f).target?.selector);
  }

  function entryFor(result: StatesResult, selector: string): GalleryEntry {
    const entry = result.gallery.entries.find((candidate) => candidate.selector === selector);
    if (entry === undefined) throw new Error(`no gallery entry for ${selector}`);
    return entry;
  }

  function elementFor(context: LensContext, selector: string): ElementRef {
    const element = context.screen.elements.find((candidate) => candidate.selector === selector);
    if (element === undefined) throw new Error(`no element ${selector} on the screen`);
    return element;
  }

  describe('on ring.html', () => {
    let run: TestRun;
    let ipage: InstrumentedPage;
    let context: LensContext;
    let focusedAtLoad: string | undefined;
    let result: StatesResult;

    beforeAll(async () => {
      run = await createTestRun(fixture.url);
      ipage = await browser.newPage();
      await ipage.page.goto(`${fixture.url}/ring.html`);
      context = await lensContextFor(ipage, run.ctx);
      focusedAtLoad = await ipage.page.evaluate(() => document.activeElement?.id);
      result = await captureStates(context, context.screen.elements);
    }, BROWSER_TIMEOUT_MS);

    afterAll(async () => {
      await ipage.close();
      await run.dispose();
    });

    async function readJson(ref: EvidenceRef): Promise<unknown> {
      return JSON.parse(await readFile(run.ctx.evidence.resolve(ref), 'utf8'));
    }

    async function pngSize(ref: EvidenceRef | undefined): Promise<{ width: number; height: number }> {
      if (ref === undefined) throw new Error('expected a crop');
      const png = await readFile(run.ctx.evidence.resolve(ref));
      return { width: png.readUInt32BE(PNG_WIDTH_OFFSET), height: png.readUInt32BE(PNG_HEIGHT_OFFSET) };
    }

    test('reports #none and not #ok, #shadow or #after', () => {
      // #search had focus as the page loaded; taking its focus ring for its rest state would report it.
      expect(focusedAtLoad).toBe('search');
      expect(selectorsFor(result.findings, FOCUS_VISIBLE)).toEqual(['#none']);
    });

    test('a missing focus mark carries its trace, its crops and both style snapshots', async () => {
      const finding = asStep(result.findings.find((candidate) => candidate.rule.id === FOCUS_VISIBLE));
      const { url } = context.screen;

      expect(finding).toMatchObject({
        source: 'interaction',
        severity: 'high',
        status: 'candidate',
        screenId: 'screen-1',
        key: '/ring.html|#none',
        observed: 'shows no change when it receives keyboard focus',
        target: { selector: '#none', role: 'button', name: 'No ring', componentName: null },
      });
      expect(finding.trace).toEqual({
        route: '/ring.html',
        url,
        viewport: DEFAULT_TEST_VIEWPORT,
        steps: [
          { kind: 'navigate', url },
          { kind: 'set-viewport', viewport: DEFAULT_TEST_VIEWPORT },
          { kind: 'force-state', selector: '#none', state: 'focus' },
          {
            kind: 'measure',
            what: 'computed styles of the control, its ::before/::after and its nearest ancestors, before and after focus',
          },
        ],
      });
      const [rest, focus, styles] = finding.evidence;
      expect(finding.evidence.map(({ kind, label }) => [kind, label])).toEqual([
        ['crop', 'at rest'],
        ['crop', 'focused'],
        ['styles', 'computed styles at rest and focused'],
      ]);
      expect([rest?.ref, focus?.ref]).toEqual([
        entryFor(result, '#none').crops.rest,
        entryFor(result, '#none').crops.focus,
      ]);
      if (styles === undefined) throw new Error('expected the styles evidence');
      expect(await readJson(styles.ref)).toMatchObject({
        selector: '#none',
        rest: { self: { 'outline-style': 'none' } },
        focus: { self: { 'outline-style': 'none' } },
      });
    });

    test('reports #faint as a too-faint indicator with the measured ratio', () => {
      const faint = result.findings.filter((finding) => finding.rule.id === INDICATOR_CONTRAST);

      expect(selectorsFor(faint, INDICATOR_CONTRAST)).toEqual(['#faint']);
      expect(faint[0]?.observed).toMatch(/1\.2\d:1/);
      expect(faint[0]).toMatchObject({
        severity: 'medium',
        observed: 'has a focus outline rgb(229, 231, 235) with 1.24:1 contrast against rgb(255, 255, 255)',
      });
      expect(faint[0]?.evidence.map(({ kind }) => kind)).toEqual(['crop', 'crop', 'styles']);
    });

    test('#nohover is worth a look; #hover and #link-plain (cursor change) are not', () => {
      // #eased fades its hover colour in, #link-thick thickens its underline, #hover-scale grows and
      // #hover-gradient shows a gradient: all change on hover. #link-bare keeps the browser's pointer
      // cursor and has no hover rule, so it is worth a look too.
      expect(selectorsFor(result.worthALook, HOVER_MISSING)).toEqual(['#nohover', '#link-bare']);
      expect(entryFor(result, '#hover-scale').states.hover?.self.scale).toBe('1.05');
      expect(entryFor(result, '#hover-gradient').states.hover?.self['background-image']).toMatch(
        /^linear-gradient\(/,
      );
      expect(result.worthALook.every((finding) => finding.rule.id === HOVER_MISSING)).toBe(true);
      expect(selectorsFor(result.findings, HOVER_MISSING)).toEqual([]);
      expect(asStep(result.worthALook[0]).trace.steps[2]).toEqual({
        kind: 'force-state',
        selector: '#nohover',
        state: 'hover',
      });
    });

    test('records every control in every state, in reading order', () => {
      expect(result.gallery).toMatchObject({
        screenId: 'screen-1',
        viewport: DEFAULT_TEST_VIEWPORT,
        focusOrder: [],
      });
      expect(result.gallery.entries.map((entry) => entry.selector)).toEqual(
        context.screen.elements.map((element) => element.selector),
      );
      const hover = entryFor(result, '#hover');
      expect(hover).toMatchObject({
        role: 'button',
        name: 'Hover colour',
        componentName: null,
        skipped: null,
      });
      expect(Object.keys(hover.states)).toEqual(ALL_STATES);
      expect(hover.states.rest?.self['background-color']).toBe(REST_BUTTON_BACKGROUND);
      expect(hover.states.hover?.self['background-color']).toBe('rgb(219, 234, 254)');
      expect(entryFor(result, '#search').states.rest?.self['outline-style']).toBe('none');
      expect(
        ['#none', '#ok', '#after', '#off'].map((selector) => entryFor(result, selector).focusMarkOn),
      ).toEqual([null, 'self', 'self', null]);
      // The nine focusable controls that keep the browser's own ring: their contrast is not judged.
      expect(result.skipped).toEqual([{ reason: 'focus-indicator-ua-ring', count: 9 }]);
    });

    test('crops each state while it is forced, padded around the control', async () => {
      const { crops } = entryFor(result, '#hover');
      const { box } = elementFor(context, '#hover');

      expect(Object.keys(crops)).toEqual(ALL_STATES);
      expect(crops.hover?.id).not.toBe(crops.rest?.id);
      const size = await pngSize(crops.rest);
      expect(Math.abs(size.width - (box.width + 2 * CROP_PADDING_PX))).toBeLessThanOrEqual(1);
      expect(Math.abs(size.height - (box.height + 2 * CROP_PADDING_PX))).toBeLessThanOrEqual(1);
    });

    test('reads a hover colour that fades in once its transition has run', () => {
      expect(entryFor(result, '#eased').states.hover?.self['background-color']).toBe('rgb(229, 231, 235)');
    });

    test('records a disabled control at rest only', () => {
      const off = entryFor(result, '#off');

      expect(off).toMatchObject({ skipped: 'disabled', crops: {} });
      expect(Object.keys(off.states)).toEqual(['rest']);
    });
  });

  describe('on a fresh page', () => {
    let run: TestRun;
    let ipage: InstrumentedPage;

    beforeEach(async () => {
      run = await createTestRun(fixture.url);
      ipage = await browser.newPage();
    });

    afterEach(async () => {
      await ipage.close();
      await run.dispose();
    });

    async function open(file: string, options: LensContextOptions = {}): Promise<LensContext> {
      await ipage.page.goto(`${fixture.url}/${file}`);
      return lensContextFor(ipage, run.ctx, options);
    }

    test('forced states leave no state behind', async () => {
      const context = await open('ring.html');

      await captureStates(context, context.screen.elements);

      const styles = await ipage.page.evaluate(() => {
        const style = (selector: string): CSSStyleDeclaration => {
          const element = document.querySelector(selector);
          if (element === null) throw new Error(`no ${selector}`);
          return getComputedStyle(element);
        };
        return {
          hover: style('#hover').backgroundColor,
          eased: style('#eased').backgroundColor,
          ok: style('#ok').outlineStyle,
          after: getComputedStyle(document.querySelector('#after') ?? document.body, '::after').outlineStyle,
        };
      });
      expect(styles).toEqual({
        hover: REST_BUTTON_BACKGROUND,
        eased: REST_BUTTON_BACKGROUND,
        ok: 'none',
        after: 'none',
      });
    });

    test('records a control that left the page as gone and one without a backend node id as skipped', async () => {
      const context = await open('ring.html');
      const { backendNodeId: _, ...withoutNodeId } = elementFor(context, '#shadow');
      await ipage.page.evaluate(() => document.querySelector('#ok')?.remove());

      const result = await captureStates(context, [
        elementFor(context, '#ok'),
        withoutNodeId,
        elementFor(context, '#hover'),
      ]);

      expect(result.gallery.entries.map(({ selector, skipped }) => [selector, skipped])).toEqual([
        ['#ok', 'gone'],
        ['#shadow', 'no-backend-node'],
        ['#hover', null],
      ]);
      expect(entryFor(result, '#hover').states.hover?.self['background-color']).toBe('rgb(219, 234, 254)');
    });

    test('records a control that leaves while a state is forced as gone, and goes on', async () => {
      const context = await open('vanish.html');

      const result = await captureStates(context, context.screen.elements);

      // The page removes it once its hover animation starts, after the hover snapshot in practice; when
      // exactly is the page's business, so only "gone before it was pressed" is certain.
      const vanish = entryFor(result, '#vanish');
      expect(vanish.skipped).toBe('gone');
      expect(vanish.states.rest).toBeDefined();
      expect(vanish.states.active).toBeUndefined();
      expect(await ipage.page.locator('#vanish').count()).toBe(0);
      expect(entryFor(result, '#stays').skipped).toBeNull();
      expect(entryFor(result, '#stays').states.hover?.self['background-color']).toBe('rgb(219, 234, 254)');
    });

    test('caps forced states at 60 elements and crops at 12 signatures', async () => {
      const context = await open('many.html');
      expect(context.screen.elements).toHaveLength(80);

      const { gallery, skipped } = await captureStates(context, context.screen.elements);

      expect(gallery.entries).toHaveLength(MAX_STATE_ELEMENTS);
      expect(skipped).toContainEqual({ reason: 'state-elements-cap', count: 20 });
      const cropped = gallery.entries.filter((entry) => Object.keys(entry.crops).length > 0);
      // One control per class signature: button.btn.primary, button.btn.secondary, button.btn.ghost.
      expect(cropped.map((entry) => entry.selector)).toEqual(['#b1', '#b2', '#b3']);
      expect(cropped.every((entry) => Object.keys(entry.crops).length === ALL_STATES.length)).toBe(true);
      const crops = gallery.entries.flatMap((entry) => Object.keys(entry.crops));
      expect(crops.length).toBeLessThanOrEqual(MAX_GALLERY_ELEMENTS * ALL_STATES.length);
    });

    test('crops the controls of the first 12 signatures only', async () => {
      const context = await open('signatures.html');

      const { gallery } = await captureStates(context, context.screen.elements);

      const cropped = gallery.entries.filter((entry) => Object.keys(entry.crops).length > 0);
      expect(gallery.entries).toHaveLength(16);
      expect(cropped.map((entry) => entry.selector)).toEqual(
        Array.from({ length: MAX_GALLERY_ELEMENTS }, (_, index) => `#k${index + 1}`),
      );
    });

    test("skips the browser's own focus ring rather than judge its platform colour on a dark page", async () => {
      const context = await open('dark.html');

      const result = await captureStates(context, context.screen.elements);

      expect(selectorsFor(result.findings, INDICATOR_CONTRAST)).toEqual(['#below']);
      expect(entryFor(result, '#default-ring').focusMarkOn).toBe('self');
      expect(result.skipped).toEqual([{ reason: 'focus-indicator-ua-ring', count: 1 }]);
    });

    test('rounds the ratio once, so it is judged by the number it reports', async () => {
      const context = await open('dark.html');

      const result = await captureStates(context, context.screen.elements);

      // #almost is 2.998:1, which is 3.00:1 to two decimals: it passes rather than read "3.00:1" as a failure.
      const [below] = result.findings.filter((finding) => finding.rule.id === INDICATOR_CONTRAST);
      expect(below?.observed).toBe(
        'has a focus outline rgb(99, 99, 99) with 2.95:1 contrast against rgb(17, 24, 39)',
      );
      const styles = below?.evidence.find((item) => item.kind === 'styles');
      if (styles === undefined) throw new Error('expected the styles evidence');
      expect(JSON.parse(await readFile(run.ctx.evidence.resolve(styles.ref), 'utf8'))).toMatchObject({
        indicator: 'rgb(99, 99, 99)',
        background: 'rgb(17, 24, 39)',
        ratio: 2.95,
      });
    });

    test('accepts a focus mark on an ancestor within three levels and leaves its contrast unjudged', async () => {
      const context = await open('focus-within.html');

      const result = await captureStates(context, context.screen.elements);

      expect(MAX_FOCUS_WITHIN_DEPTH).toBe(3);
      expect(selectorsFor(result.findings, FOCUS_VISIBLE)).toEqual(['#too-deep', '#bare']);
      expect(entryFor(result, '#in-field').focusMarkOn).toBe('ancestor:2');
      expect(entryFor(result, '#too-deep').focusMarkOn).toBeNull();
      expect(result.skipped).toEqual([{ reason: 'focus-indicator-on-ancestor', count: 1 }]);
    });

    test('reports a control whose focus removes the shared ring, though the ring rule still sets its width and colour', async () => {
      const context = await open('outline-none.html');

      const result = await captureStates(context, context.screen.elements);

      const removed = entryFor(result, '#no-ring');
      expect(removed.states.focus?.self).toMatchObject({ 'outline-style': 'none', 'outline-color': BLUE });
      expect(removed.states.rest?.self['outline-color']).not.toBe(BLUE);
      expect(selectorsFor(result.findings, FOCUS_VISIBLE)).toEqual(['#no-ring']);
      expect(removed.focusMarkOn).toBeNull();
      expect(entryFor(result, '#ring').focusMarkOn).toBe('self');
    });

    test('skips a focus ring whose background or colour cannot be read, and says why', async () => {
      const context = await open('uncertain.html');

      const result = await captureStates(context, context.screen.elements);

      expect(result.findings).toEqual([]);
      expect(result.skipped).toEqual([
        { reason: 'focus-indicator-background:background-image', count: 1 },
        { reason: 'focus-indicator-colour-unreadable', count: 1 },
      ]);
    });

    test('stops at the deadline and says how many it skipped', async () => {
      const context = await open('ring.html', { deadline: performance.now() });

      const result = await captureStates(context, context.screen.elements);

      expect(result.gallery.entries).toEqual([]);
      expect(result.findings).toEqual([]);
      expect(result.worthALook).toEqual([]);
      expect(result.skipped).toEqual([{ reason: 'time-budget', count: context.screen.elements.length }]);
      expect(context.screen.elements).toHaveLength(15);
    });
  });
});
