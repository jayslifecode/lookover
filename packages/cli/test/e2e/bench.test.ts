import { access, copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import {
  type AppMap,
  type Finding,
  type FindingsFile,
  isFailedScreen,
  type LensSkip,
  loadConfig,
  RunLog,
  readLatestFindings,
  type Screen,
} from '@jayslifecode/lookover-core';
import type { GalleryState, StateGallery } from '@jayslifecode/lookover-lenses';
import { RULE_IDS } from '@jayslifecode/lookover-rules';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CANDIDATES_NOTE } from '../../src/commands/run-summary.js';
import { type CliResult, runCli } from '../run-cli.js';
import { BENCH_APP_DIR, BENCH_DATA_FILES, BENCH_URL, E2E_OUTPUT_DIR } from './bench-env.js';
import { findingsFor, readSeeds, reportsSeed, type Seed } from './seeds.js';

/** The whole run must finish within this, measured around the `lookover run` process. */
const RUN_BUDGET_MS = 150_000;
/** Stops a hung CLI well before the test times out, so the failure says what happened. */
const PROCESS_TIMEOUT_MS = 240_000;
const MAX_SCREENS = '12';
const MIN_SCREENS = 6;
/** The ten seeds yield at least one candidate each. */
const MIN_CANDIDATES = 10;
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

async function readFindings(project: string): Promise<FindingsFile> {
  return JSON.parse(await readFile(join(project, '.lookover', 'findings.json'), 'utf8')) as FindingsFile;
}

function allFindings(file: FindingsFile): Finding[] {
  return [...file.findings, ...file.worthALook];
}

/** The lens's state gallery of a screen (`gallery-<screenId>-<hash>.json`); `null` when it wrote none. */
async function readGallery(runDir: string, screenId: string): Promise<StateGallery | null> {
  const evidenceDir = join(runDir, 'evidence');
  const name = (await readdir(evidenceDir)).find((file) => file.startsWith(`gallery-${screenId}-`));
  if (name === undefined) return null;
  return JSON.parse(await readFile(join(evidenceDir, name), 'utf8')) as StateGallery;
}

/** What the lenses left out on each inspected screen, by screen id, from the run log. */
async function inspectedSkips(runDir: string): Promise<ReadonlyMap<string, readonly LensSkip[]>> {
  const events = await RunLog.read(join(runDir, 'run.jsonl'));
  return new Map(
    events.flatMap((event) => (event.type === 'screen.inspected' ? [[event.screenId, event.skipped]] : [])),
  );
}

/** The state a control's rule is judged in, which its gallery entry must hold. */
const JUDGED_STATE: Readonly<Record<string, GalleryState>> = {
  'interaction.focus-visible-missing': 'focus',
  'interaction.hover-state-missing': 'hover',
};
const TARGET_SIZE_RULE = 'interaction.target-size';
/** The skips that would leave an element's target size unjudged: the whole static step, its rule, a node gone. */
const TARGET_SIZE_SKIPS: ReadonlySet<string> = new Set([
  'time-budget:static',
  'time-budget:target-size',
  'gone',
]);

/**
 * Whether the lens measured the control on `screen`, so that it not being flagged means it passed: a
 * forced-state control has a gallery entry that was not skipped and holds the state its rule needs; a
 * target-size control is one of the screen's elements, on a screen inspected without a skip that could
 * have left it out.
 */
async function wasMeasured(
  control: Seed,
  screen: Screen,
  runDir: string,
  skips: ReadonlyMap<string, readonly LensSkip[]>,
): Promise<boolean> {
  const state = JUDGED_STATE[control.rule];
  if (state !== undefined) {
    const gallery = await readGallery(runDir, screen.id);
    const entry = gallery?.entries.find((candidate) => candidate.selector === control.selector);
    return entry !== undefined && entry.skipped === null && entry.states[state] !== undefined;
  }
  if (control.rule === TARGET_SIZE_RULE) {
    const skipped = skips.get(screen.id);
    const isListed = screen.elements.some((element) => element.selector === control.selector);
    return isListed && skipped !== undefined && !skipped.some(({ reason }) => TARGET_SIZE_SKIPS.has(reason));
  }
  throw new Error(`${control.id}: no way to tell whether a control of ${control.rule} was measured`);
}

/** The route a finding's fix prompt leads with: its trace's, or its first occurrence's. */
function leadRouteOf(finding: Finding): string | undefined {
  return finding.shape === 'step' ? finding.trace.route : finding.occurrences[0]?.route;
}

async function isMissing(path: string): Promise<boolean> {
  return access(path).then(
    () => false,
    () => true,
  );
}

