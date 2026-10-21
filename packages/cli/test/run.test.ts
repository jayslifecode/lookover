import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AppMap,
  configSchema,
  type ElementRef,
  type FormInfo,
  type LookoverConfig,
  LookoverError,
  type Screen,
  writeConfig,
} from '@jayslifecode/lookover-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  collectRepeated,
  configForRun,
  mergeHosts,
  parseRunFlags,
  saveConfirmedHosts,
} from '../src/commands/run-options.js';
import {
  blockedHostsWarning,
  formatDuration,
  progressLine,
  summaryRows,
} from '../src/commands/run-summary.js';
import { runCli } from './run-cli.js';

const PERMISSION_BITS = 0o777;
const PRIVATE_FILE_MODE = 0o600;

const BASE_CONFIG: LookoverConfig = configSchema.parse({
  baseUrl: 'http://localhost:3000',
  interaction: 'safe',
});

function element(name: string): ElementRef {
  return {
    selector: `#${name}`,
    role: 'button',
    name,
    tag: 'button',
    box: { x: 0, y: 0, width: 10, height: 10 },
    disabled: false,
    focusable: true,
  };
}

function form(selector: string): FormInfo {
  return { selector, action: null, method: 'get', fields: [], submit: null };
}

function screen(overrides: Partial<Screen> = {}): Screen {
  return {
    id: 'abc',
    url: 'http://localhost:3000/',
    route: '/',
    title: 'Home',
    status: 'captured',
    error: null,
    viewport: { name: 'desktop', width: 1440, height: 900 },
    screenshot: null,
    elements: [],
    forms: [],
    tokens: [],
    links: [],
    redirectedFrom: null,
    discoveredFrom: null,
    capturedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  };
}

function appMap(screens: Screen[]): AppMap {
  return {
    version: 1,
    runId: 'run-1',
    createdAt: '2026-10-21T00:00:00.000Z',
    baseUrl: 'http://localhost:3000',
    routes: [],
    screens,
  };
}

