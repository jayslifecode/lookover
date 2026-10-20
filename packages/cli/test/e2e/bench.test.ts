import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AppMap, isFailedScreen, loadConfig, RunLog } from '@jayslifecode/lookover-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type CliResult, runCli } from '../run-cli.js';
import { BENCH_APP_DIR, BENCH_DATA_FILES, BENCH_URL, E2E_OUTPUT_DIR } from './bench-env.js';

/** The whole of Stage 1 must finish within this, measured around the `lookover run` process. */
const RUN_BUDGET_MS = 90_000;
/** Stops a hung CLI well before the test times out, so the failure says what happened. */
const PROCESS_TIMEOUT_MS = 170_000;
const MAX_SCREENS = '12';
const MIN_SCREENS = 6;
const EDIT_ROUTE = '/organisations/[id]';
const LOGIN_ROUTE = '/login';
const LOGOUT_PATH = '/logout';
const ORGANISATION_FIELDS = 4;
const SIGN_IN_TITLE = /^Sign in\b/;

const CREDENTIALS = {
  LOOKOVER_USERNAME: 'demo@lookover.dev',
  LOOKOVER_PASSWORD: 'demo-password',
} as const;

const FORM_AUTH = {
  type: 'form',
  loginUrl: '/login',
  usernameSelector: 'input[name="email"]',
  passwordSelector: 'input[name="password"]',
  submitSelector: 'button[type="submit"]',
  successUrl: 'http://localhost:3123/',
} as const;

async function patchConfig(dir: string, patch: Record<string, unknown>): Promise<void> {
  const path = join(dir, 'lookover.config.json');
  const config = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(path, `${JSON.stringify({ ...config, ...patch }, null, 2)}\n`, 'utf8');
}

function readAll(paths: readonly string[]): Promise<Buffer[]> {
  return Promise.all(paths.map((path) => readFile(path)));
}

async function onlyRunDir(project: string): Promise<string> {
  const runsDir = join(project, '.lookover', 'runs');
  const runs = await readdir(runsDir);
  expect(runs).toHaveLength(1);
  return join(runsDir, runs[0] ?? '');
}

async function readAppMap(project: string): Promise<AppMap> {
  return JSON.parse(await readFile(join(project, '.lookover', 'app-map.json'), 'utf8')) as AppMap;
}

/** Keeps what the run printed and logged next to the bench server's log, for a failed CI run. */
async function keepOutput(project: string, run: CliResult): Promise<void> {
  const seconds = (run.durationMs / 1_000).toFixed(1);
  const transcript = [
    `exit ${run.code} after ${seconds} s`,
    '--- stdout ---',
    run.stdout,
    '--- stderr ---',
    run.stderr,
  ].join('\n');
  await writeFile(join(E2E_OUTPUT_DIR, 'lookover-run.log'), transcript, 'utf8');
  const runs = await readdir(join(project, '.lookover', 'runs')).catch(() => []);
  for (const runId of runs) {
    await copyFile(
      join(project, '.lookover', 'runs', runId, 'run.jsonl'),
      join(E2E_OUTPUT_DIR, `${runId}.run.jsonl`),
    ).catch(() => undefined);
  }
  process.stdout.write(`lookover run: exit ${run.code} in ${seconds} s\n`);
}

describe('lookover run against the bench app', () => {
  let project: string;
  let run: CliResult;
  let dataBefore: Buffer[];
  let dataAfter: Buffer[];

  beforeAll(async () => {
    project = await mkdtemp(join(tmpdir(), 'lookover-e2e-'));
    const init = await runCli(project, [
      'init',
      '--non-interactive',
      '--base-url',
      BENCH_URL,
      '--root',
      BENCH_APP_DIR,
      '--interaction',
      'full',
      '--acknowledge-disposable-data',
    ]);
    expect(init.code, init.stderr).toBe(0);
    await patchConfig(project, { auth: FORM_AUTH });

    dataBefore = await readAll(BENCH_DATA_FILES);
    run = await runCli(project, ['run', '--yes', '--max-screens', MAX_SCREENS], {
      env: CREDENTIALS,
      timeoutMs: PROCESS_TIMEOUT_MS,
    });
    dataAfter = await readAll(BENCH_DATA_FILES);
    await keepOutput(project, run);
  });

  afterAll(async () => {
    if (project !== undefined) {
      await rm(project, { recursive: true, force: true });
    }
  });

  test('exits 0 with --yes, within the time budget', () => {
    expect(run.code, run.stderr).toBe(0);
    expect(run.durationMs).toBeLessThan(RUN_BUDGET_MS);
  });

  test('maps the dynamic route from the filesystem', async () => {
    const map = await readAppMap(project);

    expect(map.routes).toContainEqual(expect.objectContaining({ pattern: EDIT_ROUTE, source: 'filesystem' }));
  });

  test('captures at least six screens, with the edit form and its labelled fields', async () => {
    const map = await readAppMap(project);

    expect(map.screens.filter((screen) => !isFailedScreen(screen)).length).toBeGreaterThanOrEqual(
      MIN_SCREENS,
    );
    const editForms = map.screens
      .filter((screen) => screen.route === EDIT_ROUTE)
      .flatMap((screen) => screen.forms)
      .filter((form) => form.fields.length === ORGANISATION_FIELDS);
    expect(editForms.length).toBeGreaterThan(0);
    for (const form of editForms) {
      expect(form.fields.find((field) => field.name === 'phone')?.label).toBe('Phone');
      // The YYYY-MM-DD field keeps the default keyboard: a numeric keypad has no hyphen on iOS.
      expect(form.fields.find((field) => field.name === 'registeredAt')).toMatchObject({
        label: 'Registered on',
        inputMode: null,
      });
    }
  });

  test('stays logged in: only the login route shows the login page', async () => {
    const map = await readAppMap(project);
    const elsewhere = map.screens.filter((screen) => screen.route !== LOGIN_ROUTE);

    expect(elsewhere.filter((screen) => new URL(screen.url).pathname.endsWith(LOGIN_ROUTE))).toEqual([]);
    expect(elsewhere.filter((screen) => SIGN_IN_TITLE.test(screen.title))).toEqual([]);
  });

  test('never opens /logout', async () => {
    const map = await readAppMap(project);

    expect(map.screens.filter((screen) => new URL(screen.url).pathname === LOGOUT_PATH)).toEqual([]);
    expect(map.screens.filter((screen) => screen.route === LOGOUT_PATH)).toEqual([]);
  });

  test('ends the run log with run.finished', async () => {
    const events = await RunLog.read(join(await onlyRunDir(project), 'run.jsonl'));

    expect(events.at(-1)?.type).toBe('run.finished');
  });

  test('prints one progress line per screen, then the summary', async () => {
    const map = await readAppMap(project);
    const progress = run.stdout.split('\n').filter((line) => /^[✓!] \//.test(line));

    expect(progress).toHaveLength(map.screens.length);
    expect(progress).toContainEqual(
      expect.stringMatching(/^✓ \/organisations\/\[id\] {2}\d+ elements · 1 form$/),
    );
    for (const row of [
      'Screens',
      'Elements',
      'Forms',
      'Backend hosts',
      'Blocked requests',
      'Run dir',
      'App map',
      'Duration',
    ]) {
      expect(run.stdout).toMatch(new RegExp(`^ {2}${row} +\\S`, 'm'));
    }
  });

  test('leaves lookover.config.json loadable', async () => {
    await expect(loadConfig(project)).resolves.toMatchObject({ config: { auth: { type: 'form' } } });
  });

  test('changes no bench data', () => {
    expect(dataAfter).toEqual(dataBefore);
  });
});
