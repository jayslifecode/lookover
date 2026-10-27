import { readFile } from 'node:fs/promises';
import { release } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  type Attempt,
  defaultObservers,
  type EvidenceItem,
  type InstrumentedPage,
  type Lens,
  LookoverError,
  navigate,
  type Observer,
  type OccurrenceFinding,
  PER_SCREEN_BUDGET_MS,
  type ReproductionTarget,
  type StepFinding,
  type Timing,
} from '@jayslifecode/lookover-core';
import { InteractionLens } from '@jayslifecode/lookover-lenses';
import type { FixtureRoute } from '@jayslifecode/lookover-test-support';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  batchesFor,
  Harness,
  type HarnessOptions,
  isReproduced,
  REPRODUCTION_ATTEMPTS,
  targetKey,
} from '../src/index.js';
import {
  type Inspected,
  inspectPage,
  occurrenceFindingOf,
  SCREEN_ID,
  stepFindingOf,
} from './helpers/inspect.js';
import { DEFAULT_TEST_VIEWPORT, openTestBed, type TestBed } from './helpers/session.js';

type Page = InstrumentedPage['page'];

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));
const BROWSER_TIMEOUT_MS = 120_000;
const LOOKOVER_VERSION = '0.0.0-test';
const TIMING: Timing = { settleMs: 500, navigationTimeoutMs: 15_000 };
const FOCUS_VISIBLE = 'interaction.focus-visible-missing';
const POSITIVE_TABINDEX = 'interaction.positive-tabindex';
const CONSOLE_ERROR = 'observers.console-error';
const PAGE_ERROR = 'observers.page-error';
/** The flaky and vanishing pages serve their first variant on one load in this many, the first included. */
const LOADS_PER_FIRST_VARIANT = 6;
/** How long the slow stub target takes to measure. */
const SLOW_TARGET_MS = 300;
/** How far behind its target's start a deadline may be computed: a few awaits, never a timer. */
const DEADLINE_SLACK_MS = 100;

/** Serves `first` on the route's loads 1, 1 + `period`, 1 + 2 × `period`, … and `otherwise` on the rest. */
function oncePer(period: number, first: string, otherwise: string): FixtureRoute {
  let loads = 0;
  return (_req, _res, serveStatic) => {
    const isFirstVariant = loads % period === 0;
    loads += 1;
    serveStatic(isFirstVariant ? first : otherwise);
  };
}

const ROUTES: Readonly<Record<string, FixtureRoute>> = {
  /** Logs its console error on the first load, and not on the five after it. */
  '/flaky.html': oncePer(LOADS_PER_FIRST_VARIANT, '/console.html', '/console-clean.html'),
  /** Has its controls on the first load; they are gone on the five after it. */
  '/vanishing.html': oncePer(LOADS_PER_FIRST_VARIANT, '/controls.html', '/console-clean.html'),
};

function occurrenceTargets(finding: OccurrenceFinding): ReproductionTarget[] {
  return finding.occurrences.map((occurrence) => ({ finding, occurrence }));
}

function attemptsOf(result: ReadonlyMap<string, Attempt[]>, target: ReproductionTarget): Attempt[] {
  const attempts = result.get(targetKey(target));
  if (attempts === undefined) throw new Error(`no attempts for ${targetKey(target)}`);
  return attempts;
}

function attempt(reproduced: boolean, index: number): Attempt {
  return { index, occurrence: null, reproduced, observed: null, skipped: null, durationMs: 1, evidence: [] };
}

