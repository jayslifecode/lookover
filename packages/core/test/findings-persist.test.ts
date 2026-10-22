import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { LookoverError } from '../src/errors.js';
import { FINDINGS_FILE, readLatestFindings, writeFindings } from '../src/findings/persist.js';
import type { Finding, FindingsFile } from '../src/findings/types.js';
import { createRun } from '../src/run/run-context.js';
import {
  deepFreeze,
  findingsFile as emptyFindingsFile,
  evidenceItem,
  occurrence,
  occurrenceFinding,
  stepFinding,
} from './fixtures/findings.js';

function findingsFile(runId: string, overrides: Partial<FindingsFile> = {}): FindingsFile {
  return emptyFindingsFile({
    runId,
    findings: [
      stepFinding({ id: 'step-1', evidence: [evidenceItem('e1')] }),
      occurrenceFinding({ id: 'occ-1', occurrences: [occurrence('s1', '#a')] }),
    ],
    worthALook: [occurrenceFinding({ id: 'occ-2', severity: 'low' })],
    ...overrides,
  });
}

/** A finding as a version 1 file holds it: without the `judgement` field. */
function legacyFinding(finding: Finding): Record<string, unknown> {
  return Object.fromEntries(Object.entries(finding).filter(([key]) => key !== 'judgement'));
}

