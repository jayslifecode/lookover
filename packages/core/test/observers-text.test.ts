import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { BrowserSession, type InstrumentedPage } from '../src/browser/session.js';
import { configSchema } from '../src/config/schema.js';
import { mergeFindings } from '../src/findings/id.js';
import type { Finding, OccurrenceFinding } from '../src/findings/types.js';
import type { Screen, Viewport } from '../src/map/types.js';
import { MAX_HIT_TEXT_LENGTH, MAX_TEXT_HITS, TextObserver } from '../src/observers/text.js';
import type { ObserverResult } from '../src/observers/types.js';
import { createRun, type RunContext } from '../src/run/run-context.js';
import { type FixtureServer, serveFixture } from './fixtures/serve.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/observers', import.meta.url));
const BROWSER_TIMEOUT_MS = 30_000;
const VIEWPORT: Viewport = { name: 'desktop', width: 1280, height: 800 };
const NOTHING_SEEN = { findings: [], worthALook: [], evidence: [] };
const KEY_TEXT_LENGTH = 120;

interface StoredText {
  screenId: string;
  dropped: number;
  hits: { kind: string; text: string; selector: string | null }[];
}

function asOccurrence(finding: Finding | undefined): OccurrenceFinding {
  if (finding?.shape !== 'occurrence') throw new Error('expected an occurrence finding');
  return finding;
}

