import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DECISIONS_FILE,
  FINDINGS_FILE,
  type Finding,
  type FindingsFile,
  readDecisions,
} from '@jayslifecode/lookover-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runMark } from '../src/commands/mark.js';
import { runCli } from './run-cli.js';
import { judged, judgedFile, occurrenceCandidate, stepCandidate } from './run-fixtures.js';

const CONFIRMED_ID = '3fa2c1d9e0b4';
const REJECTED_ID = '3fa9b7e1c2d5';
const INTENDED_ID = '7c01d2e3f4a5';
const WORTH_A_LOOK_ID = '9e8d7c6b5a41';

function withId<T extends Finding>(finding: T, id: string): T {
  return { ...finding, id };
}

/** The latest findings of a judged run, one finding in each list. */
const LATEST: FindingsFile = judgedFile({
  findings: [withId(judged(stepCandidate({ ruleId: 'interaction.focus-visible-missing' })), CONFIRMED_ID)],
  rejected: [
    withId(
      judged(occurrenceCandidate('observers.console-error', ['a']), { status: 'rejected' }),
      REJECTED_ID,
    ),
  ],
  intended: [
    withId({ ...stepCandidate({ ruleId: 'interaction.target-size' }), status: 'intended' }, INTENDED_ID),
  ],
  worthALook: [
    withId(stepCandidate({ ruleId: 'interaction.hover-state-missing', severity: 'low' }), WORTH_A_LOOK_ID),
  ],
});

