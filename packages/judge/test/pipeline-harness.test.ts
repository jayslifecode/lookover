import { fileURLToPath } from 'node:url';
import {
  defaultObservers,
  type Finding,
  navigate,
  type Screen,
  type Timing,
} from '@jayslifecode/lookover-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { JudgePipeline, type PipelineOptions } from '../src/index.js';
import { candidatesFile, NO_DECISIONS } from './helpers/pipeline-bed.js';
import { DEFAULT_TEST_VIEWPORT, openTestBed, screenOf, type TestBed } from './helpers/session.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));
const BROWSER_TIMEOUT_MS = 120_000;
const TIMING: Timing = { settleMs: 500, navigationTimeoutMs: 15_000 };

describe('JudgePipeline on a real session', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let bed: TestBed;

  beforeAll(async () => {
    bed = await openTestBed(FIXTURE_DIR);
  }, BROWSER_TIMEOUT_MS);

  afterAll(() => bed.close(), BROWSER_TIMEOUT_MS);

  function pipelineWith(overrides: Partial<PipelineOptions> = {}): JudgePipeline {
    return new JudgePipeline({
      ctx: bed.ctx,
      lenses: [],
      observers: () => defaultObservers(bed.ctx),
      viewports: [DEFAULT_TEST_VIEWPORT],
      interaction: 'full',
      model: null,
      unavailable: 'no-api-key',
      decisions: NO_DECISIONS,
      lookoverVersion: '0.0.0-test',
      ...overrides,
    });
  }

  /** `path` captured as the crawl captures it, with what the observers saw there. */
  async function observed(path: string): Promise<{ screen: Screen; findings: Finding[] }> {
    const ipage = await bed.session.newIsolatedPage(DEFAULT_TEST_VIEWPORT);
    try {
      const observers = defaultObservers(bed.ctx);
      for (const observer of observers) observer.attach(ipage);
      const failure = await navigate(ipage.page, `${bed.url}${path}`, TIMING);
      if (failure !== null) throw new Error(`could not load ${path}: ${failure}`);
      const screen = await screenOf(ipage, 'screen-console', DEFAULT_TEST_VIEWPORT);
      let findings: Finding[] = [];
      for (const observer of observers) {
        findings = [...findings, ...(await observer.collect(screen)).findings];
      }
      return { screen, findings };
    } finally {
      await ipage.close();
    }
  }

  test('the real harness confirms the errors a page logs on every load, and records where', async () => {
    const { screen, findings } = await observed('/console.html');
    const pipeline = pipelineWith();

    pipeline.attach(bed.session);
    pipeline.onScreenInspected(screen, findings, []);
    const { file } = await pipeline.drain(candidatesFile(bed.ctx, findings));

    expect(file.findings.map(({ rule }) => rule.id)).toEqual(
      expect.arrayContaining(['observers.console-error', 'observers.page-error']),
    );
    expect(file.rejected).toEqual([]);
    for (const finding of file.findings) {
      expect(finding).toMatchObject({
        status: 'confirmed',
        judgement: { reproduced: 1, of: 1, decidedBy: 'harness' },
      });
      expect(finding.judgement?.attempts.map(({ reproduced }) => reproduced)).toEqual([true, true, true]);
    }
    expect(file.environment).toMatchObject({ lookover: '0.0.0-test', viewport: DEFAULT_TEST_VIEWPORT });
    expect(file.environment?.browser).toMatch(/^chromium /);
  });
});