function lookoverErrorOf(fn: () => unknown): LookoverError {
  try {
    fn();
  } catch (error) {
    if (error instanceof LookoverError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a LookoverError');
}

describe('collectRepeated', () => {
  test('collects every use of a repeated flag, in order, without changing the previous list', () => {
    const first = collectRepeated('a.test', undefined);
    const second = collectRepeated('b.test', first);

    expect(first).toEqual(['a.test']);
    expect(second).toEqual(['a.test', 'b.test']);
  });
});

describe('parseRunFlags', () => {
  test('defaults to headless, the configured screen budget, no extra hosts and prompting', () => {
    expect(parseRunFlags({})).toEqual({
      isHeaded: false,
      maxScreens: undefined,
      allowHosts: [],
      confirmHosts: [],
      isYes: false,
    });
  });

  test('lowercases, trims and deduplicates host flags', () => {
    const options = parseRunFlags({
      confirmHost: ['API.Dev.Example.com', 'api.dev.example.com.', ' other.test '],
      allowHost: ['*.Fonts.Example.com', 'cdn.test'],
    });

    expect(options.confirmHosts).toEqual(['api.dev.example.com', 'other.test']);
    expect(options.allowHosts).toEqual(['*.fonts.example.com', 'cdn.test']);
  });

  test.each([
    ['--confirm-host', 'https://api.example.com'],
    ['--confirm-host', 'api.example.com:8080'],
    ['--confirm-host', 'api.example.com/graphql'],
    ['--confirm-host', '*.example.com'],
    ['--confirm-host', '  '],
    ['--confirm-host', 'a.test,b.test'],
    ['--allow-host', 'https://fonts.example.com'],
    ['--allow-host', 'cdn.*.example.com'],
    ['--allow-host', 'cdn.test,fonts.test'],
  ])('rejects %s %o, which is not a host name', (flag, value) => {
    const flags = flag === '--allow-host' ? { allowHost: [value] } : { confirmHost: [value] };
    const error = lookoverErrorOf(() => parseRunFlags(flags));

    expect(error.code).toBe('E_USAGE');
    expect(error.message).toContain(flag);
  });

  test('names a comma-joined value and hints at repeating the flag', () => {
    const error = lookoverErrorOf(() => parseRunFlags({ confirmHost: ['a.test, b.test'] }));

    expect(error.message).toBe('--confirm-host "a.test, b.test" is not a host name: the flag takes one host');
    expect(error.hint).toBe('Repeat the flag once per host: --confirm-host a.test --confirm-host b.test');
  });

  test('accepts an IPv6 host', () => {
    expect(parseRunFlags({ confirmHost: ['[fd00::1]'] }).confirmHosts).toEqual(['fd00::1']);
  });

  test('parses --max-screens as a positive integer', () => {
    expect(parseRunFlags({ maxScreens: '12' }).maxScreens).toBe(12);
  });

  test.each(['0', '-1', '1.5', 'twelve', '', '12abc'])('rejects --max-screens %o', (value) => {
    const error = lookoverErrorOf(() => parseRunFlags({ maxScreens: value }));

    expect(error.code).toBe('E_USAGE');
    expect(error.message).toContain('--max-screens');
  });

  test('--headed and --yes are passed through', () => {
    expect(parseRunFlags({ headed: true, yes: true })).toMatchObject({ isHeaded: true, isYes: true });
  });
});

describe('configForRun', () => {
  test('adds --allow-host and --confirm-host to the config for this run and overrides maxScreens', () => {
    const config: LookoverConfig = {
      ...BASE_CONFIG,
      allowHosts: ['cdn.test'],
      confirmedBackendHosts: ['API.dev.example.com'],
    };
    const options = parseRunFlags({
      allowHost: ['fonts.test', 'cdn.test'],
      confirmHost: ['api.dev.example.com', 'auth.dev.example.com'],
      maxScreens: '5',
    });

    const result = configForRun(config, options);

    expect(result.allowHosts).toEqual(['cdn.test', 'fonts.test']);
    expect(result.confirmedBackendHosts).toEqual(['API.dev.example.com', 'auth.dev.example.com']);
    expect(result.maxScreens).toBe(5);
  });

  test('leaves the loaded config untouched', () => {
    const config: LookoverConfig = { ...BASE_CONFIG, allowHosts: ['cdn.test'] };
    const snapshot = structuredClone(config);

    configForRun(config, parseRunFlags({ allowHost: ['fonts.test'], maxScreens: '3' }));

    expect(config).toEqual(snapshot);
  });

  test('without flags the run uses the config as it is', () => {
    expect(configForRun(BASE_CONFIG, parseRunFlags({}))).toEqual(BASE_CONFIG);
  });
});

describe('mergeHosts', () => {
  test('keeps the first spelling of each host, in order', () => {
    expect(mergeHosts(['API.test', 'b.test'], ['api.test', 'c.test'], ['c.test.', 'd.test'])).toEqual([
      'API.test',
      'b.test',
      'c.test',
      'd.test',
    ]);
  });
});

describe('saveConfirmedHosts', () => {
  let dir: string;
  const configPath = () => join(dir, 'lookover.config.json');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lookover-run-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('adds the new hosts to confirmedBackendHosts and keeps everything else', async () => {
    const config: LookoverConfig = {
      ...BASE_CONFIG,
      allowHosts: ['cdn.test'],
      confirmedBackendHosts: ['a.test'],
    };
    await writeConfig(dir, config);

    const added = await saveConfirmedHosts(dir, config, ['a.test', 'b.test', 'B.test']);

    expect(added).toEqual(['b.test']);
    const saved = JSON.parse(await readFile(configPath(), 'utf8')) as unknown;
    expect(saved).toEqual({ ...config, confirmedBackendHosts: ['a.test', 'b.test'] });
    expect(configSchema.parse(saved)).toEqual({ ...config, confirmedBackendHosts: ['a.test', 'b.test'] });
  });

  test('changes only confirmedBackendHosts, keeping unknown keys and filling in no defaults', async () => {
    const raw = {
      $schema: 'https://example.com/lookover.schema.json',
      baseUrl: 'http://localhost:3000',
      interaction: 'safe',
      allowHosts: ['cdn.test'],
      custom: { note: 'kept' },
    };
    await writeFile(configPath(), JSON.stringify(raw), 'utf8');
    const config = configSchema.parse(raw);

    const added = await saveConfirmedHosts(dir, config, ['b.test']);

    expect(added).toEqual(['b.test']);
    const text = await readFile(configPath(), 'utf8');
    expect(text).toBe(`${JSON.stringify({ ...raw, confirmedBackendHosts: ['b.test'] }, null, 2)}\n`);
    expect(await readdir(dir)).toEqual(['lookover.config.json']);
  });

  test('appends to the hosts the file lists, keeping their spelling and their place', async () => {
    const raw = { baseUrl: 'http://localhost:3000', confirmedBackendHosts: ['A.test'], interaction: 'safe' };
    await writeFile(configPath(), JSON.stringify(raw), 'utf8');

    const added = await saveConfirmedHosts(dir, configSchema.parse(raw), ['a.test', 'b.test']);

    expect(added).toEqual(['b.test']);
    const saved = JSON.parse(await readFile(configPath(), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(saved)).toEqual(['baseUrl', 'confirmedBackendHosts', 'interaction']);
    expect(saved.confirmedBackendHosts).toEqual(['A.test', 'b.test']);
  });

  test.each([
    ['is no longer valid JSON', '{ "baseUrl": '],
    ['no longer holds a JSON object', '[]'],
    ['has a confirmedBackendHosts that is not a list of host names', '{ "confirmedBackendHosts": "a.test" }'],
  ])('refuses with E_CONFIG_INVALID, leaving the file alone, when it %s', async (problem, content) => {
    await writeFile(configPath(), content, 'utf8');

    const saving = saveConfirmedHosts(dir, BASE_CONFIG, ['b.test']);

    await expect(saving).rejects.toMatchObject({
      code: 'E_CONFIG_INVALID',
      message: `Could not save the confirmed backend hosts: lookover.config.json ${problem}`,
    });
    expect(await readFile(configPath(), 'utf8')).toBe(content);
  });

  test("writes back with the file's own indentation", async () => {
    const raw = { baseUrl: 'http://localhost:3000', interaction: 'safe' };
    await writeFile(configPath(), `${JSON.stringify(raw, null, 4)}\n`, 'utf8');

    await saveConfirmedHosts(dir, configSchema.parse(raw), ['b.test']);

    const expected = { ...raw, confirmedBackendHosts: ['b.test'] };
    expect(await readFile(configPath(), 'utf8')).toBe(`${JSON.stringify(expected, null, 4)}\n`);
  });

  test.skipIf(process.platform === 'win32')('keeps the mode of the config file', async () => {
    const raw = { baseUrl: 'http://localhost:3000', interaction: 'safe' };
    await writeFile(configPath(), JSON.stringify(raw), 'utf8');
    await chmod(configPath(), PRIVATE_FILE_MODE);

    await saveConfirmedHosts(dir, configSchema.parse(raw), ['b.test']);

    expect((await stat(configPath())).mode & PERMISSION_BITS).toBe(PRIVATE_FILE_MODE);
  });

  test('does not rewrite the file when every host is already there', async () => {
    const config: LookoverConfig = { ...BASE_CONFIG, confirmedBackendHosts: ['a.test'] };
    await writeFile(configPath(), 'left alone', 'utf8');
    const before = await stat(configPath());

    const added = await saveConfirmedHosts(dir, config, ['A.test']);

    expect(added).toEqual([]);
    expect(await readFile(configPath(), 'utf8')).toBe('left alone');
    expect((await stat(configPath())).mtimeMs).toBe(before.mtimeMs);
  });
});

describe('progressLine', () => {
  test('names the route with its element and form counts', () => {
    const edit = screen({
      route: '/organisations/[id]',
      elements: Array.from({ length: 18 }, (_, index) => element(`e${index}`)),
      forms: [form('form')],
    });

    expect(progressLine(edit)).toBe('✓ /organisations/[id]  18 elements · 1 form');
  });

  test('uses the singular for one element and the plural for no forms', () => {
    expect(progressLine(screen({ elements: [element('only')] }))).toBe('✓ /  1 element · 0 forms');
  });

  test('shows where a redirected screen landed, after the path that was requested', () => {
    const redirected = screen({
      url: 'http://localhost:3000/home.html?tab=2',
      route: '/home.html',
      redirectedFrom: 'http://localhost:3000/',
      elements: [element('a'), element('b'), element('c')],
    });

    expect(progressLine(redirected)).toBe('✓ /  → /home.html  3 elements · 0 forms');
  });

  test('flags a screen whose navigation failed', () => {
    const failed = screen({
      route: '/reports',
      title: '(navigation failed: net::ERR_ABORTED)',
      status: 'navigation-failed',
      error: 'net::ERR_ABORTED',
    });

    expect(progressLine(failed)).toBe('! /reports  navigation failed');
  });

  test('goes by the status, not the title', () => {
    const titledLikeAFailure = screen({ route: '/help', title: '(navigation failed: how to fix it)' });

    expect(progressLine(titledLikeAFailure)).toBe('✓ /help  0 elements · 0 forms');
  });
});

describe('summaryRows', () => {
  const summary = {
    cwd: '/work/app',
    map: appMap([
      screen({ elements: [element('a'), element('b')], forms: [form('f1')] }),
      screen({ elements: [element('c')], forms: [form('f2'), form('f3')] }),
    ]),
    confirmedBackendHosts: ['api.dev.example.com', 'auth.dev.example.com'],
    blockedRequests: 3,
    runDir: '/work/app/.lookover/runs/20261021-101500-ab12',
    appMapPath: '/work/app/.lookover/app-map.json',
    durationMs: 42_345,
  };

  test('totals the map and shows paths relative to the project', () => {
    expect(summaryRows(summary)).toEqual([
      ['Screens', '2'],
      ['Elements', '3'],
      ['Forms', '3'],
      ['Backend hosts', 'api.dev.example.com, auth.dev.example.com'],
      ['Blocked requests', '3'],
      ['Run dir', '.lookover/runs/20261021-101500-ab12'],
      ['App map', '.lookover/app-map.json'],
      ['Duration', '42.3 s'],
    ]);
  });

  test('says none when no backend host is confirmed', () => {
    const rows = summaryRows({ ...summary, confirmedBackendHosts: [] });

    expect(rows).toContainEqual(['Backend hosts', 'none']);
  });
});

describe('formatDuration', () => {
  test.each([
    [1_234, '1.2 s'],
    [59_940, '59.9 s'],
    [59_960, '1 min 0 s'],
    [125_400, '2 min 5 s'],
  ])('%d ms is %o', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('blockedHostsWarning', () => {
  test('names the blocked hosts and the command that confirms them', () => {
    const warning = blockedHostsWarning(['a.dev.test', 'b.dev.test']);

    expect(warning).toContain('a.dev.test, b.dev.test');
    expect(warning).toContain('lookover run --confirm-host a.dev.test --confirm-host b.dev.test');
  });
});

describe('lookover run', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lookover-run-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('exits 2 with E_CONFIG_NOT_FOUND when there is no lookover.config.json', async () => {
    const result = await runCli(dir, ['run']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('E_CONFIG_NOT_FOUND');
    expect(result.stderr).toContain('lookover init');
  });

  test('refuses a full-interaction config without the acknowledgement with exit 3', async () => {
    await writeFile(
      join(dir, 'lookover.config.json'),
      JSON.stringify({ baseUrl: 'http://localhost:3000', interaction: 'full' }),
    );

    const result = await runCli(dir, ['run', '--yes']);

    expect(result.code).toBe(3);
    expect(result.stderr).toContain('E_ACK_REQUIRED');
  });

  test('exits 2 with E_USAGE, not E_CONFIG_INVALID, on an invalid --max-screens before reading the config', async () => {
    const result = await runCli(dir, ['run', '--max-screens', '0']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('E_USAGE');
    expect(result.stderr).not.toContain('E_CONFIG_INVALID');
    expect(result.stderr).toContain('--max-screens');
  });

  test('exits 2 with E_USAGE on a --confirm-host that is a URL', async () => {
    const result = await runCli(dir, ['run', '--confirm-host', 'https://api.example.com']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('E_USAGE');
    expect(result.stderr).toContain('--confirm-host');
  });

  test('exits 2 with E_USAGE on a comma-joined --confirm-host, naming the value', async () => {
    const result = await runCli(dir, ['run', '--confirm-host', 'a.test,b.test']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('E_USAGE');
    expect(result.stderr).toContain('--confirm-host "a.test,b.test" is not a host name');
    expect(result.stderr).toContain('--confirm-host a.test --confirm-host b.test');
  });
});

describe('lookover run in a browser', () => {
  /** Loopback addresses that are not `127.0.0.1`, so the network policy treats them as other hosts. */
  const ASSET_HOST = '127.0.0.2';
  const API_HOST = '127.0.0.3';
  const BROWSER_RUN_TIMEOUT_MS = 60_000;
  let dir: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lookover-run-browser-'));
    // The page loads an image from one host and calls another; neither request needs an answer, and
    // the image starts after the load event, so a host that never answers cannot hold the page up.
    server = createServer((_req, res) => {
      const port = (server.address() as AddressInfo).port;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><title>App</title><script>' +
          `fetch('http://${API_HOST}:${port}/api', { mode: 'no-cors' }).catch(() => undefined);` +
          `addEventListener('load', () => { new Image().src = 'http://${ASSET_HOST}:${port}/logo.png'; });` +
          '</script>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  });

  test(
    'labels the host the app only loaded static assets from when it refuses the run',
    async () => {
      await writeFile(
        join(dir, 'lookover.config.json'),
        JSON.stringify({ baseUrl, interaction: 'safe', framework: 'unknown' }),
      );

      const result = await runCli(dir, ['run', '--yes'], { timeoutMs: BROWSER_RUN_TIMEOUT_MS });

      expect(result.code, result.stderr).toBe(3);
      expect(result.stderr).toContain('E_HOSTS_UNCONFIRMED');
      const lines = result.stderr.split('\n');
      expect(lines).toContain(`  ${ASSET_HOST} (static assets — consider allowHosts)`);
      expect(lines).toContain(`  ${API_HOST}`);
    },
    BROWSER_RUN_TIMEOUT_MS,
  );
});
