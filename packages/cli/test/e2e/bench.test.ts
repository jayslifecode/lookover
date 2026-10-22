import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import {
  type DecidedBy,
  type Finding,
  isFailedScreen,
  loadConfig,
  RunLog,
  readLatestFindings,
} from '@jayslifecode/lookover-core';
import { RULE_IDS } from '@jayslifecode/lookover-rules';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CANDIDATES_NOTE, HARNESS_ONLY_NOTE } from '../../src/commands/run-summary.js';
import { type CliResult, runCli } from '../run-cli.js';
import { BENCH_APP_DIR, BENCH_DATA_FILES, BENCH_URL } from './bench-env.js';
import { inspectedSkips, wasMeasured } from './controls.js';
import {
  attemptEvidenceProblems,
  attemptProblems,
  firstConfirmedMs,
  seedJudgementProblems,
} from './judged.js';
import {
  allFindings,
  CREDENTIALS,
  FORM_AUTH,
  isMissing,
  keepOutput,
  onlyRunDir,
  patchConfig,
  readAll,
  readAppMap,
  readFindings,
} from './project.js';
import { linkPlaywright, runScript, seedFinding } from './replay.js';
import { findingsFor, readSeeds, reportsSeed } from './seeds.js';

/** The whole run must finish within this, measured around the `lookover run` process. */
const RUN_BUDGET_MS = 240_000;
/** Stops a hung CLI well before the test times out, so the failure says what happened. */
const PROCESS_TIMEOUT_MS = 360_000;
/** The first confirmed finding is logged within this of `run.started`: judging streams while the crawl goes on. */
const FIRST_CONFIRMED_MS = 60_000;
const MAX_SCREENS = '12';
const MIN_SCREENS = 6;
/** The ten seeds are confirmed, one finding each at least. */
const MIN_CONFIRMED = 10;
/**
 * The suite never spends money on the judge model: the CLI runs without ANTHROPIC_API_KEY, as in CI,
 * unless LOOKOVER_E2E_MODEL=1 asks for the model on purpose (then a finding may be decided by it).
 */
const IS_MODEL_OPTED_IN = process.env.LOOKOVER_E2E_MODEL === '1';
const API_KEY_ENV = 'ANTHROPIC_API_KEY';
const DECIDED_BY: readonly DecidedBy[] = IS_MODEL_OPTED_IN ? ['harness', 'model'] : ['harness'];
const TIMING_CONTROL_MESSAGE = /^flaky: /;
const EDIT_ROUTE = '/organisations/[id]';
const LOGIN_ROUTE = '/login';
const LOGOUT_PATH = '/logout';
const ORGANISATION_FIELDS = 4;
const SIGN_IN_TITLE = /^Sign in\b/;
/** The one route the bench logs a console error on (seed observers-001). */
const CONSOLE_ERROR_ROUTE = '/reports';
/** The seed `lookover replay` replays: the missing focus ring on /settings, a step finding. */
const REPLAYED_SEED = 'interaction-001';
/** Stops a hung replay, or a hung standalone script, well before the test times out. */
const REPLAY_TIMEOUT_MS = 120_000;
const REPRODUCED_ONCE = /^reproduced 1\/1$/m;

