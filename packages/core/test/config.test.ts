import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  assertAcknowledged,
  CONFIG_FILENAME,
  detectIndent,
  loadConfig,
  writeConfig,
} from '../src/config/load.js';
import { configSchema } from '../src/config/schema.js';

const PERMISSION_BITS = 0o777;
const PRIVATE_FILE_MODE = 0o600;

describe('config', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lookover-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(raw: unknown): Promise<void> {
    await writeFile(join(dir, CONFIG_FILENAME), JSON.stringify(raw), 'utf8');
  }

  test('applies defaults to a minimal safe-mode config', async () => {
    await write({ baseUrl: 'http://localhost:3000', interaction: 'safe' });
    const { config } = await loadConfig(dir);
    expect(config.maxScreens).toBe(40);
    expect(config.viewports).toEqual([
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ]);
    expect(config.auth).toEqual({ type: 'none' });
    expect(config.model.judge).toBe('claude-sonnet-5-5');
  });

  test('gives each parse its own default viewports, so changing one config cannot change another', () => {
    const minimal = { baseUrl: 'http://localhost:3000', interaction: 'safe' };

    const first = configSchema.parse(minimal);
    const second = configSchema.parse(minimal);

    expect(second.viewports).toEqual(first.viewports);
    expect(second.viewports).not.toBe(first.viewports);
    expect(second.viewports[0]).not.toBe(first.viewports[0]);
  });

  test('refuses full interaction without the disposable-data acknowledgement', async () => {
    await write({ baseUrl: 'http://localhost:3000', interaction: 'full' });
    await expect(loadConfig(dir)).rejects.toMatchObject({ code: 'E_ACK_REQUIRED' });
  });

  test('accepts full interaction with the acknowledgement', async () => {
    await write({
      baseUrl: 'http://localhost:3000',
      interaction: 'full',
      acknowledgement: { disposableData: true, acknowledgedAt: '2026-10-20T10:00:00.000Z' },
    });
    await expect(loadConfig(dir)).resolves.toBeTruthy();
  });

  test('reports every invalid field', async () => {
    await write({ baseUrl: 'not a url', interaction: 'loud', maxScreens: -1 });
    await expect(loadConfig(dir)).rejects.toMatchObject({
      code: 'E_CONFIG_INVALID',
      message: expect.stringMatching(/baseUrl[\s\S]*interaction[\s\S]*maxScreens/),
    });
  });

  test('rejects a config file that is not valid JSON', async () => {
    await writeFile(join(dir, CONFIG_FILENAME), '{ not json', 'utf8');
    await expect(loadConfig(dir)).rejects.toMatchObject({ code: 'E_CONFIG_INVALID' });
  });

  test('missing file', async () => {
    await expect(loadConfig(dir)).rejects.toMatchObject({ code: 'E_CONFIG_NOT_FOUND' });
  });

  test('form auth defaults the env var names', async () => {
    await write({
      baseUrl: 'http://localhost:3000',
      interaction: 'safe',
      auth: {
        type: 'form',
        loginUrl: '/login',
        usernameSelector: '#u',
        passwordSelector: '#p',
        submitSelector: 'button',
        successUrl: '/',
      },
    });
    const { config } = await loadConfig(dir);
    expect(config.auth).toMatchObject({ usernameEnv: 'LOOKOVER_USERNAME', passwordEnv: 'LOOKOVER_PASSWORD' });
  });

  test('a storage state may name its login page, and need not', async () => {
    const parse = (auth: unknown) =>
      configSchema.parse({ baseUrl: 'http://localhost:3000', interaction: 'safe', auth }).auth;

    expect(parse({ type: 'storageState', path: 's.json', loginUrl: '/login' })).toEqual({
      type: 'storageState',
      path: 's.json',
      loginUrl: '/login',
    });
    expect(parse({ type: 'storageState', path: 's.json' })).toEqual({ type: 'storageState', path: 's.json' });
  });

  test('writeConfig round-trips', async () => {
    const cfg = configSchema.parse({ baseUrl: 'http://localhost:3000', interaction: 'safe' });
    const p = await writeConfig(dir, cfg);
    const loaded = await loadConfig(dir);
    expect(loaded.path).toBe(p);
    expect(loaded.config).toEqual(cfg);
  });

  test('writeConfig emits 2-space JSON with a trailing newline', async () => {
    const cfg = configSchema.parse({ baseUrl: 'http://localhost:3000', interaction: 'safe' });
    const p = await writeConfig(dir, cfg);
    const text = await readFile(p, 'utf8');
    expect(text).toBe(`${JSON.stringify(cfg, null, 2)}\n`);
  });

  test.skipIf(process.platform === 'win32')(
    'writeConfig keeps a four-space file four-spaced and 0600',
    async () => {
      const cfg = configSchema.parse({ baseUrl: 'http://localhost:3000', interaction: 'safe' });
      const path = join(dir, CONFIG_FILENAME);
      await writeFile(path, '{\n    "baseUrl": "http://localhost:3000"\n}\n', 'utf8');
      await chmod(path, PRIVATE_FILE_MODE);

      await writeConfig(dir, cfg);

      expect(await readFile(path, 'utf8')).toBe(`${JSON.stringify(cfg, null, 4)}\n`);
      expect((await stat(path)).mode & PERMISSION_BITS).toBe(PRIVATE_FILE_MODE);
    },
  );

  test('writeConfig keeps a tab-indented file tab-indented', async () => {
    const cfg = configSchema.parse({ baseUrl: 'http://localhost:3000', interaction: 'safe' });
    const path = join(dir, CONFIG_FILENAME);
    await writeFile(path, '{\n\t"baseUrl": "http://localhost:3000"\n}\n', 'utf8');

    await writeConfig(dir, cfg);

    expect(await readFile(path, 'utf8')).toBe(`${JSON.stringify(cfg, null, '\t')}\n`);
  });
});

describe('detectIndent', () => {
  test('reads four spaces, a tab, and defaults to two spaces', () => {
    expect(detectIndent('{\n    "a": 1\n}')).toBe('    ');
    expect(detectIndent('{\n\t"a": 1\n}')).toBe('\t');
    expect(detectIndent('{}')).toBe('  ');
  });

  test('is decided by the first indented line, not by a deeper one', () => {
    expect(detectIndent('{\n   "a": {\n         "b": 1\n   }\n}')).toBe('   ');
  });

  test('skips a blank line that only holds whitespace', () => {
    expect(detectIndent('{\n    \n\t"a": 1\n}')).toBe('\t');
  });
});

describe('assertAcknowledged', () => {
  const acknowledgement = { disposableData: true, acknowledgedAt: '2026-10-20T10:00:00.000Z' } as const;

  test('refuses full interaction without the acknowledgement, naming how to give it', () => {
    expect(() => assertAcknowledged({ interaction: 'full' })).toThrow(
      expect.objectContaining({ code: 'E_ACK_REQUIRED', hint: expect.stringContaining('lookover init') }),
    );
  });

  test('lets full interaction with the acknowledgement, and safe interaction, through', () => {
    expect(() => assertAcknowledged({ interaction: 'full', acknowledgement })).not.toThrow();
    expect(() => assertAcknowledged({ interaction: 'safe' })).not.toThrow();
  });
});
