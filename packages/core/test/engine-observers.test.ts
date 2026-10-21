import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { FINDINGS_FILE } from '../src/findings/persist.js';
import type { FindingsFile } from '../src/findings/types.js';
import type { Observer } from '../src/observers/types.js';
import { runReview } from '../src/run/engine.js';
import { createRun, type RunContext } from '../src/run/run-context.js';
import { RunLog } from '../src/run/run-log.js';
import { occurrence, occurrenceFinding } from './fixtures/findings.js';
import { type FixtureServer, serveFixture } from './fixtures/serve.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/observers', import.meta.url));
const BROWSER_TIMEOUT_MS = 60_000;

describe('runReview with observers', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lookover-engine-observers-'));
    // The one page is `/`: it logs an error, makes a request that is not found and shows a raw value.
    fixture = await serveFixture(FIXTURE_DIR, {
      '/': (_req, _res, serveStatic) => serveStatic('/all-three.html'),
    });
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await fixture.close();
    await rm(workDir, { recursive: true, force: true });
  }, BROWSER_TIMEOUT_MS);

  async function newProject(): Promise<{ cwd: string; ctx: RunContext }> {
    const cwd = await mkdtemp(join(workDir, 'project-'));
    const config = configSchema.parse({ baseUrl: fixture.url, interaction: 'safe', maxScreens: 1 });
    return { cwd, ctx: await createRun({ cwd, config }) };
  }

  test('uses the three default observers when none are given', async () => {
    const { cwd, ctx } = await newProject();

    const result = await runReview(ctx, { cwd });

    const ruleIds = result.findings.findings.map((finding) => finding.rule.id).toSorted();
    expect(ruleIds).toEqual([
      'observers.console-error',
      'observers.raw-value',
      'observers.request-client-error',
    ]);
    const onDisk = JSON.parse(await readFile(join(ctx.dir, FINDINGS_FILE), 'utf8')) as FindingsFile;
    expect(onDisk.findings.map((finding) => finding.rule.id).toSorted()).toEqual(ruleIds);
    const events = await RunLog.read(ctx.log.file);
    expect(events.filter((event) => event.type === 'finding.candidate')).toHaveLength(ruleIds.length);
  });

  test('an explicit empty list of observers means none', async () => {
    const { cwd, ctx } = await newProject();

    const result = await runReview(ctx, { cwd, observers: [] });

    expect(result.findings).toMatchObject({ findings: [], worthALook: [] });
  });

  test('returns the findings as written: redacted', async () => {
    const { cwd, ctx } = await newProject();
    const observer: Observer = {
      name: 'fake',
      attach: () => undefined,
      collect: async (screen) => ({
        findings: [
          occurrenceFinding({
            id: 'leaky',
            observed: 'logged "Could not send the invoice to jay@example.com"',
            occurrences: [occurrence(screen.id, null, { route: screen.route, url: screen.url })],
          }),
        ],
        worthALook: [],
        evidence: [],
      }),
    };

    const result = await runReview(ctx, { cwd, observers: [observer] });

    const [finding] = result.findings.findings;
    expect(finding?.observed).toBe('logged "Could not send the invoice to [email]"');
    expect(JSON.stringify(result.findings)).not.toContain('jay@example.com');
    const onDisk = JSON.parse(await readFile(join(ctx.dir, FINDINGS_FILE), 'utf8')) as FindingsFile;
    expect(onDisk).toEqual(result.findings);
  });
});
