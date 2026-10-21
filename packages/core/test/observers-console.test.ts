import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { BrowserSession, type InstrumentedPage } from '../src/browser/session.js';
import { configSchema } from '../src/config/schema.js';
import { findingId, mergeFindings } from '../src/findings/id.js';
import type { Finding, OccurrenceFinding } from '../src/findings/types.js';
import type { Screen, Viewport } from '../src/map/types.js';
import { ConsoleObserver, normaliseMessage } from '../src/observers/console.js';
import { isIgnoredConsoleEntry } from '../src/observers/noise.js';
import { createRun, type RunContext } from '../src/run/run-context.js';
import { type FixtureServer, serveFixture } from './fixtures/serve.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/observers', import.meta.url));
const BROWSER_TIMEOUT_MS = 30_000;
const VIEWPORT: Viewport = { name: 'desktop', width: 1280, height: 800 };
const NOTHING_SEEN = { findings: [], worthALook: [], evidence: [] };
/** The `console.error` call sits on line 10 of the fixture; Playwright counts from 0, editors from 1. */
const LOCATION = /^http:\/\/127\.0\.0\.1:\d+\/console\.html:10:\d+$/;
const MEASURED_MESSAGE_LENGTH = 300;
const OBSERVED_MESSAGE_LENGTH = 120;
const KEY_LENGTH = 200;

type ConsoleMethod = 'error' | 'warn' | 'log';

function asOccurrence(finding: Finding | undefined): OccurrenceFinding {
  if (finding?.shape !== 'occurrence') throw new Error('expected an occurrence finding');
  return finding;
}

function ruleIds(findings: readonly Finding[]): string[] {
  return findings.map((finding) => finding.rule.id);
}

describe('normaliseMessage', () => {
  test('turns numbers and URLs into placeholders so a repeated message has one key', () => {
    expect(normaliseMessage('Failed 3 rows at https://a.b/c?x=1')).toBe('Failed # rows at <url>');
  });

  test('collapses whitespace and keeps the first 200 characters', () => {
    expect(normaliseMessage('  two\n\n  lines\tof   text ')).toBe('two lines of text');
    expect(normaliseMessage('x'.repeat(KEY_LENGTH + 50))).toBe('x'.repeat(KEY_LENGTH));
  });
});

describe('isIgnoredConsoleEntry', () => {
  test.each([
    '[Fast Refresh] rebuilding',
    'Download the React DevTools for a better development experience',
    '[HMR] connected',
    '%cNext.js color: red',
  ])('ignores dev tooling chatter: %s', (text) => {
    expect(isIgnoredConsoleEntry({ text, location: null })).toBe(true);
  });

  test('ignores whatever a browser extension logged', () => {
    expect(
      isIgnoredConsoleEntry({
        text: 'Unchecked runtime.lastError',
        location: 'chrome-extension://abc/x.js:1:1',
      }),
    ).toBe(true);
  });

  test('keeps an app error, even one that mentions a tool', () => {
    expect(
      isIgnoredConsoleEntry({ text: 'Failed to fetch', location: 'http://localhost:3000/app.js:1:1' }),
    ).toBe(false);
    expect(isIgnoredConsoleEntry({ text: 'The [HMR] socket closed', location: null })).toBe(false);
  });
});

