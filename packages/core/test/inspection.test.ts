import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { type FixtureServer, serveFixture } from '@jayslifecode/lookover-test-support';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BrowserSession, type InstrumentedPage } from '../src/browser/session.js';
import { configSchema } from '../src/config/schema.js';
import { LookoverError } from '../src/errors.js';
import type { Lens, LensContext, LensResult, Reproduction } from '../src/findings/lens.js';
import type { Finding } from '../src/findings/types.js';
import { crawl } from '../src/map/crawler.js';
import type { Screen, Viewport } from '../src/map/types.js';
import type { Observer, ObserverResult } from '../src/observers/types.js';
import type { RunEvent } from '../src/run/events.js';
import { Inspection, PER_SCREEN_BUDGET_MS } from '../src/run/inspection.js';
import { createRun, type RunContext } from '../src/run/run-context.js';
import { RunLog } from '../src/run/run-log.js';
import { occurrence, occurrenceFinding, stepFinding } from './fixtures/findings.js';

const SITE_DIR = fileURLToPath(new URL('./fixtures/site', import.meta.url));
const BROWSER_TIMEOUT_MS = 30_000;
const VIEWPORTS: Viewport[] = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
];
const [CAPTURE_VIEWPORT, OTHER_VIEWPORT] = VIEWPORTS as [Viewport, Viewport];
const CAPTURE_SIZE = { width: CAPTURE_VIEWPORT.width, height: CAPTURE_VIEWPORT.height };
/** Generous: the pipeline sets a deadline microseconds before the lens reads the clock. */
const CLOCK_TOLERANCE_MS = 100;
const LENS_SLEEP_MS = 300;

const NOTHING_FOUND: LensResult = { findings: [], worthALook: [], gallery: null, skipped: [] };
const NOT_REPRODUCED: Reproduction = { reproduced: false, observed: null, skipped: null, evidence: [] };
const NOTHING_OBSERVED: ObserverResult = { findings: [], worthALook: [], evidence: [] };

