import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Attempt,
  BrowserSession,
  configSchema,
  type LookoverConfig,
  type StepFinding,
} from '@jayslifecode/lookover-core';
import { InteractionLens } from '@jayslifecode/lookover-lenses';
import {
  type FixtureRoute,
  hasSessionCookie,
  LOGIN_PATH,
  redirect,
  SESSION_COOKIE,
} from '@jayslifecode/lookover-test-support';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  attemptLines,
  isFullyReproduced,
  type ReplayOptions,
  replayScreens,
  replaySummary,
  runReplay,
} from '../src/index.js';
import { VIEWPORT } from './helpers/bundle-fixtures.js';
import { type Inspected, inspectPage, occurrenceFindingOf, stepFindingOf } from './helpers/inspect.js';
import { errorOn, focusOn, screenAt } from './helpers/pipeline-bed.js';
import { DEFAULT_TEST_VIEWPORT, openTestBed, type TestBed } from './helpers/session.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));
const BROWSER_TIMEOUT_MS = 120_000;
const LOOKOVER_VERSION = '0.0.0-replay';
const FOCUS_VISIBLE = 'interaction.focus-visible-missing';
const POSITIVE_TABINDEX = 'interaction.positive-tabindex';
const CONTRAST_FAIL = 'interaction.text-contrast-fail';
const LEAKED_EMAIL = 'jay@example.com';
const STATE_FILE = 'state.json';
/** What a `full` config needs before anything acts on the app: the user's word that its data is disposable. */
const ACKNOWLEDGEMENT = { disposableData: true, acknowledgedAt: '2026-10-22T09:00:00.000Z' };
/** A host the network envelope does not allow unless `allowHosts` lists it. */
const OFF_ENVELOPE_URL = 'http://app.example.test:3000';
/** A cookie the browser keeps until it closes. */
const SESSION_LIFETIME = -1;

/** Serves `first` on the route's first load and `otherwise` on every load after it. */
function firstLoadOnly(first: string, otherwise: string): FixtureRoute {
  let loads = 0;
  return (_req, _res, serveStatic) => {
    loads += 1;
    serveStatic(loads === 1 ? first : otherwise);
  };
}

const ROUTES: Readonly<Record<string, FixtureRoute>> = {
  /** Has its controls on the first load (the inspection's); they are gone on every replay. */
  '/vanishing.html': firstLoadOnly('/controls.html', '/console-clean.html'),
  /** A pale button that quotes an email address: the contrast finding's `observed` quotes its text. */
  '/leaky.html': (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html lang="en"><title>Leaky</title><body style="background:#fff">' +
        '<button type="button" id="pale" style="color:#c8c8c8;background:#fff;border:1px solid #6b7280;' +
        `padding:8px 16px;font:16px sans-serif">Write to ${LEAKED_EMAIL}</button></body></html>`,
    );
  },
  /** The controls behind the session cookie; without it, a redirect to the login page (not served). */
  '/locked.html': (req, res, serveStatic) => {
    if (hasSessionCookie(req)) {
      serveStatic('/controls.html');
      return;
    }
    redirect(res, LOGIN_PATH);
  },
};