/** The route a finding's fix prompt leads with: its trace's, or its first occurrence's. */
function leadRouteOf(finding: Finding): string | undefined {
  return finding.shape === 'step' ? finding.trace.route : finding.occurrences[0]?.route;
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
    run = await runCli(project, ['run', '--yes', '--no-report', '--max-screens', MAX_SCREENS], {
      env: CREDENTIALS,
      ...(IS_MODEL_OPTED_IN ? {} : { withoutEnv: [API_KEY_ENV] }),
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

    test('confirms every seeded issue, reproduced 3 times of 3 in Chromium, by the harness without a key', async () => {
      const { issues } = await readSeeds();
      const map = await readAppMap(project);
      const file = await readFindings(project);

      const problems = issues.flatMap((seed) =>
        findingsFor(file, seed)
          .filter((finding) => reportsSeed(finding, seed, map))
          .flatMap((finding) => seedJudgementProblems(finding, seed, map, DECIDED_BY)),
      );

      expect(problems).toEqual([]);
      expect(file.environment?.browser).toMatch(/^chromium /);
    });

    test('rejects the timing control (control-004) as timing, and the console error it logs', async () => {
      const { controls } = await readSeeds();
      const map = await readAppMap(project);
      const file = await readFindings(project);
      const timing = controls.filter((seed) => seed.expectedStatus === 'rejected');

      const unrejected = timing.filter(
        (seed) =>
          !file.rejected.some(
            (finding) => reportsSeed(finding, seed, map) && finding.judgement?.attribution === 'timing',
          ),
      );
      const flakyErrors = (findings: readonly Finding[]) =>
        findings.filter(
          (finding) =>
            finding.rule.id === 'observers.console-error' &&
            finding.shape === 'occurrence' &&
            finding.occurrences.some((occurrence) =>
              TIMING_CONTROL_MESSAGE.test(String(occurrence.measured.message)),
            ),
        );

      expect(timing.map((seed) => seed.id)).toEqual(['control-004']);
      expect(unrejected.map((seed) => seed.id)).toEqual([]);
      expect(flakyErrors(file.rejected).map((finding) => finding.judgement?.attribution)).toEqual(['timing']);
      expect(flakyErrors(allFindings(file))).toEqual([]);
    });

    test('flags no control, among the confirmed findings or the worth-a-look entries', async () => {
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
      // The timing control is measured when it is rejected, which its own test asserts.
      for (const control of controls.filter((seed) => seed.expectedStatus === undefined)) {
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

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.map((finding) => finding.rule.id).filter((id) => !RULE_IDS.has(id))).toEqual([]);
  });

  test('reports console errors only where the bench logs one', async () => {
    const findings = allFindings(await readFindings(project));

    const routes = findings
      .filter((finding) => finding.rule.id === 'observers.console-error')
      .flatMap((finding) => (finding.shape === 'occurrence' ? finding.occurrences : []))
      .map((occurrence) => occurrence.route);

    expect(routes.length).toBeGreaterThan(0);
    expect(routes.filter((route) => route !== CONSOLE_ERROR_ROUTE)).toEqual([]);
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

  test('gives every finding a fix prompt that opens with the route it leads with', async () => {
    const findings = allFindings(await readFindings(project));

    const unnamed = findings.filter((finding) => {
      const route = leadRouteOf(finding);
      return route === undefined || !finding.fixPrompt.startsWith(`In ${route} (`);
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

  describe('the judge', () => {
    test('logs the first confirmed finding within a minute of run.started, while the crawl goes on', async () => {
      const events = await RunLog.read(join(await onlyRunDir(project), 'run.jsonl'));

      const ms = firstConfirmedMs(events);
      process.stdout.write(
        `first confirmed finding: ${ms === null ? 'none' : `${ms} ms`} after run.started\n`,
      );

      expect(ms).not.toBeNull();
      expect(ms).toBeLessThan(FIRST_CONFIRMED_MS);
    });

    test('ends the run log with run.finished, counting what became of the findings', async () => {
      const events = await RunLog.read(join(await onlyRunDir(project), 'run.jsonl'));
      const file = await readFindings(project);
      const finished = events.at(-1);

      expect(finished?.type).toBe('run.finished');
      expect(finished).toMatchObject({
        confirmed: file.findings.filter((finding) => finding.status === 'confirmed').length,
        rejected: file.rejected.length,
        intended: 0,
        worthALook: file.worthALook.length,
        judge: file.judge,
      });
      expect(finished?.type === 'run.finished' && finished.confirmed).toBeGreaterThanOrEqual(MIN_CONFIRMED);
    });

    test('lists only confirmed findings, and decides without the model when there is no key', async () => {
      const file = await readFindings(project);

      expect(file.findings.filter((finding) => finding.status !== 'confirmed')).toEqual([]);
      expect(file.rejected.length).toBeGreaterThan(0);
      if (!IS_MODEL_OPTED_IN) expect(file.judge).toMatchObject({ model: null, unavailable: 'no-api-key' });
    });

    test('gives every confirmed and rejected finding three attempts per target, each with evidence', async () => {
      const file = await readFindings(project);

      expect([...file.findings, ...file.rejected].flatMap(attemptProblems)).toEqual([]);
    });

    test("keeps every attempt's evidence inside the run directory", async () => {
      const file = await readFindings(project);
      const runDir = await onlyRunDir(project);

      expect(await attemptEvidenceProblems([...file.findings, ...file.rejected], runDir)).toEqual([]);
    });
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
      'Confirmed',
      'Rejected',
      'Intended',
      'Worth a look',
      'Skipped',
      'Judge',
      'Findings',
    ]) {
      expect(run.stdout).toMatch(new RegExp(`^ {2}${row} +\\S`, 'm'));
    }
    expect(run.stdout).not.toMatch(/^ {2}Candidates /m);
  });

  test('prints at least ten confirmed findings, with a line for the missing focus ring reproduced 3/3', () => {
    const confirmed = /^ {2}Confirmed +(\d+)$/m.exec(run.stdout)?.[1];

    expect(Number(confirmed)).toBeGreaterThanOrEqual(MIN_CONFIRMED);
    expect(run.stdout).toMatch(
      /^ {2}\S+ +interaction\.focus-visible-missing +\d+ {2}\S.* {2}reproduced 3\/3$/m,
    );
  });

  test('says the judge model was not used, and how to enable it, when there is no key', () => {
    if (IS_MODEL_OPTED_IN) {
      expect(run.stdout).toMatch(/^ {2}Judge +claude-\S+ · \d+ calls? \(\d+ cached\) · /m);
      return;
    }
    expect(run.stdout).toMatch(/^ {2}Judge +harness only \(no ANTHROPIC_API_KEY\)$/m);
    expect(run.stdout.split('\n')).toContain(HARNESS_ONLY_NOTE);
    expect(run.stdout.split('\n')).not.toContain(CANDIDATES_NOTE);
  });

  test('leaves lookover.config.json loadable', async () => {
    await expect(loadConfig(project)).resolves.toMatchObject({ config: { auth: { type: 'form' } } });
  });

  test('changes no bench data', () => {
    expect(dataAfter).toEqual(dataBefore);
  });

  describe('lookover replay', () => {
    test('replays a confirmed seed headless: reproduced 1/1, exit 0, and no run of its own', async () => {
      const { id } = await seedFinding(await readFindings(project), await readAppMap(project), REPLAYED_SEED);

      const replay = await runCli(project, ['replay', id, '--headless'], {
        env: CREDENTIALS,
        withoutEnv: [API_KEY_ENV],
        timeoutMs: REPLAY_TIMEOUT_MS,
      });

      expect(replay.code, replay.stderr).toBe(0);
      expect(replay.stdout).toMatch(REPRODUCED_ONCE);
      expect(await readdir(join(project, '.lookover', 'runs'))).toHaveLength(1);
      expect(await readAll(BENCH_DATA_FILES)).toEqual(dataBefore);
    });

    test("writes the seed's standalone script, which node runs against the bench: exit 0", async () => {
      const { id } = await seedFinding(await readFindings(project), await readAppMap(project), REPLAYED_SEED);
      const script = join(project, '.lookover', 'replays', `${id}.mjs`);

      const written = await runCli(project, ['replay', id, '--script']);
      await linkPlaywright(project);
      // The run's form login saved the session there; the script takes no config, so it is handed the state.
      const replay = await runScript(
        project,
        script,
        { STORAGE_STATE: join(project, '.lookover', 'state', 'form.json') },
        REPLAY_TIMEOUT_MS,
      );

      expect(written.code, written.stderr).toBe(0);
      expect(written.stdout).toContain(join('.lookover', 'replays', `${id}.mjs`));
      expect(replay.code, replay.stderr).toBe(0);
      expect(replay.stdout).toMatch(REPRODUCED_ONCE);
      process.stdout.write(
        `lookover replay --script: node ran it in ${(replay.durationMs / 1_000).toFixed(1)} s\n`,
      );
    });
  });
});