describe('TextObserver', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let session: BrowserSession;
  let workDir: string;
  let ctx: RunContext;
  let ipage: InstrumentedPage;
  let observer: TextObserver;

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

  async function collectFrom(path: string): Promise<ObserverResult> {
    await ipage.page.goto(url(path));
    return observer.collect(screenAt('screen-1', path));
  }

  /** Shows `body` on the already loaded page and collects from it. */
  async function collectFromHtml(body: string): Promise<ObserverResult> {
    await ipage.page.goto(url('/console-clean.html'));
    await ipage.page.setContent(`<!doctype html><body>${body}</body>`);
    return observer.collect(screenAt('screen-1', '/console-clean.html'));
  }

  async function storedEvidence(result: ObserverResult): Promise<StoredText> {
    const [item] = result.evidence;
    if (item === undefined) throw new Error('expected a piece of evidence');
    return JSON.parse(await readFile(ctx.evidence.resolve(item.ref), 'utf8')) as StoredText;
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lookover-observers-text-'));
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
    observer = new TextObserver(ctx);
    observer.attach(ipage);
  });

  afterEach(async () => {
    await ipage.close();
  });

  test('is the text observer', () => {
    expect(observer.name).toBe('text');
  });

  test('finds the five raw texts and nothing in <code>, prose, versions, domains or file names', async () => {
    const result = await collectFrom('/text.html');

    expect(result.worthALook).toEqual([]);
    expect(result.findings.map((finding) => [finding.rule.id, finding.key])).toEqual([
      ['observers.raw-value', 'raw-value|Last edited by undefined'],
      ['observers.raw-value', 'raw-value|NaN'],
      ['observers.raw-value', 'raw-value|[object Object]'],
      ['observers.raw-i18n-key', 'raw-i18n-key|settings.timezone.label'],
      ['observers.unresolved-placeholder', 'unresolved-placeholder|Hello {{name}}'],
    ]);
    const [edited, , , key, placeholder] = result.findings.map(asOccurrence);
    expect(edited).toMatchObject({
      source: 'observers',
      status: 'candidate',
      severity: 'high',
      observed: 'shows "Last edited by undefined"',
    });
    expect(key).toMatchObject({ severity: 'medium', observed: 'shows "settings.timezone.label"' });
    expect(placeholder).toMatchObject({ severity: 'medium', observed: 'shows "Hello {{name}}"' });
    expect(edited?.occurrences).toEqual([
      {
        screenId: 'screen-1',
        route: '/text.html',
        url: url('/text.html'),
        viewport: VIEWPORT,
        selector: '#edited',
        measured: { text: 'Last edited by undefined', kind: 'raw-value' },
      },
    ]);
    expect(key?.fixPrompt).toContain(
      `In /text.html (${url('/text.html')}), shows "settings.timezone.label".`,
    );
  });

  test('selectors resolve to the element holding the text', async () => {
    const result = await collectFrom('/text.html');

    const selectors = result.findings.map(asOccurrence).map((finding) => finding.occurrences[0]?.selector);
    expect(selectors).toEqual([
      '#edited',
      expect.any(String),
      expect.any(String),
      '[data-testid="timezone"]',
      expect.any(String),
    ]);
    for (const finding of result.findings.map(asOccurrence)) {
      const [seen] = finding.occurrences;
      if (seen?.selector === null || seen?.selector === undefined) throw new Error('expected a selector');
      const held = await ipage.page.locator(seen.selector).innerText();
      expect(held).toBe(seen.measured.text);
    }
  });

  test('writes every hit as redacted evidence', async () => {
    const result = await collectFrom('/text.html');

    expect(result.evidence).toHaveLength(1);
    const [item] = result.evidence;
    if (item === undefined) throw new Error('expected a piece of evidence');
    expect(item).toMatchObject({ kind: 'text', label: 'Rendered text on /text.html', ref: { kind: 'json' } });
    expect(item.ref.path).toMatch(/^evidence\/text-screen-1-[0-9a-f]{16}\.json$/);
    expect(result.findings.map((finding) => finding.evidence)).toEqual(Array(5).fill([item]));
    const stored = await storedEvidence(result);
    expect(stored).toMatchObject({ screenId: 'screen-1', dropped: 0 });
    expect(stored.hits.map((hit) => [hit.kind, hit.text, hit.selector])).toEqual([
      ['raw-value', 'Last edited by undefined', '#edited'],
      ['raw-value', 'NaN', expect.any(String)],
      ['raw-value', '[object Object]', expect.any(String)],
      ['raw-i18n-key', 'settings.timezone.label', '[data-testid="timezone"]'],
      ['unresolved-placeholder', 'Hello {{name}}', expect.any(String)],
    ]);
  });

  test('skips what nobody can see: hidden, invisible and transparent elements', async () => {
    const result = await collectFromHtml(
      [
        '<p hidden>NaN</p>',
        '<p style="display: none">NaN</p>',
        '<p style="visibility: hidden">NaN</p>',
        '<p style="opacity: 0">NaN</p>',
        '<div style="display: none"><p>undefined</p></div>',
      ].join(''),
    );

    expect(result).toEqual(NOTHING_SEEN);
    expect(await ctx.evidence.list()).toEqual([]);
  });

  test.each([
    ['null', 'null'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['NaN inside a sentence', 'Total: NaN items'],
    ['[object Object] inside a sentence', 'Owner: [object Object]'],
    ['undefined at the end of a sentence', 'Welcome back, undefined'],
  ])('reports %s as a raw value', async (_name, text) => {
    const { findings } = await collectFromHtml(`<p>${text}</p>`);

    expect(findings.map((finding) => [finding.rule.id, finding.key])).toEqual([
      ['observers.raw-value', `raw-value|${text}`],
    ]);
  });

  test.each([
    'The value is null today',
    'Nancy and Banana',
    'NaNa',
    'an undefined period',
    'undefined behaviour is fun',
    'Infinity and beyond',
  ])('does not report prose: %s', async (text) => {
    const result = await collectFromHtml(`<p>${text}</p>`);

    expect(result).toEqual(NOTHING_SEEN);
  });

  test.each([
    ['a double-brace placeholder with spaces', 'Hello {{ user.name }}!'],
    ['a single-brace placeholder', 'You have {count} new messages'],
  ])('reports %s as an unresolved placeholder', async (_name, text) => {
    const { findings } = await collectFromHtml(`<p>${text}</p>`);

    expect(findings.map((finding) => [finding.rule.id, finding.key])).toEqual([
      ['observers.unresolved-placeholder', `unresolved-placeholder|${text}`],
    ]);
  });

  test.each([
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the text is a template literal's source on purpose
    'Total: ${amount}',
    'Use {} for an empty object',
    '{ "a": 1 }',
    'the {1} and {a b}',
  ])('does not report a template literal or JSON-looking text: %s', async (text) => {
    const result = await collectFromHtml(`<p>${text}</p>`);

    expect(result).toEqual(NOTHING_SEEN);
  });

  test.each([
    'common.actions.save',
    'settings.timezone.hint',
    'errors.form_invalid.title',
    'app.nav.items2.label',
  ])('reports %s as a raw translation key', async (text) => {
    const { findings } = await collectFromHtml(`<p>${text}</p>`);

    expect(findings.map((finding) => finding.rule.id)).toEqual(['observers.raw-i18n-key']);
  });

  test.each([
    'save.button',
    'Settings.timezone.label',
    'v1.2.3',
    'www.example.com',
    'api.example.org',
    'index.test.ts',
    'logo.final.png',
    'config.local.json',
    'Read settings.timezone.label first',
    'a.b.c d',
  ])('does not report a name that is not a translation key: %s', async (text) => {
    const result = await collectFromHtml(`<p>${text}</p>`);

    expect(result).toEqual(NOTHING_SEEN);
  });

  test('reports a text once per screen however many elements show it, at the first one', async () => {
    const result = await collectFromHtml('<p id="a">NaN</p><p id="b">NaN</p>');

    const [finding] = result.findings.map(asOccurrence);
    expect(result.findings).toHaveLength(1);
    expect(finding?.occurrences.map((seen) => seen.selector)).toEqual(['#a']);
  });

  test('the same text on two screens is one finding with two occurrences', async () => {
    const first = await collectFromHtml('<p>NaN</p>');
    const second = await observer.collect(screenAt('screen-2', '/console-clean.html'));
    const merged = mergeFindings([...first.findings, ...second.findings]);

    expect(second.findings).toHaveLength(1);
    expect(merged).toHaveLength(1);
    expect(asOccurrence(merged[0]).occurrences.map((seen) => seen.screenId)).toEqual([
      'screen-1',
      'screen-2',
    ]);
  });

  test('gives a text node in a nested element the selector of its parent', async () => {
    const { findings } = await collectFromHtml('<ul><li>one</li><li><b>NaN</b></li></ul>');

    const [finding] = findings.map(asOccurrence);
    const selector = finding?.occurrences[0]?.selector;
    expect(selector).toBe('body > ul:nth-of-type(1) > li:nth-of-type(2) > b:nth-of-type(1)');
    expect(await ipage.page.locator(selector ?? '').innerText()).toBe('NaN');
  });

  test('keeps the first 120 characters of the text in the key and the occurrence', async () => {
    const text = `${'w'.repeat(KEY_TEXT_LENGTH + 40)} undefined`;
    const { findings } = await collectFromHtml(`<p>${text}</p>`);

    const [finding] = findings.map(asOccurrence);
    expect(finding?.key).toBe(`raw-value|${'w'.repeat(KEY_TEXT_LENGTH)}`);
    expect(finding?.occurrences[0]?.measured.text).toBe('w'.repeat(KEY_TEXT_LENGTH));
    expect(finding?.observed).toBe(`shows "${'w'.repeat(KEY_TEXT_LENGTH)}"`);
  });

  test('puts text on one line in the sentence, before shortening it', async () => {
    const { findings } = await collectFromHtml('<p>Last edited\n\n    by\tundefined</p>');

    const [finding] = findings.map(asOccurrence);
    expect(finding?.observed).toBe('shows "Last edited by undefined"');
    expect(finding?.fixPrompt.split('\n')[0]).toBe(
      `In /console-clean.html (${url('/console-clean.html')}), shows "Last edited by undefined".`,
    );
  });

  test('puts text on one line before cutting it to 120 characters, so the cut counts the words, not the padding', async () => {
    const text = `${'w'.repeat(100)}\n\n        \t        ${'x'.repeat(50)} undefined`;
    const { findings } = await collectFromHtml(`<p>${text}</p>`);

    const [finding] = findings.map(asOccurrence);
    expect(finding?.observed).toBe(`shows "${'w'.repeat(100)} ${'x'.repeat(19)}"`);
  });

  test('redacts the text before it is cut, in the findings and in the evidence', async () => {
    const redacted = `Invoice for [email] is NaN${'!'.repeat(MAX_HIT_TEXT_LENGTH)}`;
    const result = await collectFromHtml(
      `<p>Invoice for jay@example.com is NaN${'!'.repeat(MAX_HIT_TEXT_LENGTH)}</p>`,
    );

    const [finding] = result.findings.map(asOccurrence);
    expect(finding?.key).toBe(`raw-value|${redacted.slice(0, KEY_TEXT_LENGTH)}`);
    expect(JSON.stringify(result)).not.toContain('jay@example.com');
    const stored = await storedEvidence(result);
    expect(stored.hits[0]?.text).toHaveLength(MAX_HIT_TEXT_LENGTH);
    expect(stored.hits[0]?.text).toMatch(/^Invoice for \[email\] is NaN!+$/);
  });

  test('redacts a secret that straddles the cut, rather than storing half of it', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIz';
    const padding = 'p'.repeat(MAX_HIT_TEXT_LENGTH - 'NaN '.length - 'eyJhbGciOiJ'.length);
    const result = await collectFromHtml(`<p>NaN ${padding} ${jwt}</p>`);

    const stored = await storedEvidence(result);
    expect(JSON.stringify(stored)).not.toContain('eyJ');
    expect(JSON.stringify(result.findings)).not.toContain('eyJ');
  });

  test('caps hits at MAX_TEXT_HITS, counting the ones it left out', async () => {
    const paragraphs = Array.from({ length: MAX_TEXT_HITS + 30 }, (_, index) => `<p>Row ${index} is NaN</p>`);
    const result = await collectFromHtml(paragraphs.join(''));

    expect(result.findings).toHaveLength(MAX_TEXT_HITS);
    const stored = await storedEvidence(result);
    expect(stored.hits).toHaveLength(MAX_TEXT_HITS);
    expect(stored.dropped).toBe(30);
  });

  test('a clean page yields nothing', async () => {
    const result = await collectFrom('/console-clean.html');

    expect(result).toEqual(NOTHING_SEEN);
    expect(await ctx.evidence.list()).toEqual([]);
  });

  test('fails with a clear error when asked to collect before it was attached', async () => {
    const detached = new TextObserver(ctx);

    await expect(detached.collect(screenAt('screen-1', '/text.html'))).rejects.toThrow(/attach/);
  });
});