/** A Playwright storage state holding the fixture server's session cookie for `host`. */
function storageStateFor(host: string): string {
  return JSON.stringify({
    cookies: [
      {
        ...SESSION_COOKIE,
        domain: host,
        path: '/',
        expires: SESSION_LIFETIME,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  });
}

function attempt(overrides: Partial<Attempt>): Attempt {
  return {
    index: 1,
    occurrence: null,
    reproduced: true,
    observed: 'shows no change when it receives keyboard focus',
    skipped: null,
    durationMs: 800,
    evidence: [],
    ...overrides,
  };
}

describe('runReplay', { timeout: BROWSER_TIMEOUT_MS }, () => {
  const lens = new InteractionLens();
  let bed: TestBed;
  let controls: Inspected;
  let vanishing: Inspected;
  let cwd: string;

  beforeAll(async () => {
    bed = await openTestBed(FIXTURE_DIR, ROUTES);
    controls = await inspectPage(bed, lens, '/controls.html');
    vanishing = await inspectPage(bed, lens, '/vanishing.html');
  }, BROWSER_TIMEOUT_MS);

  afterAll(() => bed.close(), BROWSER_TIMEOUT_MS);

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'lookover-replay-project-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(cwd, { recursive: true, force: true });
  });

  function configWith(overrides: Record<string, unknown> = {}): LookoverConfig {
    return configSchema.parse({
      baseUrl: bed.url,
      interaction: 'full',
      acknowledgement: ACKNOWLEDGEMENT,
      ...overrides,
    });
  }

  function replay(overrides: Partial<ReplayOptions> & Pick<ReplayOptions, 'finding'>) {
    return runReplay({
      cwd,
      config: configWith(),
      lenses: [lens],
      lookoverVersion: LOOKOVER_VERSION,
      headless: true,
      ...overrides,
    });
  }

  test('reproduces a step finding once by default, in a session of its own', async () => {
    const finding = stepFindingOf(controls, FOCUS_VISIBLE);

    const result = await replay({ finding });

    expect(result).toMatchObject({ reproduced: 1, of: 1 });
    expect(result.attempts.map((a) => [a.index, a.reproduced, a.observed, a.skipped])).toEqual([
      [1, true, finding.observed, null],
    ]);
    expect(result.environment).toMatchObject({
      browser: expect.stringMatching(/^chromium \d/),
      lookover: LOOKOVER_VERSION,
      viewport: DEFAULT_TEST_VIEWPORT,
    });
    expect(isFullyReproduced(result)).toBe(true);
  });

  test('reproduces it three times in three fresh contexts with times: 3', async () => {
    const finding = stepFindingOf(controls, FOCUS_VISIBLE);

    const result = await replay({ finding, times: 3 });

    expect(result).toMatchObject({ reproduced: 3, of: 3 });
    expect(result.attempts.map((a) => [a.index, a.reproduced])).toEqual([
      [1, true],
      [2, true],
      [3, true],
    ]);
  });

  test('a finding whose element is gone gives 0/1, skipped as gone', async () => {
    const finding = stepFindingOf(vanishing, FOCUS_VISIBLE);

    const result = await replay({ finding });

    expect(result).toMatchObject({ reproduced: 0, of: 1 });
    expect(result.attempts.map((a) => [a.reproduced, a.observed, a.skipped])).toEqual([
      [false, null, 'gone'],
    ]);
    expect(isFullyReproduced(result)).toBe(false);
  });

  test('replays an occurrence finding at each of its occurrences and sums the attempts', async () => {
    const finding = occurrenceFindingOf(controls, POSITIVE_TABINDEX);

    const result = await replay({ finding });

    expect(finding.occurrences).toHaveLength(2);
    expect(result).toMatchObject({ reproduced: 2, of: 2 });
    expect(result.attempts.map((a) => a.occurrence?.selector)).toEqual(['#pos-two', '#pos-one']);
  });

  test("logs in with the config's storage state, resolved against cwd", async () => {
    const found = stepFindingOf(controls, FOCUS_VISIBLE);
    const finding: StepFinding = { ...found, trace: { ...found.trace, url: `${bed.url}/locked.html` } };
    await writeFile(join(cwd, STATE_FILE), storageStateFor(new URL(bed.url).hostname));
    const auth = { type: 'storageState', path: STATE_FILE };

    const signedOut = await replay({ finding });
    const signedIn = await replay({ finding, config: configWith({ auth }) });

    expect(signedOut).toMatchObject({ reproduced: 0, of: 1 });
    expect(signedOut.attempts[0]?.skipped).toBe('gone');
    expect(signedIn).toMatchObject({ reproduced: 1, of: 1 });
  });

  test('redacts what the attempts saw, as a run redacts what it writes', async () => {
    const finding = stepFindingOf(await inspectPage(bed, lens, '/leaky.html'), CONTRAST_FAIL);

    const result = await replay({ finding });

    expect(finding.observed).toContain(LEAKED_EMAIL);
    expect(result).toMatchObject({ reproduced: 1, of: 1 });
    expect(result.attempts[0]?.observed).toContain('Write to [email]');
    expect(JSON.stringify(result)).not.toContain(LEAKED_EMAIL);
  });

  test.each([
    [
      'a full config without the disposable-data acknowledgement',
      { acknowledgement: undefined },
      'E_ACK_REQUIRED',
    ],
    ['a base URL on a host that is not allowed', { baseUrl: OFF_ENVELOPE_URL }, 'E_NAVIGATION_BLOCKED'],
  ])('refuses %s before it launches a browser', async (_what, overrides, code) => {
    const launched = vi.spyOn(BrowserSession, 'launch');

    const replaying = replay({
      finding: stepFindingOf(controls, FOCUS_VISIBLE),
      config: configWith(overrides),
    });

    await expect(replaying).rejects.toMatchObject({ name: 'LookoverError', code });
    expect(launched).not.toHaveBeenCalled();
  });

  test('writes nothing under the project directory', async () => {
    await replay({ finding: stepFindingOf(controls, FOCUS_VISIBLE) });

    expect(await readdir(cwd)).toEqual([]);
  });
});

