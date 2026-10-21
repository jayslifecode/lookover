import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LookoverError } from '@jayslifecode/lookover-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildConfig, type InitAnswers } from '../src/commands/init-config.js';
import { ACKNOWLEDGEMENT_LINES } from '../src/commands/init-prompts.js';
import { runCli } from './run-cli.js';

const BASE_URL = 'http://localhost:3000';
const ACK_FLAGS = ['--non-interactive', '--base-url', BASE_URL, '--interaction', 'full'];

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

describe('lookover init', () => {
  let dir: string;
  const configPath = () => join(dir, 'lookover.config.json');
  const gitignorePath = () => join(dir, '.gitignore');
  const writePackageJson = (dependencies: Record<string, string>) =>
    writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'sample', dependencies }));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lookover-init-'));
    await writePackageJson({ next: '^16.0.0', react: '^19.0.0' });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('writes full interaction with the acknowledgement, detects next and ignores .lookover/', async () => {
    const result = await runCli(dir, ['init', ...ACK_FLAGS, '--acknowledge-disposable-data']);

    expect(result.code).toBe(0);
    const config = await readJson(configPath());
    expect(config).toMatchObject({
      baseUrl: BASE_URL,
      framework: 'next',
      interaction: 'full',
      acknowledgement: { disposableData: true },
    });
    const acknowledgement = config.acknowledgement as { acknowledgedAt: string; by?: string };
    expect(new Date(acknowledgement.acknowledgedAt).toISOString()).toBe(acknowledgement.acknowledgedAt);
    expect((await readFile(gitignorePath(), 'utf8')).split('\n')).toContain('.lookover/');
  });

  test('refuses full interaction without the acknowledgement flag and leaves nothing on disk', async () => {
    const result = await runCli(dir, ['init', ...ACK_FLAGS]);

    expect(result.code).toBe(3);
    expect(result.stderr).toContain('E_ACK_REQUIRED');
    expect(result.stderr).toContain('--acknowledge-disposable-data');
    expect(existsSync(configPath())).toBe(false);
    expect(existsSync(gitignorePath())).toBe(false);
  });

  test('writes safe interaction without an acknowledgement', async () => {
    const result = await runCli(dir, [
      'init',
      '--non-interactive',
      '--base-url',
      BASE_URL,
      '--interaction',
      'safe',
    ]);

    expect(result.code).toBe(0);
    const config = await readJson(configPath());
    expect(config.interaction).toBe('safe');
    expect(config).not.toHaveProperty('acknowledgement');
  });

  test('defaults to safe interaction when --interaction is omitted', async () => {
    const result = await runCli(dir, ['init', '--non-interactive', '--base-url', BASE_URL]);

    expect(result.code).toBe(0);
    const config = await readJson(configPath());
    expect(config.interaction).toBe('safe');
    expect(config).not.toHaveProperty('acknowledgement');
  });

  test('does not duplicate the .gitignore line when run twice', async () => {
    const args = ['init', ...ACK_FLAGS, '--acknowledge-disposable-data'];
    await runCli(dir, args);
    const second = await runCli(dir, args);

    expect(second.code).toBe(0);
    const lines = (await readFile(gitignorePath(), 'utf8'))
      .split('\n')
      .filter((line) => line === '.lookover/');
    expect(lines).toHaveLength(1);
  });

  test('appends to an existing .gitignore that has no trailing newline', async () => {
    await writeFile(gitignorePath(), 'node_modules');

    await runCli(dir, ['init', '--non-interactive', '--base-url', BASE_URL]);

    expect(await readFile(gitignorePath(), 'utf8')).toBe('node_modules\n.lookover/\n');
  });

  test('leaves a .gitignore alone when it already ignores .lookover without the slash', async () => {
    await writeFile(gitignorePath(), 'dist\n  .lookover  \n');

    await runCli(dir, ['init', '--non-interactive', '--base-url', BASE_URL]);

    expect(await readFile(gitignorePath(), 'utf8')).toBe('dist\n  .lookover  \n');
  });

  test('detects vite-react from package.json', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { react: '^19.0.0' }, devDependencies: { vite: '^7.0.0' } }),
    );

    await runCli(dir, ['init', '--non-interactive', '--base-url', BASE_URL]);

    expect((await readJson(configPath())).framework).toBe('vite-react');
  });

  test('falls back to unknown when there is no package.json', async () => {
    await rm(join(dir, 'package.json'));

    const result = await runCli(dir, ['init', '--non-interactive', '--base-url', BASE_URL]);

    expect(result.code).toBe(0);
    expect((await readJson(configPath())).framework).toBe('unknown');
  });

  test('--framework overrides auto-detection', async () => {
    const result = await runCli(dir, [
      'init',
      '--non-interactive',
      '--base-url',
      BASE_URL,
      '--framework',
      'vite-react',
    ]);

    expect(result.code).toBe(0);
    expect((await readJson(configPath())).framework).toBe('vite-react');
  });

  test('--root points detection at another directory and is stored in the config', async () => {
    await rm(join(dir, 'package.json'));
    await mkdir(join(dir, 'web'));
    await writeFile(
      join(dir, 'web', 'package.json'),
      JSON.stringify({ devDependencies: { next: '^16.0.0' } }),
    );

    await runCli(dir, ['init', '--non-interactive', '--base-url', BASE_URL, '--root', 'web']);

    const config = await readJson(configPath());
    expect(config.framework).toBe('next');
    expect(config.root).toBe('web');
  });

  test('--non-interactive without --base-url exits 2 and names the flag', async () => {
    const result = await runCli(dir, ['init', '--non-interactive']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('E_USAGE');
    expect(result.stderr).toContain('--base-url');
    expect(existsSync(configPath())).toBe(false);
  });

  test('rejects a --base-url that is not an http(s) URL with exit 2', async () => {
    const result = await runCli(dir, ['init', '--non-interactive', '--base-url', 'ftp://example.com']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('E_USAGE');
    expect(result.stderr).toContain('--base-url');
    expect(existsSync(configPath())).toBe(false);
  });

  test('rejects an unknown --interaction value with exit 2', async () => {
    const result = await runCli(dir, [
      'init',
      '--non-interactive',
      '--base-url',
      BASE_URL,
      '--interaction',
      'reckless',
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('E_USAGE');
    expect(result.stderr).toContain('--interaction');
    expect(existsSync(configPath())).toBe(false);
  });

  test('rejects an unknown --framework value with exit 2', async () => {
    const result = await runCli(dir, [
      'init',
      '--non-interactive',
      '--base-url',
      BASE_URL,
      '--framework',
      'angular',
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('E_USAGE');
    expect(result.stderr).toContain('--framework');
    expect(existsSync(configPath())).toBe(false);
  });

  test('exits 2 instead of prompting when there is no terminal and --non-interactive is missing', async () => {
    const result = await runCli(dir, ['init', '--base-url', BASE_URL]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('E_USAGE');
    expect(result.stderr).toContain('--non-interactive');
    expect(existsSync(configPath())).toBe(false);
  });
});

describe('acknowledgement copy', () => {
  test('is the exact wording the safety switch promises', () => {
    expect(ACKNOWLEDGEMENT_LINES).toEqual([
      'Lookover will click anything and submit any form in this app, including actions that delete or change data.',
      'Is every piece of data this app can reach disposable — a local or development database you can recreate?',
    ]);
  });
});

describe('buildConfig', () => {
  const answers = (overrides: Partial<InitAnswers>): InitAnswers => ({
    baseUrl: BASE_URL,
    framework: 'next',
    interaction: 'safe',
    acknowledgedDisposableData: false,
    ...overrides,
  });

  test('refuses full interaction without the acknowledgement, hinting at the init flag', () => {
    const build = () => buildConfig(answers({ interaction: 'full' }), '.');

    expect(build).toThrow(LookoverError);
    expect(build).toThrow(
      expect.objectContaining({
        code: 'E_ACK_REQUIRED',
        hint: expect.stringContaining('--acknowledge-disposable-data'),
      }),
    );
  });

  test('records the acknowledgement for full interaction when it was given', () => {
    const config = buildConfig(answers({ interaction: 'full', acknowledgedDisposableData: true }), '.');

    expect(config.acknowledgement).toMatchObject({
      disposableData: true,
      acknowledgedAt: expect.any(String),
    });
  });

  test('records no acknowledgement for safe interaction', () => {
    const config = buildConfig(answers({ interaction: 'safe', acknowledgedDisposableData: true }), '.');

    expect(config).not.toHaveProperty('acknowledgement');
  });
});
