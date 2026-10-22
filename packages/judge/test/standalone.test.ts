import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactDeep, type StepFinding } from '@jayslifecode/lookover-core';
import { InteractionLens } from '@jayslifecode/lookover-lenses';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { generateStandaloneScript, MAX_BUNDLE_BYTES } from '../src/index.js';
import { inspectPage, stepFindingOf } from './helpers/inspect.js';
import { openTestBed, type TestBed } from './helpers/session.js';
import { linkPlaywright, pinnedPlaywright, runNode } from './helpers/standalone.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));
const BROWSER_TIMEOUT_MS = 120_000;
const FOCUS_VISIBLE = 'interaction.focus-visible-missing';
/** Nothing listens here: a script that defaults to it reproduces nothing unless LOOKOVER_BASE_URL says otherwise. */
const DEAD_ORIGIN = 'http://127.0.0.1:1';
const REPRODUCED_ONCE = /^reproduced 1\/1$/m;

describe('the standalone script', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let bed: TestBed;
  let finding: StepFinding;
  let dir: string;
  let script: string;
  let scriptPath: string;
  let elsewherePath: string;

  beforeAll(async () => {
    bed = await openTestBed(FIXTURE_DIR);
    finding = stepFindingOf(await inspectPage(bed, new InteractionLens(), '/controls.html'), FOCUS_VISIBLE);
    dir = await mkdtemp(join(tmpdir(), 'lookover-standalone-'));
    await linkPlaywright(dir);
    script = generateStandaloneScript(finding, { baseUrl: bed.url });
    scriptPath = join(dir, `${finding.id}.mjs`);
    await writeFile(scriptPath, script);
    elsewherePath = join(dir, 'elsewhere.mjs');
    await writeFile(elsewherePath, generateStandaloneScript(finding, { baseUrl: DEAD_ORIGIN }));
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await bed?.close();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }, BROWSER_TIMEOUT_MS);

  test('stays under the byte limit', () => {
    expect(Buffer.byteLength(script, 'utf8')).toBeLessThan(MAX_BUNDLE_BYTES);
  });

  test('embeds the finding as stored, redacted', () => {
    expect(script).toContain(`\nconst finding = ${JSON.stringify(redactDeep(finding), null, 2)};\n`);
  });

  test('opens with a comment on what it is, what it needs, how to run it and its variables', async () => {
    const header = script.split('\nconst finding = ')[0] ?? '';

    expect(header.split('\n').every((line) => line.startsWith('//'))).toBe(true);
    expect(header).toContain(finding.id);
    expect(header).toContain(FOCUS_VISIBLE);
    expect(header).toContain(`npm i playwright@${await pinnedPlaywright()}`);
    expect(header).toContain('npx playwright install chromium');
    expect(header).toContain('node <this file>');
    for (const name of ['LOOKOVER_BASE_URL', 'HEADED=1', 'TIMES', 'STORAGE_STATE']) {
      expect(header).toContain(name);
    }
  });

  test('ends by calling main with the base URL, the window and the count from the environment', () => {
    expect(script.trimEnd().split('\n').at(-1)).toBe(
      `await main(finding, { baseUrl: process.env.LOOKOVER_BASE_URL ?? ${JSON.stringify(bed.url)}, ` +
        "headless: process.env.HEADED !== '1', times: Number(process.env.TIMES ?? 1), " +
        'storageState: process.env.STORAGE_STATE });',
    );
  });

  test('parses as an ES module', async () => {
    const checked = await runNode(['--check', scriptPath]);

    expect(checked.code, checked.stderr).toBe(0);
  });

  test('node runs it against the fixture server: reproduced 1/1, exit 0', async () => {
    const run = await runNode([scriptPath]);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(REPRODUCED_ONCE);
    expect(run.stdout).toMatch(
      /^1 {2}reproduced {2}shows no change when it receives keyboard focus {2}\d+\.\d s$/m,
    );
  });

  test('LOOKOVER_BASE_URL moves it to another origin, and TIMES measures it that many times', async () => {
    const run = await runNode([elsewherePath], { LOOKOVER_BASE_URL: bed.url, TIMES: '2' });

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/^reproduced 2\/2$/m);
  });

  test('exits 1 when the finding does not reproduce', async () => {
    const run = await runNode([elsewherePath]);

    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/^reproduced 0\/1$/m);
  });

  test('exits 1 with a message for a TIMES that is not a whole number above 0', async () => {
    const run = await runNode([scriptPath], { TIMES: 'many' });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('TIMES');
  });
});