describe('Harness', { timeout: BROWSER_TIMEOUT_MS }, () => {
  const lens = new InteractionLens();
  let bed: TestBed;
  let controls: Inspected;

  beforeAll(async () => {
    bed = await openTestBed(FIXTURE_DIR, ROUTES);
    controls = await inspected('/controls.html');
  }, BROWSER_TIMEOUT_MS);

  afterAll(() => bed.close(), BROWSER_TIMEOUT_MS);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function harnessWith(overrides: Partial<HarnessOptions> = {}): Harness {
    return new Harness({
      session: bed.session,
      ctx: bed.ctx,
      lenses: [lens],
      observers: () => defaultObservers(bed.ctx),
      viewports: [DEFAULT_TEST_VIEWPORT],
      interaction: 'full',
      lookoverVersion: LOOKOVER_VERSION,
      ...overrides,
    });
  }

  /** Captures `path` on a fresh page as the crawl does, and runs the observers and the lens on it. */
  function inspected(path: string): Promise<Inspected> {
    return inspectPage(bed, lens, path);
  }

  function openContexts(): number | undefined {
    return bed.session.context.browser()?.contexts().length;
  }

  async function readRecord(item: EvidenceItem | undefined): Promise<unknown> {
    if (item === undefined) throw new Error('no reproduction record');
    return JSON.parse(await readFile(bed.ctx.evidence.resolve(item.ref), 'utf8'));
  }

  test('reproduces a stable finding three times in three fresh contexts', async () => {
    const finding = stepFindingOf(controls, FOCUS_VISIBLE);
    const target = { finding };
    const opened = vi.spyOn(bed.session, 'newIsolatedPage');

    const attempts = attemptsOf(
      await harnessWith().reproduce(batchesFor(controls.screen, [finding])),
      target,
    );

    expect(finding.target?.selector).toBe('#none');
    expect(attempts.map((a) => a.reproduced)).toEqual([true, true, true]);
    expect(opened).toHaveBeenCalledTimes(REPRODUCTION_ATTEMPTS);
    expect(openContexts()).toBe(1);
    expect(attempts.map((a) => [a.index, a.occurrence, a.observed, a.skipped])).toEqual(
      [1, 2, 3].map((index) => [index, null, finding.observed, null]),
    );
    expect(attempts[0]?.evidence[0]?.label).toBe('reproduction 1');
    expect(attempts[2]?.evidence[0]).toMatchObject({ kind: 'measurements', label: 'reproduction 3' });
    const record = await readRecord(attempts[0]?.evidence[0]);
    expect(record).toMatchObject({
      attempt: 1,
      target: finding.id,
      url: finding.trace.url,
      reproduction: { reproduced: true, observed: finding.observed, skipped: null },
      environment: { lookover: LOOKOVER_VERSION, viewport: DEFAULT_TEST_VIEWPORT },
    });
    expect(record).toHaveProperty('reproduction.evidence', attempts[0]?.evidence.slice(1));
    expect(attempts[0]?.evidence.length).toBeGreaterThan(1);
  });

  test('a page that only fails on its first load is not reproduced', async () => {
    const flaky = await inspected('/flaky.html');
    const finding = occurrenceFindingOf(flaky, CONSOLE_ERROR);
    const [target] = occurrenceTargets(finding);
    if (target === undefined) throw new Error('no occurrence');

    const attempts = attemptsOf(await harnessWith().reproduce(batchesFor(flaky.screen, [finding])), target);

    expect(attempts.map((a) => [a.reproduced, a.observed, a.skipped])).toEqual([
      [false, null, null],
      [false, null, null],
      [false, null, null],
    ]);
    expect(isReproduced(attempts, REPRODUCTION_ATTEMPTS)).toBe(false);
  });

  test('a finding whose element is gone is skipped, not reproduced', async () => {
    const vanishing = await inspected('/vanishing.html');
    const finding = stepFindingOf(vanishing, FOCUS_VISIBLE);

    const result = await harnessWith().reproduce(batchesFor(vanishing.screen, [finding]));

    expect(attemptsOf(result, { finding }).map((a) => [a.reproduced, a.observed, a.skipped])).toEqual([
      [false, null, 'gone'],
      [false, null, 'gone'],
      [false, null, 'gone'],
    ]);
  });

  test('an occurrence finding is measured once per occurrence per attempt', async () => {
    const finding = occurrenceFindingOf(controls, POSITIVE_TABINDEX);
    const targets = occurrenceTargets(finding);
    const opened = vi.spyOn(bed.session, 'newIsolatedPage');
    const measured = vi.spyOn(lens, 'reproduce');

    const result = await harnessWith().reproduce(batchesFor(controls.screen, [finding]));

    expect(finding.occurrences.map((o) => o.selector)).toEqual(['#pos-two', '#pos-one']);
    expect(opened).toHaveBeenCalledTimes(REPRODUCTION_ATTEMPTS);
    expect(measured).toHaveBeenCalledTimes(targets.length * REPRODUCTION_ATTEMPTS);
    expect([...result.keys()]).toEqual([
      `${finding.id}|${SCREEN_ID}|#pos-two|desktop`,
      `${finding.id}|${SCREEN_ID}|#pos-one|desktop`,
    ]);
    for (const target of targets) {
      const selector = 'occurrence' in target ? target.occurrence.selector : null;
      expect(attemptsOf(result, target).map((a) => [a.index, a.occurrence, a.reproduced])).toEqual(
        [1, 2, 3].map((index) => [index, { screenId: SCREEN_ID, selector, viewport: 'desktop' }, true]),
      );
    }
  });

  test('an attempt that throws is recorded and the others still run', async () => {
    const finding = stepFindingOf(controls, FOCUS_VISIBLE);
    let loads = 0;
    const failingOnce = async (page: Page, url: string): Promise<unknown> => {
      loads += 1;
      if (loads === 2) throw new Error('Target page crashed\nCall log:\n  - navigating');
      return navigate(page, url, TIMING);
    };

    const result = await harnessWith({ navigate: failingOnce }).reproduce(
      batchesFor(controls.screen, [finding]),
    );

    const attempts = attemptsOf(result, { finding });
    expect(attempts.map((a) => [a.index, a.reproduced, a.skipped])).toEqual([
      [1, true, null],
      [2, false, 'error:Target page crashed'],
      [3, true, null],
    ]);
    expect(attempts[1]?.observed).toBeNull();
    expect(attempts[1]?.evidence.map(({ kind, label }) => [kind, label])).toEqual([
      ['measurements', 'reproduction 2'],
    ]);
    expect(openContexts()).toBe(1);
  });

  test('a target whose measurement throws fails alone, and the other targets are still measured', async () => {
    const ring = stepFindingOf(controls, FOCUS_VISIBLE);
    const tabindex = occurrenceFindingOf(controls, POSITIVE_TABINDEX);
    const throwing: Lens = {
      name: lens.name,
      rules: lens.rules,
      inspect: (context) => lens.inspect(context),
      reproduce: (target, context) => {
        if (target.finding.rule.id === POSITIVE_TABINDEX) {
          throw new Error('measure failed\n    at measureStatic');
        }
        return lens.reproduce(target, context);
      },
    };

    const result = await harnessWith({ lenses: [throwing], attempts: 1 }).reproduce(
      batchesFor(controls.screen, [tabindex, ring]),
    );

    expect([...result.values()].map((attempts) => attempts.map((a) => [a.reproduced, a.skipped]))).toEqual([
      [[false, 'error:measure failed']],
      [[false, 'error:measure failed']],
      [[true, null]],
    ]);
  });

  test('a LookoverError ends the reproduction and its context is closed', async () => {
    const finding = stepFindingOf(controls, FOCUS_VISIBLE);
    const batch = batchesFor(controls.screen, [finding]);
    const blocked = async (): Promise<unknown> => {
      throw new LookoverError('E_NAVIGATION_BLOCKED', 'The navigation left the allowed hosts');
    };
    const failing: Lens = {
      name: lens.name,
      rules: lens.rules,
      inspect: (context) => lens.inspect(context),
      reproduce: () => Promise.reject(new LookoverError('E_RUN_FAILED', 'The page crashed')),
    };

    await expect(harnessWith({ navigate: blocked }).reproduce(batch)).rejects.toThrow(LookoverError);
    await expect(harnessWith({ lenses: [failing] }).reproduce(batch)).rejects.toThrow('The page crashed');
    expect(openContexts()).toBe(1);
  });

  /** Every attempt's page closes its context, then rejects as a browser that went away would. */
  function pagesFailingToClose(): void {
    const open = bed.session.newIsolatedPage.bind(bed.session);
    vi.spyOn(bed.session, 'newIsolatedPage').mockImplementation(async (viewport) => {
      const ipage = await open(viewport);
      return {
        ...ipage,
        close: async () => {
          await ipage.close();
          throw new Error('Target page, context or browser has been closed');
        },
      };
    });
  }

  test('a LookoverError from a measurement wins over the page then failing to close', async () => {
    const finding = stepFindingOf(controls, FOCUS_VISIBLE);
    const blocked = new LookoverError('E_NAVIGATION_BLOCKED', 'The lens left the allowed hosts');
    const blocking: Lens = {
      name: lens.name,
      rules: lens.rules,
      inspect: (context) => lens.inspect(context),
      reproduce: () => Promise.reject(blocked),
    };
    pagesFailingToClose();

    const reproducing = harnessWith({ lenses: [blocking] }).reproduce(batchesFor(controls.screen, [finding]));

    await expect(reproducing).rejects.toBe(blocked);
    expect(openContexts()).toBe(1);
  });

  test('a page that fails to close fails its attempt when nothing else went wrong', async () => {
    const finding = stepFindingOf(controls, FOCUS_VISIBLE);
    pagesFailingToClose();

    const result = await harnessWith({ attempts: 1 }).reproduce(batchesFor(controls.screen, [finding]));

    expect(attemptsOf(result, { finding }).map((a) => [a.reproduced, a.skipped])).toEqual([
      [false, 'error:Target page, context or browser has been closed'],
    ]);
  });

  test('each target is handed a deadline of its own, from when its measurement starts', async () => {
    const ring = stepFindingOf(controls, FOCUS_VISIBLE);
    const tabindex = occurrenceFindingOf(controls, POSITIVE_TABINDEX);
    const [occurrence] = tabindex.occurrences;
    if (occurrence === undefined) throw new Error('no occurrence');
    let entered: { deadline: number; at: number }[] = [];
    const slowFirst: Lens = {
      name: lens.name,
      rules: lens.rules,
      inspect: (context) => lens.inspect(context),
      reproduce: async (_target, context) => {
        entered = [...entered, { deadline: context.deadline, at: performance.now() }];
        if (entered.length === 1) await delay(SLOW_TARGET_MS);
        return { reproduced: true, observed: 'stub', skipped: null, evidence: [] };
      },
    };
    const targets: ReproductionTarget[] = [{ finding: tabindex, occurrence }, { finding: ring }];

    await harnessWith({ lenses: [slowFirst], attempts: 1 }).reproduce({ screen: controls.screen, targets });

    const [first, second] = entered;
    if (first === undefined || second === undefined) throw new Error('expected two measured targets');
    expect(second.deadline - first.deadline).toBeGreaterThanOrEqual(SLOW_TARGET_MS);
    for (const { deadline, at } of entered) {
      expect(deadline - at).toBeLessThanOrEqual(PER_SCREEN_BUDGET_MS);
      expect(deadline - at).toBeGreaterThan(PER_SCREEN_BUDGET_MS - DEADLINE_SLACK_MS);
    }
  });

  test('measures observer findings first, each observer collected once, then lens targets in rule order', async () => {
    const tabindex = occurrenceFindingOf(controls, POSITIVE_TABINDEX);
    const ring = stepFindingOf(controls, FOCUS_VISIBLE);
    const consoleError = occurrenceFindingOf(controls, CONSOLE_ERROR);
    const pageError = occurrenceFindingOf(controls, PAGE_ERROR);
    let measured: string[] = [];
    const recording: Lens = {
      name: lens.name,
      rules: lens.rules,
      inspect: (context) => lens.inspect(context),
      reproduce: (target, context) => {
        measured = [...measured, target.finding.rule.id];
        return lens.reproduce(target, context);
      },
    };
    const observers = (): Observer[] =>
      defaultObservers(bed.ctx).map((observer) => ({
        name: observer.name,
        attach: (ipage) => observer.attach(ipage),
        collect: (screen) => {
          measured = [...measured, `collect ${observer.name}`];
          return observer.collect(screen);
        },
      }));
    const batch = batchesFor(controls.screen, [tabindex, ring, consoleError, pageError]);

    const result = await harnessWith({ lenses: [recording], observers, attempts: 1 }).reproduce(batch);

    expect(measured).toEqual([
      'collect console',
      'collect requests',
      'collect text',
      FOCUS_VISIBLE,
      POSITIVE_TABINDEX,
      POSITIVE_TABINDEX,
    ]);
    expect([...result.keys()]).toEqual(batch.targets.map(targetKey));
    expect([...result.values()].map((attempts) => attempts.map((a) => a.reproduced))).toEqual([
      [true],
      [true],
      [true],
      [true],
      [true],
    ]);
  });

  test('batchesFor takes the step findings of the screen and the occurrences on it', () => {
    const ring = stepFindingOf(controls, FOCUS_VISIBLE);
    const tabindex = occurrenceFindingOf(controls, POSITIVE_TABINDEX);
    const [here, there] = tabindex.occurrences;
    if (here === undefined || there === undefined) throw new Error('expected two occurrences');
    const elsewhere = { ...there, screenId: 'screen-2' };
    const spread: OccurrenceFinding = { ...tabindex, occurrences: [here, elsewhere] };
    const otherScreen: StepFinding = { ...ring, screenId: 'screen-2' };

    const batch = batchesFor(controls.screen, [otherScreen, spread, ring]);

    expect(batch.screen).toBe(controls.screen);
    expect(batch.targets).toEqual([{ finding: spread, occurrence: here }, { finding: ring }]);
    expect(targetKey({ finding: ring })).toBe(ring.id);
  });

  test('environment names the browser, the OS, Node, Lookover and the viewport', () => {
    expect(harnessWith().environment(DEFAULT_TEST_VIEWPORT)).toEqual({
      browser: expect.stringMatching(/^chromium \d/),
      os: `${process.platform} ${release()} ${process.arch}`,
      node: process.version,
      lookover: LOOKOVER_VERSION,
      viewport: DEFAULT_TEST_VIEWPORT,
    });
  });
});

test('isReproduced needs every attempt', () => {
  const [ok, alsoOk, bad] = [attempt(true, 1), attempt(true, 2), attempt(false, 3)];

  expect(isReproduced([ok, alsoOk, attempt(true, 3)], REPRODUCTION_ATTEMPTS)).toBe(true);
  expect(isReproduced([ok, alsoOk, bad], REPRODUCTION_ATTEMPTS)).toBe(false);
  expect(isReproduced([ok, alsoOk], REPRODUCTION_ATTEMPTS)).toBe(false);
});