describe('lookover mark', () => {
  let dir: string;
  let lookoverDir: string;
  let stdout: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lookover-mark-'));
    lookoverDir = join(dir, '.lookover');
    await mkdir(lookoverDir, { recursive: true });
    await writeFile(join(lookoverDir, FINDINGS_FILE), JSON.stringify(LATEST), 'utf8');
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function decisionIds(): Promise<string[]> {
    return Object.keys((await readDecisions(lookoverDir)).decisions);
  }

  describe('intended', () => {
    test('records the decision with its note and the time, and says so', async () => {
      const before = Date.now();

      await runMark({ id: CONFIRMED_ID, status: 'intended', note: 'the design wants it' }, dir);

      const { decisions } = await readDecisions(lookoverDir);
      expect(decisions[CONFIRMED_ID]).toMatchObject({ status: 'intended', note: 'the design wants it' });
      expect(Date.parse(decisions[CONFIRMED_ID]?.at ?? '')).toBeGreaterThanOrEqual(before - 1_000);
      expect(stdout.join('')).toBe(`✔ Marked ${CONFIRMED_ID} as intended\n`);
    });

    test('records no note when none is given', async () => {
      await runMark({ id: CONFIRMED_ID, status: 'intended' }, dir);

      expect((await readDecisions(lookoverDir)).decisions[CONFIRMED_ID]?.note).toBeNull();
    });

    test('keeps the decisions already there', async () => {
      await runMark({ id: CONFIRMED_ID, status: 'intended' }, dir);
      await runMark({ id: WORTH_A_LOOK_ID, status: 'intended' }, dir);

      expect((await decisionIds()).toSorted()).toEqual([CONFIRMED_ID, WORTH_A_LOOK_ID].toSorted());
    });

    test.each([
      ['a confirmed finding', CONFIRMED_ID],
      ['a rejected finding', REJECTED_ID],
      ['an intended finding', INTENDED_ID],
      ['a worth-a-look entry', WORTH_A_LOOK_ID],
    ])('finds the id among %s', async (_what, id) => {
      await runMark({ id, status: 'intended' }, dir);

      expect(await decisionIds()).toEqual([id]);
    });

    test('takes a prefix that names one finding, and records the whole id', async () => {
      await runMark({ id: '7c0', status: 'intended' }, dir);

      expect(await decisionIds()).toEqual([INTENDED_ID]);
      expect(stdout.join('')).toBe(`✔ Marked ${INTENDED_ID} as intended\n`);
    });

    test('ignores the spaces around the id', async () => {
      await runMark({ id: ` ${CONFIRMED_ID}\n`, status: 'intended' }, dir);

      expect(await decisionIds()).toEqual([CONFIRMED_ID]);
    });
  });

  describe('clear', () => {
    test('forgets the decision and says so', async () => {
      await runMark({ id: CONFIRMED_ID, status: 'intended' }, dir);
      await runMark({ id: WORTH_A_LOOK_ID, status: 'intended' }, dir);
      stdout = [];

      await runMark({ id: CONFIRMED_ID, status: 'clear' }, dir);

      expect(await decisionIds()).toEqual([WORTH_A_LOOK_ID]);
      expect(stdout.join('')).toBe(`✔ Cleared the decision on ${CONFIRMED_ID}\n`);
    });

    test('takes a prefix too', async () => {
      await runMark({ id: INTENDED_ID, status: 'intended' }, dir);

      await runMark({ id: '7c01', status: 'clear' }, dir);

      expect(await decisionIds()).toEqual([]);
    });

    test('says there was nothing to clear, and writes nothing, when the finding has no decision', async () => {
      await runMark({ id: CONFIRMED_ID, status: 'clear' }, dir);

      expect(stdout.join('')).toBe(`${CONFIRMED_ID} has no decision to clear\n`);
      await expect(readFile(join(lookoverDir, DECISIONS_FILE), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  describe('refuses with E_USAGE', () => {
    test('a prefix that names more than one finding, listing them', async () => {
      const marking = runMark({ id: '3fa', status: 'intended' }, dir);

      await expect(marking).rejects.toMatchObject({
        code: 'E_USAGE',
        message: `"3fa" is the start of 2 finding ids: ${CONFIRMED_ID}, ${REJECTED_ID}`,
      });
      expect(await decisionIds()).toEqual([]);
    });

    test('an id no finding has', async () => {
      const marking = runMark({ id: 'ffffffffffff', status: 'intended' }, dir);

      await expect(marking).rejects.toMatchObject({
        code: 'E_USAGE',
        message: 'No finding in .lookover/findings.json has the id "ffffffffffff"',
      });
    });

    test('an empty id', async () => {
      await expect(runMark({ id: '  ', status: 'intended' }, dir)).rejects.toMatchObject({ code: 'E_USAGE' });
    });

    test.each(['ignored', 'Intended', ''])('the status %o', async (status) => {
      const marking = runMark({ id: CONFIRMED_ID, status }, dir);

      await expect(marking).rejects.toMatchObject({
        code: 'E_USAGE',
        message: `"${status}" is not a decision`,
        hint: 'Use intended or clear, e.g. lookover mark <finding id> intended',
      });
    });

    test('a --note with clear', async () => {
      const marking = runMark({ id: CONFIRMED_ID, status: 'clear', note: 'why' }, dir);

      await expect(marking).rejects.toMatchObject({ code: 'E_USAGE', message: '--note goes with intended' });
    });

    test('an empty --note', async () => {
      const marking = runMark({ id: CONFIRMED_ID, status: 'intended', note: ' ' }, dir);

      await expect(marking).rejects.toMatchObject({ code: 'E_USAGE', message: '--note is empty' });
    });

    test('any id when no run has written findings yet', async () => {
      await rm(join(lookoverDir, FINDINGS_FILE));

      const marking = runMark({ id: CONFIRMED_ID, status: 'intended' }, dir);

      await expect(marking).rejects.toMatchObject({
        code: 'E_USAGE',
        message: 'There are no findings to mark yet',
        hint: 'Run lookover run first, then mark a finding by the id in .lookover/findings.json',
      });
    });
  });

  describe('as a command', () => {
    test('records the decision and exits 0', async () => {
      const result = await runCli(dir, ['mark', '3fa2', 'intended', '--note', 'on purpose']);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe(`✔ Marked ${CONFIRMED_ID} as intended\n`);
      expect((await readDecisions(lookoverDir)).decisions[CONFIRMED_ID]?.note).toBe('on purpose');
    });

    test('exits 2 with E_USAGE on an ambiguous prefix', async () => {
      const result = await runCli(dir, ['mark', '3fa', 'intended']);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain('E_USAGE');
      expect(result.stderr).toContain(`${CONFIRMED_ID}, ${REJECTED_ID}`);
    });

    test('exits 2 without the status', async () => {
      const result = await runCli(dir, ['mark', CONFIRMED_ID]);

      expect(result.code).toBe(2);
    });
  });
});
