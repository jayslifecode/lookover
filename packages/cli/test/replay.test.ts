import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attempt, Finding, FindingsFile } from '@jayslifecode/lookover-core';
import { type ReplayResult, runReplay } from '@jayslifecode/lookover-judge';
import { InteractionLens } from '@jayslifecode/lookover-lenses';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runReplayCommand } from '../src/commands/replay.js';
import { runCli } from './run-cli.js';
import { ENVIRONMENT, judged, judgedFile, occurrenceCandidate, stepCandidate } from './run-fixtures.js';

// The one mock of this suite is the replay: it opens a real browser, which the judge's own tests and the
// end-to-end suite cover. Everything else here is the CLI's own code on a real project directory.
vi.mock('@jayslifecode/lookover-judge', async (importOriginal) => {
  const original = await importOriginal<typeof import('@jayslifecode/lookover-judge')>();
  return { ...original, runReplay: vi.fn() };
});

const VERSION = '9.9.9';
const BASE_URL = 'http://localhost:3000';
const CONFIRMED_ID = '3fa2c1d9e0b4';
const REJECTED_ID = '3fa9b7e1c2d5';
const INTENDED_ID = '7c01d2e3f4a5';
const WORTH_A_LOOK_ID = '9e8d7c6b5a41';
const OLDER_ID = '5b5b5b5b5b5b';
const OLDER_RUN = '20261021-090000-abcd';
const OBSERVED = 'shows no change when it receives keyboard focus';

function withId<T extends Finding>(finding: T, id: string): T {
  return { ...finding, id };
}

const CONFIRMED = withId(
  judged({ ...stepCandidate({ ruleId: 'interaction.focus-visible-missing' }), observed: OBSERVED }),
  CONFIRMED_ID,
);
const REJECTED = withId(
  judged(occurrenceCandidate('observers.console-error', ['a']), { status: 'rejected' }),
  REJECTED_ID,
);
const INTENDED = withId(
  { ...stepCandidate({ ruleId: 'interaction.target-size' }), status: 'intended' as const },
  INTENDED_ID,
);
const WORTH_A_LOOK = withId(
  stepCandidate({ ruleId: 'interaction.hover-state-missing', severity: 'low' }),
  WORTH_A_LOOK_ID,
);

/** The latest findings of a judged run, one finding in each list. */
const LATEST: FindingsFile = judgedFile({
  findings: [CONFIRMED],
  rejected: [REJECTED],
  intended: [INTENDED],
  worthALook: [WORTH_A_LOOK],
});
/** An earlier run's findings, which only `--run` reads. */
const OLDER: FindingsFile = judgedFile({
  findings: [withId(stepCandidate({ ruleId: 'interaction.target-size', route: '/old' }), OLDER_ID)],
});

function attempt(index: number, reproduced: boolean): Attempt {
  return {
    index,
    occurrence: null,
    reproduced,
    observed: reproduced ? OBSERVED : null,
    skipped: reproduced ? null : 'gone',
    durationMs: reproduced ? 800 : 400,
    evidence: [],
  };
}

function resultOf(...outcomes: boolean[]): ReplayResult {
  const attempts = outcomes.map((reproduced, index) => attempt(index + 1, reproduced));
  return {
    attempts,
    reproduced: attempts.filter((a) => a.reproduced).length,
    of: attempts.length,
    environment: ENVIRONMENT,
  };
}