/** Keeps what the run printed, logged and found next to the bench server's log, for a failed CI run. */
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
    for (const file of ['run.jsonl', 'findings.json']) {
      await copyFile(
        join(project, '.lookover', 'runs', runId, file),
        join(E2E_OUTPUT_DIR, `${runId}.${file}`),
      ).catch(() => undefined);
    }
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

  describe('against the seeds (bench/seeds.json)', () => {
    test('finds every seeded issue under its rule, on its route and element', async () => {
      const { issues } = await readSeeds();
      const map = await readAppMap(project);
      const file = await readFindings(project);

      const missed = issues.filter(
        (seed) => !findingsFor(file, seed).some((finding) => reportsSeed(finding, seed, map)),
      );

      expect(issues.length).toBeGreaterThan(0);
      expect(missed.map((seed) => seed.id)).toEqual([]);
    });

    test('flags no control, among the candidates or the worth-a-look entries', async () => {
      const { controls } = await readSeeds();
      const map = await readAppMap(project);
      const findings = allFindings(await readFindings(project));

      const flagged = controls.flatMap((seed) =>
        findings
          .filter((finding) => reportsSeed(finding, seed, map))
          .map((finding) => `${seed.id}: ${finding.id}`),
      );

      expect(controls.length).toBeGreaterThan(0);
      expect(flagged).toEqual([]);
    });

    test('measured every control, so not flagging it means it passed', async () => {
      const { controls } = await readSeeds();
      const map = await readAppMap(project);
      const runDir = await onlyRunDir(project);
      const skips = await inspectedSkips(runDir);

      const unmeasured: string[] = [];
      for (const control of controls) {
        const screens = map.screens.filter(
          (screen) => screen.route === control.route && !isFailedScreen(screen),
        );
        const measured = await Promise.all(
          screens.map((screen) => wasMeasured(control, screen, runDir, skips)),
        );
        if (!measured.includes(true)) unmeasured.push(control.id);
      }

      expect(unmeasured).toEqual([]);
    });
  });

  test('reports only rules from the catalogue', async () => {
    const findings = allFindings(await readFindings(project));

    expect(findings.map((finding) => finding.rule.id).filter((id) => !RULE_IDS.has(id))).toEqual([]);
  });

  test('names the React component of an element, since the bench runs in development mode', async () => {
    const { findings } = await readFindings(project);

    const named = findings.filter(
      (finding) => finding.shape === 'step' && finding.target?.componentName != null,
    );

    expect(named.length).toBeGreaterThan(0);
  });

  test('gives step findings the class signature of their element, for grouping', async () => {
    const { findings } = await readFindings(project);

    const signed = findings.filter(
      (finding) => finding.shape === 'step' && finding.target?.signature != null,
    );

    expect(signed.length).toBeGreaterThan(0);
  });

  test('writes findings.json that reads back through readLatestFindings, the same in the run directory', async () => {
    const latest = await readFile(join(project, '.lookover', 'findings.json'), 'utf8');
    const ofRun = await readFile(join(await onlyRunDir(project), 'findings.json'), 'utf8');

    expect(await readLatestFindings(join(project, '.lookover'))).toEqual(JSON.parse(latest));
    expect(ofRun).toBe(latest);
  });

  test('gives every finding a fix prompt that names the route it leads with', async () => {
    const findings = allFindings(await readFindings(project));

    const unnamed = findings.filter((finding) => {
      const route = leadRouteOf(finding);
      return finding.fixPrompt.trim() === '' || route === undefined || !finding.fixPrompt.includes(route);
    });

    expect(findings.length).toBeGreaterThan(0);
    expect(unnamed.map((finding) => finding.id)).toEqual([]);
  });

  test('keeps every piece of evidence a finding names inside the run directory', async () => {
    const runDir = resolve(await onlyRunDir(project));
    const paths = allFindings(await readFindings(project)).flatMap((finding) =>
      finding.evidence.map((item) => resolve(runDir, item.ref.path)),
    );

    const outside = paths.filter((path) => relative(runDir, path).startsWith(`..${sep}`));
    const missing: string[] = [];
    for (const path of paths) {
      if (await isMissing(path)) missing.push(relative(runDir, path));
    }

    expect(paths.length).toBeGreaterThan(0);
    expect(outside).toEqual([]);
    expect(missing).toEqual([]);
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
      expect.stringMatching(/^✓ \/organisations\/\[id\] {2}\d+ elements · 1 form · \d+ candidates?$/),
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
      'Candidates',
      'Worth a look',
      'Findings',
    ]) {
      expect(run.stdout).toMatch(new RegExp(`^ {2}${row} +\\S`, 'm'));
    }
  });

  test('prints at least ten candidates, with a line for the missing focus ring', () => {
    const candidates = /^ {2}Candidates +(\d+)$/m.exec(run.stdout)?.[1];

    expect(Number(candidates)).toBeGreaterThanOrEqual(MIN_CANDIDATES);
    expect(run.stdout).toMatch(/^ {2}\S+ +interaction\.focus-visible-missing +\d+ {2}\S/m);
  });

  test('ends the candidates with the note that nothing has judged them yet', () => {
    expect(run.stdout.split('\n')).toContain(CANDIDATES_NOTE);
  });

  test('leaves lookover.config.json loadable', async () => {
    await expect(loadConfig(project)).resolves.toMatchObject({ config: { auth: { type: 'form' } } });
  });

  test('changes no bench data', () => {
    expect(dataAfter).toEqual(dataBefore);
  });
});
