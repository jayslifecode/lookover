import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { EvidenceStore } from '../src/evidence/store.js';
import { createRun } from '../src/run/run-context.js';
import { RunLog } from '../src/run/run-log.js';

const RUN_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-z]{4}$/;

describe('createRun', () => {
  let cwd: string;
  const config = configSchema.parse({
    baseUrl: 'http://localhost:3000',
    interaction: 'safe',
    acknowledgement: { disposableData: true, acknowledgedAt: '2026-10-20T00:00:00.000Z' },
  });

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'lookover-run-context-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  test('builds the run id from local time and the injected random suffix', async () => {
    const now = new Date(2026, 9, 20, 12, 44, 55);

    const ctx = await createRun({ cwd, config, now, random: () => 'ab12' });

    expect(ctx.runId).toBe('20261020-124455-ab12');
    expect(ctx.startedAt).toBe(now);
  });

  test('zero-pads every date and time component', async () => {
    const ctx = await createRun({ cwd, config, now: new Date(2026, 0, 2, 3, 4, 5), random: () => 'zz99' });

    expect(ctx.runId).toBe('20260102-030405-zz99');
  });

  test('defaults to the current time and four random base36 characters', async () => {
    const ctx = await createRun({ cwd, config });

    expect(ctx.runId).toMatch(RUN_ID_PATTERN);
  });

  test('lays out .lookover/runs/<runId>/evidence and opens run.jsonl', async () => {
    const ctx = await createRun({
      cwd,
      config,
      now: new Date(2026, 9, 20, 12, 44, 55),
      random: () => 'ab12',
    });

    expect(ctx.lookoverDir).toBe(join(cwd, '.lookover'));
    expect(ctx.dir).toBe(join(cwd, '.lookover', 'runs', '20261020-124455-ab12'));
    expect((await stat(join(ctx.dir, 'evidence'))).isDirectory()).toBe(true);
    expect(ctx.log).toBeInstanceOf(RunLog);
    expect(basename(ctx.log.file)).toBe('run.jsonl');
    expect(dirname(ctx.log.file)).toBe(ctx.dir);
  });

  test('wires a log that writes with the run id, an evidence store rooted in the run directory and the config', async () => {
    const ctx = await createRun({ cwd, config, random: () => 'ab12' });

    const event = await ctx.log.append({ type: 'auth.lost', url: 'https://app.test/' });
    const ref = await ctx.evidence.putJson('probe', { ok: true });

    expect(event.runId).toBe(ctx.runId);
    expect(ctx.evidence).toBeInstanceOf(EvidenceStore);
    expect((await stat(ctx.evidence.resolve(ref))).isFile()).toBe(true);
    expect(ctx.evidence.resolve(ref).startsWith(ctx.dir)).toBe(true);
    expect(ctx.config).toBe(config);
  });

  test('passes onSubscriberError to the run log', async () => {
    const reported: [unknown, string][] = [];
    const ctx = await createRun({
      cwd,
      config,
      onSubscriberError: (error, event) => reported.push([error, event.type]),
    });
    const thrown = new Error('subscriber failed');
    ctx.log.subscribe(() => {
      throw thrown;
    });

    await ctx.log.append({ type: 'auth.lost', url: 'https://app.test/' });

    expect(reported).toEqual([[thrown, 'auth.lost']]);
  });
});
