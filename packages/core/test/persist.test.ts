import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { LookoverError } from '../src/errors.js';
import { diffAppMaps, readLatestAppMap, writeAppMap } from '../src/map/persist.js';
import type { AppMap, ElementRef, Screen } from '../src/map/types.js';
import { createRun } from '../src/run/run-context.js';

const LATEST_FILE = 'app-map.json';

function element(selector: string): ElementRef {
  return {
    selector,
    role: 'button',
    name: selector,
    tag: 'button',
    box: { x: 0, y: 0, width: 10, height: 10 },
    disabled: false,
    focusable: true,
  };
}

interface ScreenOptions {
  id?: string;
  viewport?: string;
  title?: string;
}

function screen(route: string, selectors: readonly string[], options: ScreenOptions = {}): Screen {
  const { id = `${route}-screen`, viewport = 'desktop', title = 'Page' } = options;
  return {
    id,
    url: `http://localhost:3000${route}`,
    route,
    title,
    status: 'captured',
    error: null,
    viewport: { name: viewport, width: 1280, height: 800 },
    screenshot: null,
    elements: selectors.map(element),
    forms: [],
    tokens: [{ property: 'color', value: 'rgb(0, 0, 0)', count: 3 }],
    links: ['/about'],
    discoveredFrom: null,
    capturedAt: '2026-10-20T12:00:00.000Z',
  };
}

