import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { LookoverError } from '../src/errors.js';
import {
  applyDecisions,
  DECISIONS_FILE,
  type DecisionsFile,
  readDecisions,
  writeDecision,
} from '../src/findings/decisions.js';
import { deepFreeze, occurrenceFinding, stepFinding } from './fixtures/findings.js';

const NOW = '2026-10-22T10:00:00.000Z';
const EARLIER = '2026-10-21T10:00:00.000Z';

describe('decisions', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lookover-decisions-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('names the file decisions.json', () => {
    expect(DECISIONS_FILE).toBe('decisions.json');
  });

  test('reads an empty decisions file when none exists', async () => {
    expect(await readDecisions(dir)).toEqual({ version: 1, decisions: {} });
  });

  test('writes a decision atomically and reads it back', async () => {
    const written = await writeDecision(dir, 'abc', { status: 'intended', at: NOW, note: 'brand colour' });

    expect((await readDecisions(dir)).decisions.abc?.note).toBe('brand colour');
    expect(written).toEqual(await readDecisions(dir));
    expect(await readFile(join(dir, DECISIONS_FILE), 'utf8')).toBe(`${JSON.stringify(written, null, 2)}\n`);
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('keeps the other decisions when one is written', async () => {
    await writeDecision(dir, 'abc', { status: 'intended', at: EARLIER, note: null });

    const file = await writeDecision(dir, 'def', { status: 'intended', at: NOW, note: 'on purpose' });

    expect(Object.keys(file.decisions)).toEqual(['abc', 'def']);
  });

  test('removes a decision with null', async () => {
    await writeDecision(dir, 'abc', { status: 'intended', at: NOW, note: null });
    await writeDecision(dir, 'def', { status: 'intended', at: NOW, note: null });

    const file = await writeDecision(dir, 'abc', null);

    expect(Object.keys(file.decisions)).toEqual(['def']);
    expect(Object.keys((await readDecisions(dir)).decisions)).toEqual(['def']);
  });

  test('removing a decision that does not exist leaves the file as it is', async () => {
    const file = await writeDecision(dir, 'missing', null);

    expect(file).toEqual({ version: 1, decisions: {} });
  });

  test('redacts a secret in the note', async () => {
    await writeDecision(dir, 'abc', { status: 'intended', at: NOW, note: 'the token=abc123secret is fine' });

    expect(await readFile(join(dir, DECISIONS_FILE), 'utf8')).not.toContain('abc123secret');
  });

  test('fails with E_RUN_FAILED when the file is not JSON', async () => {
    const path = join(dir, DECISIONS_FILE);
    await writeFile(path, '{ not json');

    const error = await readDecisions(dir).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LookoverError);
    expect(error).toMatchObject({ code: 'E_RUN_FAILED' });
    expect((error as LookoverError).message).toContain(path);
    expect((error as LookoverError).message).toContain('not valid JSON');
  });

  test.each([
    ['an array', []],
    ['null', null],
    ['another version', { version: 2, decisions: {} }],
    ['a missing decisions object', { version: 1 }],
    ['decisions that are an array', { version: 1, decisions: [] }],
    ['a decision that is not intended', { version: 1, decisions: { abc: { status: 'rejected', at: NOW } } }],
    ['a decision without a time', { version: 1, decisions: { abc: { status: 'intended', note: null } } }],
  ])('fails with E_RUN_FAILED for %s', async (_name, content) => {
    await writeFile(join(dir, DECISIONS_FILE), JSON.stringify(content));

    await expect(readDecisions(dir)).rejects.toMatchObject({ code: 'E_RUN_FAILED' });
  });

  test('does not write over a decisions file it cannot read', async () => {
    await writeFile(join(dir, DECISIONS_FILE), '{ not json');

    await expect(writeDecision(dir, 'abc', null)).rejects.toMatchObject({ code: 'E_RUN_FAILED' });
    expect(await readFile(join(dir, DECISIONS_FILE), 'utf8')).toBe('{ not json');
  });
});

describe('applyDecisions', () => {
  const a = stepFinding({ id: 'a' });
  const b = occurrenceFinding({ id: 'b' });

  test('marks the decided findings intended with a user judgement and keeps the rest', () => {
    const { kept, intended } = applyDecisions(
      [a, b],
      { version: 1, decisions: { [a.id]: { status: 'intended', at: EARLIER, note: null } } },
      NOW,
    );

    expect(kept).toEqual([b]);
    expect(intended[0]).toMatchObject({
      id: a.id,
      status: 'intended',
      judgement: { decidedBy: 'user', of: 0, attempts: [], environment: null },
    });
  });

  test('gives the user judgement every field the shape needs, the note from the decision and the time of now', () => {
    const { intended } = applyDecisions(
      [a],
      { version: 1, decisions: { [a.id]: { status: 'intended', at: EARLIER, note: 'brand colour' } } },
      NOW,
    );

    expect(intended[0]?.judgement).toEqual({
      reproduced: 0,
      of: 0,
      attempts: [],
      decidedBy: 'user',
      attribution: null,
      oracle: null,
      note: 'brand colour',
      model: null,
      usage: null,
      estimatedUsd: null,
      cached: false,
      droppedOccurrences: [],
      environment: null,
      judgedAt: NOW,
    });
  });

  test('keeps everything but the status and the judgement of an intended finding', () => {
    const { intended } = applyDecisions(
      [b],
      { version: 1, decisions: { [b.id]: { status: 'intended', at: EARLIER, note: null } } },
      NOW,
    );

    expect(intended[0]).toEqual({ ...b, status: 'intended', judgement: expect.objectContaining({ of: 0 }) });
  });

  test('keeps every finding, in order, when nothing is decided', () => {
    const { kept, intended } = applyDecisions([a, b], { version: 1, decisions: {} }, NOW);

    expect(kept).toEqual([a, b]);
    expect(intended).toEqual([]);
  });

  test('ignores a decision for a finding that is not in the list', () => {
    const decisions: DecisionsFile = {
      version: 1,
      decisions: { gone: { status: 'intended', at: EARLIER, note: null } },
    };

    const { kept, intended } = applyDecisions([a], decisions, NOW);

    expect(kept).toEqual([a]);
    expect(intended).toEqual([]);
  });

  test('does not modify its inputs', () => {
    const findings = deepFreeze([a, b]);
    const decisions = deepFreeze<DecisionsFile>({
      version: 1,
      decisions: { [a.id]: { status: 'intended', at: EARLIER, note: null } },
    });

    expect(() => applyDecisions(findings, decisions, NOW)).not.toThrow();
  });
});