describe('lookover replay with the replay stubbed', () => {
  let dir: string;
  let lookoverDir: string;
  let stdout: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lookover-replay-'));
    lookoverDir = join(dir, '.lookover');
    await mkdir(join(lookoverDir, 'runs', OLDER_RUN), { recursive: true });
    await writeFile(
      join(dir, 'lookover.config.json'),
      JSON.stringify({ baseUrl: BASE_URL, interaction: 'safe', framework: 'unknown' }),
    );
    await writeFile(join(lookoverDir, 'findings.json'), JSON.stringify(LATEST));
    await writeFile(join(lookoverDir, 'runs', OLDER_RUN, 'findings.json'), JSON.stringify(OLDER));
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.mocked(runReplay).mockReset();
    vi.mocked(runReplay).mockResolvedValue(resultOf(true));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  function replayed(): Parameters<typeof runReplay>[0] {
    const [call] = vi.mocked(runReplay).mock.calls;
    if (call === undefined) throw new Error('runReplay was not called');
    return call[0];
  }

  test('replays the finding once, headed, with the project config, and prints each attempt and the tally', async () => {
    await runReplayCommand(CONFIRMED_ID, {}, VERSION, dir);

    expect(vi.mocked(runReplay)).toHaveBeenCalledTimes(1);
    const options = replayed();
    expect(options).toMatchObject({
      cwd: dir,
      finding: CONFIRMED,
      times: 1,
      headless: false,
      env: process.env,
      lookoverVersion: VERSION,
      config: { baseUrl: BASE_URL, interaction: 'safe' },
    });
    expect(options.lenses.map((lens) => lens instanceof InteractionLens)).toEqual([true]);
    expect(stdout.join('')).toBe(
      [
        `Replaying ${CONFIRMED_ID} (interaction.focus-visible-missing) on ${BASE_URL}/, 1 attempt`,
        `1  reproduced  ${OBSERVED}  0.8 s`,
        'reproduced 1/1',
        '',
      ].join('\n'),
    );
    expect(process.exitCode).toBe(0);
  });

  test('exits 1 when an attempt did not reproduce, and aligns the outcomes', async () => {
    vi.mocked(runReplay).mockResolvedValue(resultOf(true, false));

    await runReplayCommand(CONFIRMED_ID, { times: '2' }, VERSION, dir);

    expect(stdout.join('').split('\n').slice(1)).toEqual([
      `1  reproduced      ${OBSERVED}  0.8 s`,
      '2  not reproduced  skipped: gone  0.4 s',
      'reproduced 1/2',
      '',
    ]);
    expect(process.exitCode).toBe(1);
  });

  test('--headless hides the browser and --times sets how many fresh contexts', async () => {
    await runReplayCommand(CONFIRMED_ID, { headless: true, times: '3' }, VERSION, dir);

    expect(replayed()).toMatchObject({ headless: true, times: 3 });
    expect(stdout[0]).toContain(', 3 attempts');
  });

  test.each([
    ['a rejected finding', REJECTED_ID, REJECTED],
    ['an intended finding', INTENDED_ID, INTENDED],
    ['a worth-a-look entry', WORTH_A_LOOK_ID, WORTH_A_LOOK],
  ])('finds the id among %s', async (_what, id, finding) => {
    await runReplayCommand(id, {}, VERSION, dir);

    expect(replayed().finding).toEqual(finding);
  });

  test('takes a prefix that names one finding', async () => {
    await runReplayCommand(' 7c0 ', {}, VERSION, dir);

    expect(replayed().finding.id).toBe(INTENDED_ID);
  });

  test('replays an observer finding with no lens', async () => {
    await runReplayCommand(REJECTED_ID, {}, VERSION, dir);

    expect(replayed().lenses).toEqual([]);
  });

  test("--run reads that run's findings instead of the latest", async () => {
    await runReplayCommand('5b5b', { run: OLDER_RUN }, VERSION, dir);

    expect(replayed().finding.id).toBe(OLDER_ID);
  });

  describe('refuses with E_USAGE, replaying nothing', () => {
    test('a prefix that names more than one finding', async () => {
      await expect(runReplayCommand('3fa', {}, VERSION, dir)).rejects.toMatchObject({
        code: 'E_USAGE',
        message: `"3fa" is the start of 2 finding ids: ${CONFIRMED_ID}, ${REJECTED_ID}`,
      });
      expect(vi.mocked(runReplay)).not.toHaveBeenCalled();
    });

    test('an id no finding has', async () => {
      await expect(runReplayCommand('ffffffffffff', {}, VERSION, dir)).rejects.toMatchObject({
        code: 'E_USAGE',
        message: 'No finding in .lookover/findings.json has the id "ffffffffffff"',
      });
    });

    test('an id only another run has, naming the file it looked in', async () => {
      await expect(runReplayCommand(CONFIRMED_ID, { run: OLDER_RUN }, VERSION, dir)).rejects.toMatchObject({
        code: 'E_USAGE',
        message: `No finding in .lookover/runs/${OLDER_RUN}/findings.json has the id "${CONFIRMED_ID}"`,
      });
    });

    test.each(['0', '-1', '1.5', 'three', ''])('--times %o', async (times) => {
      await expect(runReplayCommand(CONFIRMED_ID, { times }, VERSION, dir)).rejects.toMatchObject({
        code: 'E_USAGE',
        message: `--times "${times}" is not a whole number above 0`,
      });
    });

    test.each(['../..', 'a/b', ''])('--run %o, which is not a run id', async (run) => {
      await expect(runReplayCommand(CONFIRMED_ID, { run }, VERSION, dir)).rejects.toMatchObject({
        code: 'E_USAGE',
      });
    });
  });

  test('fails with E_RUN_FAILED and a hint when no run has written findings yet', async () => {
    await rm(join(lookoverDir, 'findings.json'));

    await expect(runReplayCommand(CONFIRMED_ID, {}, VERSION, dir)).rejects.toMatchObject({
      code: 'E_RUN_FAILED',
      message: 'There are no findings to replay yet',
      hint: 'Run lookover run first, then replay a finding by its id in .lookover/findings.json',
    });
  });

  test('fails with E_RUN_FAILED for a run with no findings file', async () => {
    await expect(
      runReplayCommand(CONFIRMED_ID, { run: '20990101-000000-zzzz' }, VERSION, dir),
    ).rejects.toMatchObject({
      code: 'E_RUN_FAILED',
    });
  });

  describe('--script', () => {
    test('writes .lookover/replays/<id>.mjs, says where, and replays nothing', async () => {
      await runReplayCommand('3fa2', { script: true }, VERSION, dir);

      const path = join(lookoverDir, 'replays', `${CONFIRMED_ID}.mjs`);
      const script = await readFile(path, 'utf8');
      expect(script).toContain(`\nconst finding = ${JSON.stringify(CONFIRMED, null, 2)};\n`);
      expect(script).toContain(`process.env.LOOKOVER_BASE_URL ?? ${JSON.stringify(BASE_URL)}`);
      expect(stdout.join('')).toBe(`✔ Wrote ${path}\nRun it with: node ${path}\n`);
      expect(vi.mocked(runReplay)).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    test('writes to the path given, relative to the project, creating its directory', async () => {
      await runReplayCommand(CONFIRMED_ID, { script: 'scripts/focus.mjs' }, VERSION, dir);

      const path = join(dir, 'scripts', 'focus.mjs');
      expect(await readFile(path, 'utf8')).toContain(`"id": "${CONFIRMED_ID}"`);
      expect(stdout[0]).toBe(`✔ Wrote ${path}\n`);
    });
  });

  describe('as a command', () => {
    test('writes the script and exits 0', async () => {
      const result = await runCli(dir, ['replay', '3fa2', '--script']);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(join('.lookover', 'replays', `${CONFIRMED_ID}.mjs`));
    });

    test('exits 2 with E_USAGE for an unknown id', async () => {
      const result = await runCli(dir, ['replay', 'ffff']);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain('E_USAGE');
    });

    test('exits 2 without an id', async () => {
      const result = await runCli(dir, ['replay']);

      expect(result.code).toBe(2);
    });
  });
});