describe('findings persistence', () => {
  let cwd: string;
  const config = configSchema.parse({
    baseUrl: 'http://localhost:3000',
    interaction: 'safe',
    acknowledgement: { disposableData: true, acknowledgedAt: '2026-10-21T00:00:00.000Z' },
  });

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'lookover-findings-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  test('writeFindings writes the same redacted bytes to the run dir and the latest, and readLatestFindings reads them back', async () => {
    const ctx = await createRun({ cwd, config });
    const file = deepFreeze(
      findingsFile(ctx.runId, {
        findings: [stepFinding({ id: 'step-1', observed: 'was filled in with jay@example.com' })],
      }),
    );

    const paths = await writeFindings(ctx, file);

    expect(paths).toEqual({
      runPath: join(ctx.dir, 'findings.json'),
      latestPath: join(ctx.lookoverDir, 'findings.json'),
    });
    const runBytes = await readFile(paths.runPath);
    expect((await readFile(paths.latestPath)).equals(runBytes)).toBe(true);
    expect(runBytes.toString('utf8')).toContain('was filled in with [email]');
    expect(runBytes.toString('utf8')).not.toContain('jay@example.com');
    const saved = await readLatestFindings(ctx.lookoverDir);
    expect(saved?.findings[0]?.observed).toBe('was filled in with [email]');
    expect(file.findings[0]?.observed).toBe('was filled in with jay@example.com');
  });

  test('reads back as the file that was written when nothing needed redacting', async () => {
    const ctx = await createRun({ cwd, config });
    const file = findingsFile(ctx.runId);

    await writeFindings(ctx, file);

    expect(await readLatestFindings(ctx.lookoverDir)).toEqual(file);
  });

  test('serialises with two-space indentation and a trailing newline', async () => {
    const ctx = await createRun({ cwd, config });
    const file = findingsFile(ctx.runId);

    const { runPath } = await writeFindings(ctx, file);

    expect(await readFile(runPath, 'utf8')).toBe(`${JSON.stringify(file, null, 2)}\n`);
  });

  test('redacts a secret in the occurrences and the fix prompt too', async () => {
    const ctx = await createRun({ cwd, config });
    const file = findingsFile(ctx.runId, {
      findings: [
        occurrenceFinding({
          id: 'occ-1',
          fixPrompt: 'Occurrences (1):\n/a page — message=token=abc123secret',
          occurrences: [occurrence('s1', null, { measured: { message: 'Bearer abcdefgh12345678' } })],
        }),
      ],
    });

    const { latestPath } = await writeFindings(ctx, file);

    const written = await readFile(latestPath, 'utf8');
    expect(written).not.toContain('abc123secret');
    expect(written).not.toContain('abcdefgh12345678');
    expect(written).toContain('Bearer [token]');
  });

  test('replaces the latest file of an earlier run and leaves that run file alone', async () => {
    const first = await createRun({ cwd, config, random: () => 'aaaa' });
    const second = await createRun({ cwd, config, random: () => 'bbbb' });
    const firstFile = findingsFile(first.runId, { findings: [], worthALook: [] });
    const secondFile = findingsFile(second.runId);

    const firstPaths = await writeFindings(first, firstFile);
    await writeFindings(second, secondFile);

    expect(await readLatestFindings(first.lookoverDir)).toEqual(secondFile);
    expect(JSON.parse(await readFile(firstPaths.runPath, 'utf8'))).toEqual(firstFile);
  });

  test('leaves no temporary files behind', async () => {
    const ctx = await createRun({ cwd, config });

    await writeFindings(ctx, findingsFile(ctx.runId));

    expect((await readdir(ctx.dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect((await readdir(ctx.lookoverDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('names the file findings.json', () => {
    expect(FINDINGS_FILE).toBe('findings.json');
  });

  describe('readLatestFindings', () => {
    test('readLatestFindings is null without a file and E_RUN_FAILED for a file that is not a findings file', async () => {
      const ctx = await createRun({ cwd, config });
      expect(await readLatestFindings(ctx.lookoverDir)).toBeNull();
      const path = join(ctx.lookoverDir, 'findings.json');

      await writeFile(path, JSON.stringify({ version: 2, findings: [], worthALook: [] }));

      const error = await readLatestFindings(ctx.lookoverDir).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LookoverError);
      expect(error).toMatchObject({ code: 'E_RUN_FAILED' });
      expect((error as LookoverError).message).toContain(path);
      expect((error as LookoverError).hint).toBe('Delete the file and run again to rebuild the findings');
    });

    test('rejects a file that is not valid JSON', async () => {
      const ctx = await createRun({ cwd, config });
      const path = join(ctx.lookoverDir, 'findings.json');
      await writeFile(path, '{ not json');

      const error = await readLatestFindings(ctx.lookoverDir).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ name: 'LookoverError', code: 'E_RUN_FAILED' });
      expect((error as LookoverError).message).toContain(path);
      expect((error as LookoverError).message).toContain('not valid JSON');
    });

    test.each([
      ['an array', []],
      ['null', null],
      ['a missing findings array', { version: 1, worthALook: [] }],
      ['a missing worthALook array', { version: 1, findings: [] }],
      ['findings that are not an array', { version: 1, findings: {}, worthALook: [] }],
      ['a version 2 file without the rejected list', { ...emptyFindingsFile(), rejected: undefined }],
      ['a version 2 file without the intended list', { ...emptyFindingsFile(), intended: undefined }],
      [
        'a version 2 file with a rejected list that is not an array',
        { ...emptyFindingsFile(), rejected: {} },
      ],
    ])('rejects %s', async (_name, content) => {
      const ctx = await createRun({ cwd, config });
      await writeFile(join(ctx.lookoverDir, 'findings.json'), JSON.stringify(content));

      await expect(readLatestFindings(ctx.lookoverDir)).rejects.toMatchObject({ code: 'E_RUN_FAILED' });
    });

    test('upgrades a version 1 file in memory to the version 2 shape', async () => {
      const ctx = await createRun({ cwd, config });
      const step = stepFinding({ id: 'step-1' });
      const worth = occurrenceFinding({ id: 'occ-2', severity: 'low' });
      const skipped = [{ reason: 'hidden', count: 2 }];
      const legacy = {
        version: 1,
        runId: ctx.runId,
        createdAt: '2026-10-21T12:00:00.000Z',
        findings: [legacyFinding(step)],
        worthALook: [legacyFinding(worth)],
        skipped,
      };
      await writeFile(join(ctx.lookoverDir, 'findings.json'), JSON.stringify(legacy));

      const file = await readLatestFindings(ctx.lookoverDir);

      expect(file).toEqual({
        version: 2,
        runId: ctx.runId,
        createdAt: '2026-10-21T12:00:00.000Z',
        findings: [step],
        worthALook: [worth],
        skipped,
        rejected: [],
        intended: [],
        judge: null,
        environment: null,
      });
      expect(
        file?.findings.every((finding) => finding.judgement === null && finding.status === 'candidate'),
      ).toBe(true);
    });

    test('leaves a version 1 file on disk as it was', async () => {
      const ctx = await createRun({ cwd, config });
      const path = join(ctx.lookoverDir, 'findings.json');
      const legacy = JSON.stringify({ version: 1, runId: ctx.runId, findings: [], worthALook: [] });
      await writeFile(path, legacy);

      await readLatestFindings(ctx.lookoverDir);

      expect(await readFile(path, 'utf8')).toBe(legacy);
    });

    test('reads a version 2 file with judged findings as it was written', async () => {
      const ctx = await createRun({ cwd, config });
      const confirmed = stepFinding({ id: 'step-1', status: 'confirmed' });
      const file = findingsFile(ctx.runId, {
        findings: [confirmed],
        rejected: [stepFinding({ id: 'step-2', status: 'rejected' })],
        intended: [occurrenceFinding({ id: 'occ-3', status: 'intended' })],
      });

      await writeFindings(ctx, file);

      expect(await readLatestFindings(ctx.lookoverDir)).toEqual(file);
    });

    test.each([0, 3, 99])(
      'fails with E_RUN_FAILED naming versions 1 and 2 for version %s',
      async (version) => {
        const ctx = await createRun({ cwd, config });
        const path = join(ctx.lookoverDir, 'findings.json');
        await writeFile(path, JSON.stringify({ ...emptyFindingsFile(), version }));

        const error = await readLatestFindings(ctx.lookoverDir).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(LookoverError);
        expect(error).toMatchObject({ code: 'E_RUN_FAILED' });
        expect((error as LookoverError).message).toContain(path);
        expect((error as LookoverError).message).toContain(`version ${version}`);
        expect((error as LookoverError).message).toContain('versions 1 and 2');
        expect((error as LookoverError).hint).toBe('Delete the file and run again to rebuild the findings');
      },
    );
  });
});