function appMap(screens: Screen[], runId = 'run-1'): AppMap {
  return {
    version: 1,
    runId,
    createdAt: '2026-10-20T12:00:00.000Z',
    baseUrl: 'http://localhost:3000',
    routes: [{ pattern: '/', source: 'link' }],
    screens,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe('persistence', () => {
  let cwd: string;
  const config = configSchema.parse({
    baseUrl: 'http://localhost:3000',
    interaction: 'safe',
    acknowledgement: { disposableData: true, acknowledgedAt: '2026-10-20T00:00:00.000Z' },
  });

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'lookover-persist-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  describe('writeAppMap', () => {
    test('writes the map to the run directory and to the project latest path', async () => {
      const ctx = await createRun({ cwd, config });

      const paths = await writeAppMap(ctx, appMap([screen('/', ['#a'])], ctx.runId));

      expect(paths).toEqual({
        runPath: join(ctx.dir, 'app-map.json'),
        latestPath: join(ctx.lookoverDir, 'app-map.json'),
      });
    });

    test('reads back as the map that was written', async () => {
      const ctx = await createRun({ cwd, config });
      const map = appMap([screen('/', ['#a', '#b']), screen('/pricing', ['#c'])], ctx.runId);

      await writeAppMap(ctx, map);

      expect(await readLatestAppMap(ctx.lookoverDir)).toEqual(map);
    });

    test('keeps the status and error of a screen whose navigation failed', async () => {
      const ctx = await createRun({ cwd, config });
      const failed: Screen = {
        ...screen('/gone', []),
        title: '(navigation failed: net::ERR_CONNECTION_REFUSED at http://localhost:3000/gone)',
        status: 'navigation-failed',
        error: 'net::ERR_CONNECTION_REFUSED at http://localhost:3000/gone',
      };
      const map = appMap([screen('/', ['#a']), failed], ctx.runId);

      await writeAppMap(ctx, map);

      const saved = await readLatestAppMap(ctx.lookoverDir);
      expect(saved?.screens.map(({ status, error }) => ({ status, error }))).toEqual([
        { status: 'captured', error: null },
        { status: 'navigation-failed', error: 'net::ERR_CONNECTION_REFUSED at http://localhost:3000/gone' },
      ]);
    });

    test('serialises with two-space indentation and a trailing newline, identically in both files', async () => {
      const ctx = await createRun({ cwd, config });
      const map = appMap([screen('/', ['#a'])], ctx.runId);

      const { runPath, latestPath } = await writeAppMap(ctx, map);

      const runBytes = await readFile(runPath);
      expect(runBytes.toString('utf8')).toBe(`${JSON.stringify(map, null, 2)}\n`);
      expect((await readFile(latestPath)).equals(runBytes)).toBe(true);
    });

    test('redacts secrets in the written files without mutating the map it was given', async () => {
      const ctx = await createRun({ cwd, config });
      const map = deepFreeze(
        appMap([screen('/', ['#a'], { title: 'Session token=abc123secret for jay@example.com' })], ctx.runId),
      );

      const { runPath, latestPath } = await writeAppMap(ctx, map);

      for (const path of [runPath, latestPath]) {
        const written = await readFile(path, 'utf8');
        expect(written).not.toContain('abc123secret');
        expect(written).not.toContain('jay@example.com');
        expect(written).toContain('token=[redacted] for [email]');
      }
      expect(map.screens[0]?.title).toBe('Session token=abc123secret for jay@example.com');
    });

    test('replaces the latest map of an earlier run and leaves that run file alone', async () => {
      const first = await createRun({ cwd, config, random: () => 'aaaa' });
      const second = await createRun({ cwd, config, random: () => 'bbbb' });
      const firstMap = appMap([screen('/', ['#a'])], first.runId);
      const secondMap = appMap([screen('/', ['#a', '#b'])], second.runId);

      const firstPaths = await writeAppMap(first, firstMap);
      await writeAppMap(second, secondMap);

      expect(await readLatestAppMap(first.lookoverDir)).toEqual(secondMap);
      expect(JSON.parse(await readFile(firstPaths.runPath, 'utf8'))).toEqual(firstMap);
    });

    test('leaves no temporary files behind', async () => {
      const ctx = await createRun({ cwd, config });

      await writeAppMap(ctx, appMap([screen('/', ['#a'])], ctx.runId));

      expect((await readdir(ctx.dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      expect((await readdir(ctx.lookoverDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
  });

  describe('diffing a persisted map against the raw map it was written from', () => {
    test('reports no drift for selectors that redaction rewrote on disk', async () => {
      const ctx = await createRun({ cwd, config });
      const raw = appMap(
        [screen('/', ['a[href="mailto:jay@example.com"]', 'a[href="/reset?token=abc"]', '#plain'])],
        ctx.runId,
      );

      await writeAppMap(ctx, raw);
      const persisted = await readLatestAppMap(ctx.lookoverDir);

      expect(persisted?.screens[0]?.elements.map((element) => element.selector)).toEqual([
        'a[href="mailto:[email]"]',
        'a[href="/reset?token=[redacted]"]',
        '#plain',
      ]);
      expect(persisted).not.toBeNull();
      expect(diffAppMaps(persisted as AppMap, raw)).toEqual({
        addedScreens: [],
        removedScreens: [],
        changedScreens: [],
      });
    });
  });

  describe('readLatestAppMap', () => {
    test('returns null for a directory with no app map', async () => {
      expect(await readLatestAppMap(cwd)).toBeNull();
    });

    test('returns null when the lookover directory does not exist', async () => {
      expect(await readLatestAppMap(join(cwd, 'missing', '.lookover'))).toBeNull();
    });

    test('throws E_RUN_FAILED naming the file when it is not valid JSON', async () => {
      await writeFile(join(cwd, LATEST_FILE), '{ "version": 1, ', 'utf8');

      const failure = await readLatestAppMap(cwd).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(LookoverError);
      expect((failure as LookoverError).code).toBe('E_RUN_FAILED');
      expect((failure as LookoverError).message).toContain(join(cwd, LATEST_FILE));
    });

    test.each([
      ['an unsupported version', JSON.stringify({ ...appMap([]), version: 2 })],
      ['no version', JSON.stringify({ screens: [] })],
      ['a JSON null', 'null'],
      ['a JSON array', '[]'],
    ])('throws E_RUN_FAILED naming the file for %s', async (_label, contents) => {
      await writeFile(join(cwd, LATEST_FILE), contents, 'utf8');

      const failure = await readLatestAppMap(cwd).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(LookoverError);
      expect((failure as LookoverError).code).toBe('E_RUN_FAILED');
      expect((failure as LookoverError).message).toContain(join(cwd, LATEST_FILE));
    });

    test('propagates filesystem errors other than a missing file', async () => {
      await mkdir(join(cwd, LATEST_FILE));

      const failure = await readLatestAppMap(cwd).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(LookoverError);
      expect((failure as NodeJS.ErrnoException).code).toBe('EISDIR');
    });
  });
});

describe('diffAppMaps', () => {
  const previous = appMap([
    screen('/', ['#a', '#b', '#c'], { id: 'prev-home' }),
    screen('/old', ['#x'], { id: 'prev-old' }),
  ]);
  const next = appMap(
    [screen('/', ['#a', '#d', '#b'], { id: 'next-home' }), screen('/new', ['#y'], { id: 'next-new' })],
    'run-2',
  );

  test('reports one added screen, one removed screen and one changed screen', () => {
    const diff = diffAppMaps(previous, next);

    expect(diff).toEqual({
      addedScreens: ['/new|desktop'],
      removedScreens: ['/old|desktop'],
      changedScreens: [{ screenId: 'next-home', addedElements: ['#d'], removedElements: ['#c'] }],
    });
  });

  test('is empty for identical maps', () => {
    expect(diffAppMaps(previous, previous)).toEqual({
      addedScreens: [],
      removedScreens: [],
      changedScreens: [],
    });
  });

  test('does not list a screen whose elements were only reordered', () => {
    const reordered = appMap([screen('/', ['#c', '#a', '#b'], { id: 'other-id' })], 'run-2');
    const original = appMap([screen('/', ['#a', '#b', '#c'])]);

    expect(diffAppMaps(original, reordered).changedScreens).toEqual([]);
  });

  test('keys screens by route and viewport name', () => {
    const before = appMap([screen('/', ['#a'], { viewport: 'desktop' })]);
    const after = appMap([screen('/', ['#a'], { viewport: 'mobile' })]);

    expect(diffAppMaps(before, after)).toEqual({
      addedScreens: ['/|mobile'],
      removedScreens: ['/|desktop'],
      changedScreens: [],
    });
  });

  test('sorts screens, changed screens and selectors', () => {
    const before = appMap([screen('/b', ['#z', '#m']), screen('/a', ['#z', '#m']), screen('/gone-2', [])]);
    const after = appMap([
      screen('/b', ['#y', '#x'], { id: 'b-next' }),
      screen('/a', ['#w', '#v'], { id: 'a-next' }),
      screen('/new-2', []),
      screen('/new-1', []),
    ]);

    expect(diffAppMaps(before, after)).toEqual({
      addedScreens: ['/new-1|desktop', '/new-2|desktop'],
      removedScreens: ['/gone-2|desktop'],
      changedScreens: [
        { screenId: 'a-next', addedElements: ['#v', '#w'], removedElements: ['#m', '#z'] },
        { screenId: 'b-next', addedElements: ['#x', '#y'], removedElements: ['#m', '#z'] },
      ],
    });
  });

  test('merges the elements of several screens that share a route and viewport', () => {
    const before = appMap([
      screen('/orgs/[id]', ['#a'], { id: 'org-1' }),
      screen('/orgs/[id]', ['#b'], { id: 'org-2' }),
    ]);
    const after = appMap([
      screen('/orgs/[id]', ['#b'], { id: 'org-2-next' }),
      screen('/orgs/[id]', ['#a'], { id: 'org-1-next' }),
    ]);

    expect(diffAppMaps(before, after).changedScreens).toEqual([]);
  });

  test('treats a raw token selector and its persisted redacted form as the same element', () => {
    const persisted = appMap([screen('/', ['a[href="/reset?token=[redacted]"]'])]);
    const raw = appMap([screen('/', ['a[href="/reset?token=abc"]'])], 'run-2');

    expect(diffAppMaps(persisted, raw).changedScreens).toEqual([]);
    expect(diffAppMaps(raw, persisted).changedScreens).toEqual([]);
  });

  test('reports changed selectors in their redacted form', () => {
    const before = appMap([screen('/', ['#a', 'a[href="mailto:old@example.com"]'], { id: 'prev' })]);
    const after = appMap([screen('/', ['#a', 'a[href="/reset?token=abc"]'], { id: 'next' })], 'run-2');

    expect(diffAppMaps(before, after).changedScreens).toEqual([
      {
        screenId: 'next',
        addedElements: ['a[href="/reset?token=[redacted]"]'],
        removedElements: ['a[href="mailto:[email]"]'],
      },
    ]);
  });

  test('gives the same diff however the screens of a shared route are ordered', () => {
    const before = [
      screen('/orgs/[id]', ['#a'], { id: 'org-b' }),
      screen('/orgs/[id]', ['#b'], { id: 'org-a' }),
    ];
    const after = [
      screen('/orgs/[id]', ['#a', '#c'], { id: 'org-d' }),
      screen('/orgs/[id]', ['#b', '#e'], { id: 'org-c' }),
    ];

    const forward = diffAppMaps(appMap(before), appMap(after, 'run-2'));
    const reversed = diffAppMaps(appMap(before.toReversed()), appMap(after.toReversed(), 'run-2'));

    expect(forward.changedScreens).toEqual([
      { screenId: 'org-c', addedElements: ['#c', '#e'], removedElements: [] },
    ]);
    expect(reversed).toEqual(forward);
  });

  test('never mutates its inputs', () => {
    const frozenPrevious = deepFreeze(structuredClone(previous));
    const frozenNext = deepFreeze(structuredClone(next));

    expect(() => diffAppMaps(frozenPrevious, frozenNext)).not.toThrow();
    expect(frozenPrevious).toEqual(previous);
    expect(frozenNext).toEqual(next);
  });
});