describe('ConsoleObserver', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let session: BrowserSession;
  let workDir: string;
  let ctx: RunContext;
  let ipage: InstrumentedPage;
  let observer: ConsoleObserver;

  const url = (path: string): string => `${fixture.url}${path}`;

  function screenAt(id: string, path: string): Screen {
    return {
      id,
      url: url(path),
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
      capturedAt: '2026-10-21T12:00:00.000Z',
    };
  }

  /** Runs `load`, and (for a page that throws on a timer) waits until the throw has reached the observer. */
  async function afterLoad(load: () => Promise<unknown>, throws: boolean): Promise<void> {
    // Registered after the observer's own listener, so the observer has seen the error when this resolves.
    const thrown = throws ? ipage.page.waitForEvent('pageerror') : Promise.resolve();
    await Promise.all([thrown, load()]);
  }

  function open(path: string, { throws = false } = {}): Promise<void> {
    return afterLoad(() => ipage.page.goto(url(path)), throws);
  }

  /** Logs from inside the page and waits until the observer has been told. */
  async function logInPage(method: ConsoleMethod, text: string): Promise<void> {
    await Promise.all([
      ipage.page.waitForEvent('console'),
      ipage.page.evaluate(({ name, message }) => console[name](message), { name: method, message: text }),
    ]);
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lookover-observers-console-'));
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
    ipage = await session.newPage();
    observer = new ConsoleObserver(ctx);
    observer.attach(ipage);
  });

  afterEach(async () => {
    await ipage.close();
  });

  test('is the console observer', () => {
    expect(observer.name).toBe('console');
  });

  test('turns console errors and uncaught exceptions into candidates, warnings into worth-a-look, and drops dev noise', async () => {
    await open('/console.html', { throws: true });

    const result = await observer.collect(screenAt('screen-1', '/console.html'));

    expect(ruleIds(result.findings)).toEqual(['observers.console-error', 'observers.page-error']);
    expect(ruleIds(result.worthALook)).toEqual(['observers.console-warning']);
    const [error, pageError] = result.findings.map(asOccurrence);
    const [warning] = result.worthALook.map(asOccurrence);
    expect(error).toMatchObject({
      source: 'observers',
      status: 'candidate',
      severity: 'medium',
      key: 'Report locale missing for # rows',
      observed: 'logged "Report locale missing for 3 rows"',
    });
    expect(error?.occurrences).toEqual([
      {
        screenId: 'screen-1',
        route: '/console.html',
        url: url('/console.html'),
        viewport: VIEWPORT,
        selector: null,
        measured: {
          message: 'Report locale missing for 3 rows',
          type: 'error',
          location: expect.stringMatching(LOCATION),
          count: 1,
        },
      },
    ]);
    expect(pageError).toMatchObject({ severity: 'high', observed: 'threw "TypeError: rows is undefined"' });
    expect(pageError?.occurrences[0]?.measured).toEqual({
      message: 'TypeError: rows is undefined',
      type: 'pageerror',
      location: null,
      count: 1,
    });
    expect(warning).toMatchObject({ severity: 'low', observed: 'logged "Column "owner" is deprecated"' });
    expect(error?.fixPrompt).toContain(`In /console.html (${url('/console.html')}), logged "Report locale`);
    expect(JSON.stringify(result)).not.toMatch(/Fast Refresh|DevTools/);
  });

  test('reports an uncaught throw of something that is not an error by what was thrown', async () => {
    await open('/console-clean.html');
    await Promise.all([
      ipage.page.waitForEvent('pageerror'),
      ipage.page.evaluate(() => {
        setTimeout(() => {
          throw 'The cart is empty';
        }, 0);
      }),
    ]);

    const { findings } = await observer.collect(screenAt('screen-1', '/console-clean.html'));

    const [finding] = findings.map(asOccurrence);
    expect(finding?.rule.id).toBe('observers.page-error');
    expect(finding?.observed).toBe('threw "The cart is empty"');
    expect(finding?.key).toBe('The cart is empty');
  });

  test('gives each finding an id from its rule and its normalised message', async () => {
    await open('/console.html', { throws: true });

    const { findings, worthALook } = await observer.collect(screenAt('screen-1', '/console.html'));

    expect([...findings, ...worthALook].map((finding) => [finding.id, finding.key])).toEqual([
      [
        findingId('observers.console-error', 'Report locale missing for # rows'),
        'Report locale missing for # rows',
      ],
      [findingId('observers.page-error', 'TypeError: rows is undefined'), 'TypeError: rows is undefined'],
      [
        findingId('observers.console-warning', 'Column "owner" is deprecated'),
        'Column "owner" is deprecated',
      ],
    ]);
  });

  test('the same message on two screens is one finding with two occurrences', async () => {
    await open('/console.html', { throws: true });
    const first = await observer.collect(screenAt('screen-1', '/console.html'));
    await open('/console.html', { throws: true });
    const second = await observer.collect(screenAt('screen-2', '/console.html'));

    const merged = mergeFindings([...first.findings, ...second.findings]);

    expect(ruleIds(merged)).toEqual(['observers.console-error', 'observers.page-error']);
    for (const finding of merged.map(asOccurrence)) {
      expect(finding.occurrences.map((seen) => seen.screenId)).toEqual(['screen-1', 'screen-2']);
    }
  });

  test('counts the messages that share a key on a screen, and shows the first', async () => {
    await open('/console-repeated.html');

    const { findings } = await observer.collect(screenAt('screen-1', '/console-repeated.html'));

    expect(findings.map((finding) => finding.key)).toEqual([
      'Row # failed to load <url>',
      'Could not reach the billing service',
    ]);
    const [rows, billing] = findings.map(asOccurrence);
    expect(rows?.occurrences).toHaveLength(1);
    expect(rows?.occurrences[0]?.measured).toMatchObject({
      message: 'Row 4 failed to load https://api.test/rows/4',
      count: 3,
    });
    expect(rows?.observed).toBe('logged "Row 4 failed to load https://api.test/rows/4"');
    expect(billing?.occurrences[0]?.measured).toMatchObject({ count: 1 });
  });

  test('keeps an error and a warning with the same text apart', async () => {
    await open('/console-clean.html');
    await logInPage('error', 'Slow query');
    await logInPage('warn', 'Slow query');

    const { findings, worthALook } = await observer.collect(screenAt('screen-1', '/console-clean.html'));

    expect(ruleIds(findings)).toEqual(['observers.console-error']);
    expect(ruleIds(worthALook)).toEqual(['observers.console-warning']);
    expect(findings[0]?.id).not.toBe(worthALook[0]?.id);
  });

  test('shortens a long message to 300 characters in the occurrence and 120 in the sentence', async () => {
    await open('/console-clean.html');
    await logInPage('error', 'y'.repeat(MEASURED_MESSAGE_LENGTH + 100));

    const { findings } = await observer.collect(screenAt('screen-1', '/console-clean.html'));

    const [finding] = findings.map(asOccurrence);
    expect(finding?.occurrences[0]?.measured.message).toBe('y'.repeat(MEASURED_MESSAGE_LENGTH));
    expect(finding?.observed).toBe(`logged "${'y'.repeat(OBSERVED_MESSAGE_LENGTH)}"`);
    expect(finding?.key).toBe('y'.repeat(KEY_LENGTH));
  });

  test("writes the screen's console entries as redacted evidence", async () => {
    await open('/console-clean.html');
    await logInPage('error', 'Could not send the invoice to jay@example.com');

    const result = await observer.collect(screenAt('screen-1', '/console-clean.html'));

    expect(result.evidence).toHaveLength(1);
    const [item] = result.evidence;
    if (item === undefined) throw new Error('expected a piece of evidence');
    expect(item).toMatchObject({ kind: 'console', ref: { kind: 'json' } });
    expect(item.ref.path).toMatch(/^evidence\/console-screen-1-[0-9a-f]{16}\.json$/);
    expect(result.findings.map((finding) => finding.evidence)).toEqual([[item]]);
    const onDisk = await readFile(ctx.evidence.resolve(item.ref), 'utf8');
    expect(onDisk).toContain('Could not send the invoice to [email]');
    expect(onDisk).not.toContain('jay@example.com');
    expect(JSON.parse(onDisk)).toMatchObject({
      screenId: 'screen-1',
      entries: [{ type: 'error', text: 'Could not send the invoice to [email]', location: null }],
    });
  });

  test('a clean page yields nothing', async () => {
    await open('/console-clean.html');

    const result = await observer.collect(screenAt('screen-1', '/console-clean.html'));

    expect(result).toEqual(NOTHING_SEEN);
    expect(await ctx.evidence.list()).toEqual([]);
  });

  test('a page that only logs dev noise yields nothing', async () => {
    await open('/console-clean.html');
    await logInPage('warn', '[Fast Refresh] done in 12ms');
    await logInPage('error', '[HMR] connection lost');

    const result = await observer.collect(screenAt('screen-1', '/console-clean.html'));

    expect(result).toEqual(NOTHING_SEEN);
    expect(await ctx.evidence.list()).toEqual([]);
  });

  test('reports what was seen once: the next collect starts empty', async () => {
    await open('/console.html', { throws: true });
    await observer.collect(screenAt('screen-1', '/console.html'));

    const again = await observer.collect(screenAt('screen-1', '/console.html'));

    expect(again).toEqual(NOTHING_SEEN);
  });

  test("never carries one screen's messages into the next, whatever happened to the page in between", async () => {
    await open('/console.html', { throws: true });
    // A lens reloads the screen's own URL, and no collect runs for it.
    await afterLoad(() => ipage.page.reload(), true);
    await open('/console-clean.html');

    const result = await observer.collect(screenAt('screen-2', '/console-clean.html'));

    expect(result).toEqual(NOTHING_SEEN);
  });

  test('a reload replaces what the page logged before it', async () => {
    await open('/console.html', { throws: true });
    await afterLoad(() => ipage.page.reload(), true);

    const { findings } = await observer.collect(screenAt('screen-1', '/console.html'));

    expect(findings.map(asOccurrence).map((finding) => finding.occurrences[0]?.measured.count)).toEqual([
      1, 1,
    ]);
  });

  test("keeps the page's messages when one of its frames navigates", async () => {
    await open('/console-frame.html');

    const { findings } = await observer.collect(screenAt('screen-1', '/console-frame.html'));

    expect(findings.map((finding) => finding.key)).toEqual(['Logged before the frame loads']);
  });
});