function eventsOf<T extends RunEvent['type']>(
  events: readonly RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

function fakeLens(inspect: (context: LensContext) => Promise<LensResult>): Lens {
  return { name: 'interaction', rules: [], inspect, reproduce: async () => NOT_REPRODUCED };
}

function fakeObserver(
  collect: (screen: Screen) => Promise<ObserverResult>,
  attach: (ipage: InstrumentedPage) => void = () => undefined,
): Observer {
  return { name: 'fake', attach, collect };
}

/** An occurrence finding seen on `screen`, with the same `id` on every screen, like a repeated error. */
function repeatedError(screen: Screen, id = 'console-error-1'): Finding {
  return occurrenceFinding({
    id,
    occurrences: [occurrence(screen.id, null, { route: screen.route, url: screen.url })],
  });
}

function repeatedWarning(screen: Screen): Finding {
  return occurrenceFinding({
    id: 'console-warning-1',
    rule: { id: 'observers.console-warning', source: 'catalogue' },
    severity: 'low',
    occurrences: [occurrence(screen.id, null, { route: screen.route, url: screen.url })],
  });
}

describe('Inspection', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let session: BrowserSession;
  let workDir: string;

  const url = (path: string): string => `${fixture.url}${path}`;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lookover-inspection-'));
    fixture = await serveFixture(SITE_DIR);
    session = await BrowserSession.launch({ viewport: CAPTURE_VIEWPORT, allowHosts: [], onEvent: () => {} });
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await session.close();
    await fixture.close();
    await rm(workDir, { recursive: true, force: true });
  }, BROWSER_TIMEOUT_MS);

  async function newRun(): Promise<RunContext> {
    const cwd = await mkdtemp(join(workDir, 'run-'));
    return createRun({
      cwd,
      config: configSchema.parse({ baseUrl: fixture.url, interaction: 'safe', viewports: VIEWPORTS }),
    });
  }

  /** Crawls the site from `/` with the inspection's hooks, as the engine wires them. */
  async function startInspection(
    parts: { lenses?: readonly Lens[]; observers?: readonly Observer[] },
    maxScreens: number,
  ): Promise<{ ctx: RunContext; inspection: Inspection; crawling: Promise<Screen[]> }> {
    const ctx = await newRun();
    const inspection = new Inspection(ctx, {
      lenses: parts.lenses ?? [],
      observers: parts.observers ?? [],
      viewports: ctx.config.viewports,
      interaction: ctx.config.interaction,
    });
    const crawling = crawl(session, ctx, {
      baseUrl: fixture.url,
      seeds: ['/'],
      routes: [],
      maxScreens,
      maxPerRoute: 2,
      viewport: CAPTURE_VIEWPORT,
      onPage: (ipage) => inspection.attach(ipage),
      inspect: (screen, ipage) => inspection.inspect(screen, ipage),
    });
    return { ctx, inspection, crawling };
  }

  async function inspectSite(
    parts: { lenses?: readonly Lens[]; observers?: readonly Observer[] },
    maxScreens = 2,
  ): Promise<{ ctx: RunContext; inspection: Inspection; screens: Screen[]; events: RunEvent[] }> {
    const { ctx, inspection, crawling } = await startInspection(parts, maxScreens);
    const screens = await crawling;
    return { ctx, inspection, screens, events: await RunLog.read(ctx.log.file) };
  }

  test('runs observers before lenses and restores the first viewport after a lens that resized it', async () => {
    const order: string[] = [];
    const sizes: unknown[] = [];
    const observer = fakeObserver(
      async (screen) => {
        order.push(`observe ${screen.url}`);
        return NOTHING_OBSERVED;
      },
      (ipage) => order.push(`attach ${ipage.page.url()}`),
    );
    const resizing = fakeLens(async ({ screen, ipage }) => {
      order.push(`resize ${screen.url}`);
      await ipage.page.setViewportSize({ width: OTHER_VIEWPORT.width, height: OTHER_VIEWPORT.height });
      return NOTHING_FOUND;
    });
    const measuring = fakeLens(async ({ screen, ipage }) => {
      order.push(`measure ${screen.url}`);
      sizes.push(ipage.page.viewportSize());
      return NOTHING_FOUND;
    });

    const { screens } = await inspectSite({ observers: [observer], lenses: [resizing, measuring] });

    expect(screens.map((screen) => screen.url)).toEqual([url('/'), url('/orgs.html')]);
    expect(order).toEqual([
      'attach about:blank',
      `observe ${url('/')}`,
      `resize ${url('/')}`,
      `measure ${url('/')}`,
      `observe ${url('/orgs.html')}`,
      `resize ${url('/orgs.html')}`,
      `measure ${url('/orgs.html')}`,
    ]);
    expect(sizes).toEqual([CAPTURE_SIZE, CAPTURE_SIZE]);
  });

  test('emits finding.candidate once per id across screens and merges occurrences', async () => {
    const observer = fakeObserver(async (screen) => ({
      findings: [repeatedError(screen)],
      worthALook: [repeatedWarning(screen)],
      evidence: [],
    }));

    const { ctx, inspection, screens, events } = await inspectSite({ observers: [observer] });

    const screenIds = screens.map((screen) => screen.id);
    const candidates = eventsOf(events, 'finding.candidate');
    expect(candidates.map((event) => event.finding.id)).toEqual(['console-error-1']);
    // The event carries the finding as it stood when first seen, on the first screen.
    const [first] = candidates;
    expect(first?.finding.shape === 'occurrence' && first.finding.occurrences.length).toBe(1);
    expect(eventsOf(events, 'screen.inspected')).toEqual(
      screenIds.map((screenId) =>
        expect.objectContaining({ screenId, candidates: 1, worthALook: 1, skipped: [], error: null }),
      ),
    );

    const file = inspection.file();
    expect(file).toMatchObject({
      version: 2,
      runId: ctx.runId,
      rejected: [],
      intended: [],
      judge: null,
      environment: null,
    });
    expect(Number.isNaN(Date.parse(file.createdAt))).toBe(false);
    for (const [list, id] of [
      [file.findings, 'console-error-1'],
      [file.worthALook, 'console-warning-1'],
    ] as const) {
      expect(list.map((finding) => finding.id)).toEqual([id]);
      const [merged] = list;
      expect(merged?.shape === 'occurrence' && merged.occurrences.map((seen) => seen.screenId)).toEqual(
        screenIds,
      );
    }
  });

  test('a lens that throws a plain Error fails only that screen: screen.inspected.error is set and the next screen is inspected', async () => {
    const sizes: unknown[] = [];
    let crawlPage: InstrumentedPage | undefined;
    let index = 0;
    const observer = fakeObserver(
      async (screen) => {
        sizes.push(crawlPage?.page.viewportSize());
        return { ...NOTHING_OBSERVED, findings: [repeatedError(screen)] };
      },
      (ipage) => {
        crawlPage = ipage;
      },
    );
    const failingFirst = fakeLens(async ({ screen, ipage }) => {
      index += 1;
      if (index === 1) {
        await ipage.page.setViewportSize({ width: OTHER_VIEWPORT.width, height: OTHER_VIEWPORT.height });
        throw new Error('could not measure the page\n  Call log: waiting for locator');
      }
      return {
        ...NOTHING_FOUND,
        findings: [stepFinding({ id: `step-${screen.id}`, screenId: screen.id })],
        skipped: [{ reason: 'time-budget', count: 2 }],
      };
    });

    const { inspection, screens, events } = await inspectSite({
      observers: [observer],
      lenses: [failingFirst],
    });

    expect(screens.map((screen) => screen.url)).toEqual([url('/'), url('/orgs.html')]);
    const [failed, next] = screens.map((screen) => screen.id);
    // What the observers yielded before the lens threw is kept.
    expect(eventsOf(events, 'screen.inspected')).toEqual([
      expect.objectContaining({
        screenId: failed,
        candidates: 1,
        skipped: [],
        error: 'could not measure the page',
      }),
      expect.objectContaining({
        screenId: next,
        candidates: 2,
        skipped: [{ reason: 'time-budget', count: 2 }],
        error: null,
      }),
    ]);
    expect(sizes).toEqual([CAPTURE_SIZE, CAPTURE_SIZE]);
    expect(inspection.file().findings.map((finding) => finding.id)).toEqual([
      'console-error-1',
      `step-${next}`,
    ]);
  });

  test('tallies what the lenses skipped on every screen into the file, most first, then by reason', async () => {
    let index = 0;
    const skipping = fakeLens(async () => {
      index += 1;
      const skipped =
        index === 1
          ? [
              { reason: 'time-budget', count: 1 },
              { reason: 'gone', count: 2 },
            ]
          : [
              { reason: 'gone', count: 1 },
              { reason: 'disabled', count: 3 },
            ];
      return { ...NOTHING_FOUND, skipped };
    });

    const { inspection } = await inspectSite({ lenses: [skipping] });

    expect(index).toBe(2);
    expect(inspection.file().skipped).toEqual([
      { reason: 'disabled', count: 3 },
      { reason: 'gone', count: 3 },
      { reason: 'time-budget', count: 1 },
    ]);
  });

  test('writes an empty tally when nothing was skipped', async () => {
    const { inspection } = await inspectSite({ lenses: [fakeLens(async () => NOTHING_FOUND)] });

    expect(inspection.file().skipped).toEqual([]);
  });

  test.each(['lens', 'observer'] as const)(
    'a %s that throws a LookoverError fails the crawl',
    async (part) => {
      const injected = new LookoverError('E_RUN_FAILED', `the ${part} lost the browser`);
      const parts =
        part === 'lens'
          ? { lenses: [fakeLens(() => Promise.reject(injected))] }
          : { observers: [fakeObserver(() => Promise.reject(injected))] };

      const { ctx, crawling } = await startInspection(parts, 2);

      await expect(crawling).rejects.toBe(injected);
      const events = await RunLog.read(ctx.log.file);
      expect(eventsOf(events, 'screen.captured')).toHaveLength(1);
      expect(eventsOf(events, 'screen.inspected')).toEqual([]);
    },
  );

  test('hands lenses a deadline about PER_SCREEN_BUDGET_MS ahead and the config viewports', async () => {
    const seen: { context: LensContext; now: number }[] = [];
    const sleeping = fakeLens(async (context) => {
      seen.push({ context, now: performance.now() });
      await delay(LENS_SLEEP_MS);
      return NOTHING_FOUND;
    });
    const next = fakeLens(async (context) => {
      seen.push({ context, now: performance.now() });
      return NOTHING_FOUND;
    });

    const { ctx, screens } = await inspectSite({ lenses: [sleeping, next] }, 1);

    const [screen] = screens;
    expect(seen).toHaveLength(2);
    for (const { context, now } of seen) {
      expect(context.ctx).toBe(ctx);
      expect(context.screen).toEqual(screen);
      expect(context.viewports).toEqual(VIEWPORTS);
      expect(context.interaction).toBe('safe');
      expect(context.deadline - now).toBeGreaterThan(PER_SCREEN_BUDGET_MS - CLOCK_TOLERANCE_MS);
      expect(context.deadline - now).toBeLessThanOrEqual(PER_SCREEN_BUDGET_MS);
    }
    // Each lens has its own budget: the one after a slow lens is not short-changed.
    const [slow, after] = seen;
    expect((after?.context.deadline ?? 0) - (slow?.context.deadline ?? 0)).toBeGreaterThanOrEqual(
      LENS_SLEEP_MS,
    );
    expect(PER_SCREEN_BUDGET_MS).toBe(10_000);
  });
});
