import { readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import type {
  Finding,
  LensContext,
  Occurrence,
  OccurrenceFinding,
  Reproduction,
  ReproductionTarget,
  StepFinding,
  Viewport,
} from '@jayslifecode/lookover-core';
import { type FixtureRoute, type FixtureServer, serveFixture } from '@jayslifecode/lookover-test-support';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { InteractionLens } from '../src/index.js';
import { measureStatic } from '../src/interaction/static.js';
import { sweepViewports } from '../src/interaction/viewports.js';
import { createTestRun, type LensContextOptions, lensContextFor, type TestRun } from './helpers/context.js';
import { DEFAULT_TEST_VIEWPORT, launchTestSession, type TestSession } from './helpers/session.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));
const BROWSER_TIMEOUT_MS = 60_000;
const FOCUS_VISIBLE = 'interaction.focus-visible-missing';
const HOVER_MISSING = 'interaction.hover-state-missing';
const CONTRAST_FAIL = 'interaction.text-contrast-fail';
const TARGET_SIZE = 'interaction.target-size';
const POSITIVE_TABINDEX = 'interaction.positive-tabindex';
const FOCUS_HIDDEN = 'interaction.focus-hidden';
const OVERFLOW = 'interaction.horizontal-overflow';
const CLIPPED = 'interaction.text-clipped';
const MOBILE: Viewport = { name: 'mobile', width: 390, height: 844 };
const SWEPT_VIEWPORTS: readonly Viewport[] = [DEFAULT_TEST_VIEWPORT, MOBILE];
/** Asked for with this query, a page that has a fixed variant serves the variant at its own path. */
const FIXED_QUERY = 'fixed';
/**
 * Each fixed variant and the page it fixes. The variant is served at that page's path (with
 * `?fixed`), as the same app would serve it once the defect is fixed: the route, and with it the id of
 * the finding, stays the same, so only the fix can keep the finding from coming out again.
 */
const FIXED_VARIANTS: Readonly<Record<string, string>> = {
  'states/ring-fixed.html': 'states/ring.html',
  'static/contrast-fixed.html': 'static/contrast.html',
};

interface FreshPageOptions extends LensContextOptions {
  /** Changes the page once it has loaded, before its screen is captured. */
  prepare?: (page: Page) => Promise<unknown>;
}

function isFixedRequest(req: IncomingMessage): boolean {
  return new URL(req.url ?? '/', 'http://fixture.invalid').searchParams.has(FIXED_QUERY);
}

/** The page at its own path, or its fixed variant when the request asks for that. */
function servingFixedWhenAsked(variant: string): FixtureRoute {
  return (req, _res, serveStatic) => serveStatic(isFixedRequest(req) ? `/${variant}` : undefined);
}

const FIXED_ROUTES: Readonly<Record<string, FixtureRoute>> = Object.fromEntries(
  Object.entries(FIXED_VARIANTS).map(([variant, page]) => [`/${page}`, servingFixedWhenAsked(variant)]),
);

function rulesAndKeys(findings: readonly Finding[]): [string, string][] {
  return findings.map((finding) => [finding.rule.id, finding.key]);
}

describe('InteractionLens.reproduce', { timeout: BROWSER_TIMEOUT_MS }, () => {
  const lens = new InteractionLens();
  let fixture: FixtureServer;
  let browser: TestSession;
  let run: TestRun;

  beforeAll(async () => {
    fixture = await serveFixture(FIXTURE_DIR, FIXED_ROUTES);
    browser = await launchTestSession();
    run = await createTestRun(fixture.url);
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await browser.close();
    await fixture.close();
    await run.dispose();
  }, BROWSER_TIMEOUT_MS);

  function urlOf(file: string): string {
    const fixes = FIXED_VARIANTS[file];
    return fixes === undefined ? `${fixture.url}/${file}` : `${fixture.url}/${fixes}?${FIXED_QUERY}`;
  }

  /**
   * Loads `file` on a fresh isolated page at the first of the viewports, captures its screen and hands
   * it to `use`; the page is closed afterwards.
   */
  async function onFreshPage<T>(
    file: string,
    options: FreshPageOptions,
    use: (context: LensContext) => Promise<T>,
  ): Promise<T> {
    const [viewport = DEFAULT_TEST_VIEWPORT] = options.viewports ?? [];
    const ipage = await browser.session.newIsolatedPage(viewport);
    try {
      await ipage.page.goto(urlOf(file));
      await options.prepare?.(ipage.page);
      return await use(await lensContextFor(ipage, run.ctx, options));
    } finally {
      await ipage.close();
    }
  }

  /** The first finding for `ruleId` the lens reports on `file`, worth-a-look included. */
  async function findingOn(file: string, ruleId: string, options: LensContextOptions): Promise<Finding> {
    const result = await onFreshPage(file, options, (context) => lens.inspect(context));
    const found = [...result.findings, ...result.worthALook].find((finding) => finding.rule.id === ruleId);
    if (found === undefined) throw new Error(`no ${ruleId} on ${file}`);
    return found;
  }

  async function firstFinding(
    file: string,
    ruleId: string,
    options: LensContextOptions = {},
  ): Promise<StepFinding> {
    const finding = await findingOn(file, ruleId, options);
    if (finding.shape !== 'step') throw new Error(`expected ${ruleId} to be a step finding`);
    return finding;
  }

  /** The first finding for `ruleId` on `file`, an occurrence finding, with its first occurrence. */
  async function firstOccurrence(
    file: string,
    ruleId: string,
    options: LensContextOptions = {},
  ): Promise<{ finding: OccurrenceFinding; occurrence: Occurrence }> {
    const finding = await findingOn(file, ruleId, options);
    const [occurrence] = finding.shape === 'occurrence' ? finding.occurrences : [];
    if (finding.shape !== 'occurrence' || occurrence === undefined) {
      throw new Error(`expected ${ruleId} to be an occurrence finding`);
    }
    return { finding, occurrence };
  }

  function reproduceOn(
    file: string,
    target: ReproductionTarget,
    options: FreshPageOptions = {},
  ): Promise<Reproduction> {
    return onFreshPage(file, options, (context) => lens.reproduce(target, context));
  }

  async function readJson(reproduction: Reproduction, kind: string): Promise<unknown> {
    const item = reproduction.evidence.find((candidate) => candidate.kind === kind);
    if (item === undefined) throw new Error(`no ${kind} evidence`);
    return JSON.parse(await readFile(run.ctx.evidence.resolve(item.ref), 'utf8'));
  }

  describe('the states step', () => {
    test('reproduces a missing focus ring on the same element and not once it is fixed', async () => {
      const finding = await firstFinding('states/ring.html', 'interaction.focus-visible-missing');
      expect(await reproduceOn('states/ring.html', { finding })).toMatchObject({
        reproduced: true,
        observed: finding.observed,
      });
      expect(await reproduceOn('states/ring-fixed.html', { finding })).toMatchObject({
        reproduced: false,
        skipped: null,
      });
    });

    test('reports gone when the element is not on the page', async () => {
      const finding = await firstFinding('states/ring.html', FOCUS_VISIBLE);

      expect(await reproduceOn('static/contrast.html', { finding })).toEqual({
        reproduced: false,
        observed: null,
        skipped: 'gone',
        evidence: [],
      });
    });

    test('hover feedback reproduces from the worth-a-look list', async () => {
      const finding = await firstFinding('states/ring.html', HOVER_MISSING);

      const reproduction = await reproduceOn('states/ring.html', { finding });

      expect(finding.target?.selector).toBe('#nohover');
      // #nohover keeps the browser's own focus ring, whose contrast the step skips: that is not about hover.
      expect(reproduction).toMatchObject({ reproduced: true, observed: finding.observed, skipped: null });
      expect(reproduction.evidence.map(({ kind, label }) => [kind, label])).toEqual([
        ['crop', 'at rest'],
        ['crop', 'hovered'],
        ['styles', 'computed styles at rest and hovered'],
      ]);
      expect(await readJson(reproduction, 'styles')).toMatchObject({ selector: '#nohover' });
    });
  });

  describe('the static step', () => {
    test('reproduces a contrast failure and a crowded target through the static step with only that element', async () => {
      const contrast = await firstFinding('static/contrast.html', CONTRAST_FAIL);
      const crowded = await firstFinding('static/targets.html', TARGET_SIZE);

      const reproduction = await reproduceOn('static/contrast.html', { finding: contrast });

      expect(reproduction).toMatchObject({ reproduced: true, observed: contrast.observed, skipped: null });
      expect(await readJson(reproduction, 'measurements')).toMatchObject({ selector: '#fail', ratio: 2.05 });
      expect(await reproduceOn('static/contrast-fixed.html', { finding: contrast })).toMatchObject({
        reproduced: false,
        skipped: null,
      });
      // #icon is too small only because #icon-next is beside it: every element is still a neighbour.
      expect(crowded.target?.selector).toBe('#icon');
      expect(await reproduceOn('static/targets.html', { finding: crowded })).toMatchObject({
        reproduced: true,
        observed: crowded.observed,
        skipped: null,
      });
    });

    test('measureStatic with only judges that element alone, with every other element as its neighbour', async () => {
      const findings = await onFreshPage('static/targets.html', {}, async (context) => {
        const { elements } = context.screen;
        return (await measureStatic(context, elements, { only: '#icon' })).findings;
      });

      expect(
        findings.map((finding) => [finding.rule.id, finding.shape === 'step' && finding.target?.selector]),
      ).toEqual([[TARGET_SIZE, '#icon']]);
    });

    test('reports the reason the static step skipped the element, which is not a reproduction', async () => {
      const finding = await firstFinding('static/contrast.html', CONTRAST_FAIL);

      const reproduction = await reproduceOn(
        'static/contrast.html',
        { finding },
        {
          prepare: (page) =>
            page.evaluate(() => {
              const fail = document.querySelector<HTMLElement>('#fail');
              if (fail !== null) fail.style.backgroundImage = 'linear-gradient(90deg, #1e3a8a, #93c5fd)';
            }),
        },
      );

      expect(reproduction).toEqual({
        reproduced: false,
        observed: null,
        skipped: 'background-uncertain:background-image',
        evidence: [],
      });
    });

    test("reproduces a positive tabindex through the static step's page-wide measure", async () => {
      const target = await firstOccurrence('static/keyboard.html', POSITIVE_TABINDEX);

      expect(await reproduceOn('static/keyboard.html', target)).toMatchObject({
        reproduced: true,
        observed: target.finding.observed,
        skipped: null,
      });
      const withoutTabindex = await reproduceOn('static/keyboard.html', target, {
        prepare: (page) =>
          page.evaluate(() => {
            for (const element of document.querySelectorAll('[tabindex]')) {
              if (Number(element.getAttribute('tabindex')) > 0) element.removeAttribute('tabindex');
            }
          }),
      });
      expect(withoutTabindex).toEqual({ reproduced: false, observed: null, skipped: null, evidence: [] });
    });
  });

  describe('the Tab walk', () => {
    test('reproduces a hidden focus stop through the Tab walk', async () => {
      const finding = await firstFinding('tab/order.html', FOCUS_HIDDEN);

      expect(finding.target?.selector).toBe('#faint');
      expect(await reproduceOn('tab/order.html', { finding })).toMatchObject({
        reproduced: true,
        observed: finding.observed,
        skipped: null,
      });
      const shown = await reproduceOn(
        'tab/order.html',
        { finding },
        {
          prepare: (page) =>
            page.evaluate(() => {
              const faint = document.querySelector<HTMLElement>('#faint');
              if (faint !== null) faint.style.opacity = '1';
            }),
        },
      );
      expect(shown).toEqual({ reproduced: false, observed: null, skipped: null, evidence: [] });
    });
  });

  describe('the viewport sweep', () => {
    test("reproduces horizontal overflow at the finding's viewport only", async () => {
      const target = await firstOccurrence('viewports/overflow.html', OVERFLOW, {
        viewports: SWEPT_VIEWPORTS,
      });

      const reproduction = await reproduceOn('viewports/overflow.html', target, {
        viewports: SWEPT_VIEWPORTS,
      });

      expect(target.occurrence.viewport).toEqual(MOBILE);
      expect(reproduction).toMatchObject({
        reproduced: true,
        observed: target.finding.observed,
        skipped: null,
      });
      expect(reproduction.evidence.map(({ kind, label }) => [kind, label])).toEqual([
        ['screenshot', 'mobile 390×844'],
      ]);
    });

    test('sweepViewports with only measures that viewport alone, reloading at it when it is not the first', async () => {
      const swept = await onFreshPage(
        'viewports/overflow.html',
        { viewports: SWEPT_VIEWPORTS },
        async (context) => ({
          mobile: rulesAndKeys((await sweepViewports(context, { only: MOBILE.name })).findings),
          desktop: rulesAndKeys(
            (await sweepViewports(context, { only: DEFAULT_TEST_VIEWPORT.name })).findings,
          ),
          size: context.ipage.page.viewportSize(),
        }),
      );

      expect(swept.mobile).toEqual([
        [OVERFLOW, '/viewports/overflow.html|mobile'],
        [CLIPPED, '/viewports/overflow.html|mobile|clipped'],
      ]);
      expect(swept.desktop).toEqual([[CLIPPED, '/viewports/overflow.html|desktop|clipped']]);
      expect(swept.size).toEqual({
        width: DEFAULT_TEST_VIEWPORT.width,
        height: DEFAULT_TEST_VIEWPORT.height,
      });
    });
  });

  describe('a rule it does not report', () => {
    test('is refused', async () => {
      const finding = await firstFinding('states/ring.html', FOCUS_VISIBLE);
      const foreign: StepFinding = {
        ...finding,
        rule: { id: 'observers.console-error', source: 'catalogue' },
      };

      await expect(
        onFreshPage('states/ring.html', {}, (context) => lens.reproduce({ finding: foreign }, context)),
      ).rejects.toThrow('observers.console-error');
    });
  });
});