describe('replayScreens', () => {
  test("rebuilds a step finding's screen from its trace, with no elements to start from", () => {
    const captured = screenAt('screen-9', '/settings');
    const finding = focusOn(captured);

    expect(replayScreens(finding)).toEqual([
      {
        ...captured,
        title: '',
        elements: [],
        capturedAt: finding.createdAt,
      },
    ]);
  });

  test('rebuilds one screen for each distinct screen an occurrence finding was seen on', () => {
    const [home, reports] = [screenAt('screen-1', '/'), screenAt('screen-2', '/reports')];
    const finding = errorOn('Report locale missing', [home, reports, home]);

    expect(
      replayScreens(finding).map(({ id, url, route, viewport }) => ({ id, url, route, viewport })),
    ).toEqual([home, reports].map(({ id, url, route }) => ({ id, url, route, viewport: VIEWPORT })));
  });
});

describe('attempt lines', () => {
  test('one aligned line per attempt: the number, the outcome, what was seen or why not, the time', () => {
    const attempts = [
      attempt({ index: 1 }),
      attempt({ index: 2, reproduced: false, observed: null, skipped: 'gone', durationMs: 400 }),
      attempt({ index: 3, reproduced: false, observed: null, skipped: null, durationMs: 1_250 }),
    ];

    expect(attemptLines(attempts)).toEqual([
      '1  reproduced      shows no change when it receives keyboard focus  0.8 s',
      '2  not reproduced  skipped: gone  0.4 s',
      '3  not reproduced  not seen again  1.3 s',
    ]);
  });

  test('numbers the attempts in order, right-aligned once there are ten or more', () => {
    const attempts = Array.from({ length: 10 }, (_, index) => attempt({ index: (index % 5) + 1 }));

    const lines = attemptLines(attempts);

    expect(lines[0]).toMatch(/^ 1 {2}reproduced {2}/);
    expect(lines[9]).toMatch(/^10 {2}reproduced {2}/);
  });

  test('the summary counts what reproduced of what was tried', () => {
    expect(replaySummary({ reproduced: 1, of: 1 })).toBe('reproduced 1/1');
    expect(replaySummary({ reproduced: 0, of: 3 })).toBe('reproduced 0/3');
  });

  test('a replay reproduced only when every attempt did, and at least one was made', () => {
    expect(isFullyReproduced({ reproduced: 3, of: 3 })).toBe(true);
    expect(isFullyReproduced({ reproduced: 2, of: 3 })).toBe(false);
    expect(isFullyReproduced({ reproduced: 0, of: 0 })).toBe(false);
  });
});
