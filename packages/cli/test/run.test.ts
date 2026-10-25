import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type LookoverConfig, LookoverError, writeConfig } from '@jayslifecode/lookover-core';
import { InteractionLens } from '@jayslifecode/lookover-lenses';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  collectRepeated,
  configForRun,
  createLens,
  JUDGE_FLAG_HELP,
  LENS_FLAG_HELP,
  mergeHosts,
  parseRunFlags,
  saveConfirmedHosts,
} from '../src/commands/run-options.js';
import { runCli } from './run-cli.js';

const PERMISSION_BITS = 0o777;
const PRIVATE_FILE_MODE = 0o600;

const BASE_CONFIG: LookoverConfig = configSchema.parse({
  baseUrl: 'http://localhost:3000',
  interaction: 'safe',
});

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
  test('defaults to headless, the configured screen budget, no extra hosts, prompting, the interaction lens, the configured judge and the report', () => {
    expect(parseRunFlags({})).toEqual({
      isHeaded: false,
      maxScreens: undefined,
      allowHosts: [],
      confirmHosts: [],
      isYes: false,
      isMapOnly: false,
      lenses: ['interaction'],
      isJudged: true,
      judgeModel: undefined,
      shouldReport: true,
      shouldOpen: true,
    });
  });

  test('--no-judge, --no-report and --no-open are passed through', () => {
    expect(parseRunFlags({ judge: false, report: false, open: false })).toMatchObject({
      isJudged: false,
      shouldReport: false,
      shouldOpen: false,
    });
  });

  test('--judge-model names the model, trimmed', () => {
    expect(parseRunFlags({ judgeModel: ' claude-opus-5-5 ' }).judgeModel).toBe('claude-opus-5-5');
  });

  test.each(['', '   '])('rejects --judge-model %o', (value) => {
    const error = lookoverErrorOf(() => parseRunFlags({ judgeModel: value }));

    expect(error.code).toBe('E_USAGE');
    expect(error.message).toBe('--judge-model is empty');
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

  test('--map-only is passed through', () => {
    expect(parseRunFlags({ mapOnly: true }).isMapOnly).toBe(true);
  });

  test('--lens interaction names the interaction lens once, however often it is repeated', () => {
    expect(parseRunFlags({ lens: ['interaction'] }).lenses).toEqual(['interaction']);
    expect(parseRunFlags({ lens: ['interaction', ' interaction '] }).lenses).toEqual(['interaction']);
  });

  test.each(['nope', 'consistency', 'behaviour', '', 'constructor'])(
    'rejects --lens %o, naming the lenses there are',
    (value) => {
      const error = lookoverErrorOf(() => parseRunFlags({ lens: ['interaction', value] }));

      expect(error.code).toBe('E_USAGE');
      expect(error.message).toBe(`--lens "${value}" is not a lens`);
      expect(error.hint).toBe('Available lenses: interaction');
    },
  );
});

describe('createLens', () => {
  test('creates the interaction lens', () => {
    expect(createLens('interaction')).toBeInstanceOf(InteractionLens);
  });

  test('creates a new lens on every call', () => {
    expect(createLens('interaction')).not.toBe(createLens('interaction'));
  });

  test('refuses a lens that is not available yet with E_USAGE', () => {
    const error = lookoverErrorOf(() => createLens('consistency'));

    expect(error.code).toBe('E_USAGE');
    expect(error.hint).toBe('Available lenses: interaction');
  });
});

describe('LENS_FLAG_HELP', () => {
  test('names the lenses --lens takes and the default, from the list the error hint names', () => {
    expect(LENS_FLAG_HELP).toBe(
      'inspect each screen with this lens (repeatable; available: interaction; default: interaction)',
    );
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

describe('lookover run', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lookover-run-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('--help describes --no-judge, --judge-model, --no-report and --no-open', async () => {
    const result = await runCli(dir, ['run', '--help']);

    expect(result.code).toBe(0);
    const help = result.stdout.replace(/\s+/g, ' ');
    expect(help).toContain(`--no-judge ${JUDGE_FLAG_HELP.noJudge}`);
    expect(help).toContain(`--judge-model <id> ${JUDGE_FLAG_HELP.judgeModel}`);
    expect(help).toContain(`--no-report ${JUDGE_FLAG_HELP.noReport}`);
    expect(help).toContain(`--no-open ${JUDGE_FLAG_HELP.noOpen}`);
  });

  test('exits 2 with E_USAGE on an empty --judge-model, before reading the config', async () => {
    const result = await runCli(dir, ['run', '--judge-model', ' ']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('E_USAGE');
    expect(result.stderr).toContain('--judge-model is empty');
    expect(result.stderr).not.toContain('E_CONFIG_NOT_FOUND');
  });

  test('--help describes --lens with the lenses there are', async () => {
    const result = await runCli(dir, ['run', '--help']);

    expect(result.code).toBe(0);
    expect(result.stdout.replace(/\s+/g, ' ')).toContain(LENS_FLAG_HELP);
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

  test('exits 2 with E_USAGE and the available lenses on an unknown --lens, before reading the config', async () => {
    const result = await runCli(dir, ['run', '--lens', 'nope']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('E_USAGE');
    expect(result.stderr).toContain('--lens "nope" is not a lens');
    expect(result.stderr).toContain('Available lenses: interaction');
    expect(result.stderr).not.toContain('E_CONFIG_NOT_FOUND');
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

      // A real run: without the key, it can never reach the judge model, whatever it gets to. Without
      // the report either, which would open in the browser of the machine the test runs on.
      const result = await runCli(dir, ['run', '--yes', '--no-report'], {
        timeoutMs: BROWSER_RUN_TIMEOUT_MS,
        withoutEnv: ['ANTHROPIC_API_KEY'],
      });

      expect(result.code, result.stderr).toBe(3);
      expect(result.stderr).toContain('E_HOSTS_UNCONFIRMED');
      const lines = result.stderr.split('\n');
      expect(lines).toContain(`  ${ASSET_HOST} (static assets — consider allowHosts)`);
      expect(lines).toContain(`  ${API_HOST}`);
    },
    BROWSER_RUN_TIMEOUT_MS,
  );
});
