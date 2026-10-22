import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FixtureServer, serveFixture } from '@jayslifecode/lookover-test-support';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import { configSchema } from '../src/config/schema.js';
import type { Finding, Occurrence, OccurrenceFinding } from '../src/findings/types.js';
import { navigate, type Timing } from '../src/map/navigation.js';
import type { Screen, Viewport } from '../src/map/types.js';
import { defaultObservers } from '../src/observers/index.js';
import { reproduceObservation } from '../src/observers/reproduce.js';
import type { Observer } from '../src/observers/types.js';
import { createRun, type RunContext } from '../src/run/run-context.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/observers', import.meta.url));
const BROWSER_TIMEOUT_MS = 30_000;
const VIEWPORT: Viewport = { name: 'desktop', width: 1280, height: 800 };
const TIMING: Timing = { settleMs: 500, navigationTimeoutMs: 15_000 };
const CONSOLE_ERROR = 'observers.console-error';
const SCREEN_ID = 'screen-1';

interface ObservationTarget {
  finding: OccurrenceFinding;
  occurrence: Occurrence;
}

describe('reproduceObservation', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let session: BrowserSession;
  let workDir: string;
  let ctx: RunContext;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lookover-observers-reproduce-'));
    fixture = await serveFixture(FIXTURE_DIR);
    session = await BrowserSession.launch({ viewport: VIEWPORT, allowHosts: [], onEvent: () => {} });
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await session.close();
    await fixture.close();
    await rm(workDir, { recursive: true, force: true });
  }, BROWSER_TIMEOUT_MS);

  beforeEach(async () => {
    const cwd = await mkdtemp(join(workDir, 'run-'));
    ctx = await createRun({ cwd, config: configSchema.parse({ baseUrl: fixture.url, interaction: 'safe' }) });
  });

  function screenAt(path: string): Screen {
    return {
      id: SCREEN_ID,
      url: `${fixture.url}${path}`,
      route: path,
      title: 'Fixture',
      status: 'captured',
      error: null,
      viewport: VIEWPORT,
      screenshot: null,
      elements: [],
      forms: [],
      tokens: [],
      links: [],
      redirectedFrom: null,
      discoveredFrom: null,
      capturedAt: '2026-10-22T12:00:00.000Z',
    };
  }

  /**
   * Opens a fresh isolated page, attaches the default observers to it before it navigates, loads `path`
   * and hands the observers and the screen to `use`.
   */
  async function onFreshPage<T>(
    path: string,
    use: (observers: readonly Observer[], screen: Screen) => Promise<T>,
  ): Promise<T> {
    const ipage = await session.newIsolatedPage(VIEWPORT);
    try {
      const observers = defaultObservers(ctx);
      for (const observer of observers) observer.attach(ipage);
      const failure = await navigate(ipage.page, `${fixture.url}${path}`, TIMING);
      if (failure !== null) throw new Error(`could not load ${path}: ${failure}`);
      return await use(observers, screenAt(path));
    } finally {
      await ipage.close();
    }
  }

  /** The console error the observers report on `path`, as the crawl saw it, with its occurrence. */
  function consoleErrorOn(path: string): Promise<ObservationTarget> {
    return onFreshPage(path, async (observers, screen) => {
      let found: Finding[] = [];
      for (const observer of observers) found = [...found, ...(await observer.collect(screen)).findings];
      const finding = found.find((candidate) => candidate.rule.id === CONSOLE_ERROR);
      const [occurrence] = finding?.shape === 'occurrence' ? finding.occurrences : [];
      if (finding?.shape !== 'occurrence' || occurrence === undefined) {
        throw new Error(`no ${CONSOLE_ERROR} on ${path}`);
      }
      return { finding, occurrence };
    });
  }

  test('a console error reproduces on its screen', async () => {
    const target = await consoleErrorOn('/console.html');

    const reproduction = await onFreshPage('/console.html', (observers, screen) =>
      reproduceObservation(target, observers, screen),
    );

    expect(reproduction).toMatchObject({
      reproduced: true,
      observed: target.finding.observed,
      skipped: null,
    });
    expect(reproduction.evidence.map(({ kind }) => kind)).toEqual(['console']);
  });

  test('a console error does not reproduce on a clean page', async () => {
    const target = await consoleErrorOn('/console.html');

    const reproduction = await onFreshPage('/console-clean.html', (observers, screen) =>
      reproduceObservation(target, observers, screen),
    );

    expect(reproduction).toEqual({ reproduced: false, observed: null, skipped: null, evidence: [] });
  });
});
