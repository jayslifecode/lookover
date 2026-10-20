import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CONFIG_FILENAME, loadConfig, writeConfig } from '../src/config/load.js';
import { configSchema } from '../src/config/schema.js';

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
});
