import {
  type EvidenceItem,
  type Finding,
  LookoverError,
  type RunContext,
  type StepFinding,
} from '@jayslifecode/lookover-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createFakeJudge,
  FAKE_JUDGE_USAGE,
  JudgePipeline,
  type PipelineOptions,
  readCachedVerdict,
  type Verdict,
  writeCachedVerdict,
} from '../src/index.js';
import { VIEWPORT } from './helpers/bundle-fixtures.js';
import {
  attemptsFor,
  candidatesFile,
  eventsOf,
  focusOn,
  NO_DECISIONS,
  NOW,
  openRun,
  screenAt,
  stubHarness,
  UNUSED_SESSION,
} from './helpers/pipeline-bed.js';

/*
 * What the pipeline does when the files around a model call fail: the evidence a bundle is built from,
 * and the verdict cache on either side of the call. None of them fails the run; a LookoverError still does.
 */

vi.mock('../src/model/cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/model/cache.js')>();
  return {
    ...actual,
    readCachedVerdict: vi.fn(actual.readCachedVerdict),
    writeCachedVerdict: vi.fn(actual.writeCachedVerdict),
  };
});

const CONFIRM: Verdict = {
  verdict: 'confirm',
  attribution: 'product-defect',
  oracle: 'WCAG 2.2 2.4.7 Focus Visible',
  note: 'The Save button shows no outline when it is reached with the keyboard.',
};
const SETTINGS = screenAt('screen-settings', '/settings');
/** A crop the finding names that was never written to the run's evidence. */
const MISSING_CROP: EvidenceItem = {
  kind: 'crop',
  label: 'at rest',
  ref: { id: '0123456789abcdef', path: 'evidence/0123456789abcdef.png', bytes: 512, kind: 'png' },
};

let ctx: RunContext;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ ctx, close } = await openRun());
});

afterEach(async () => {
  vi.mocked(readCachedVerdict).mockReset();
  vi.mocked(writeCachedVerdict).mockReset();
  vi.restoreAllMocks();
  await close();
});

function permissionDenied(operation: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EACCES: permission denied, ${operation}`), { code: 'EACCES' });
}

function withUnreadableCrop(finding: StepFinding): StepFinding {
  return { ...finding, evidence: [MISSING_CROP] };
}

/** A pipeline whose harness reproduces everything 3/3, asking a model that confirms. */
function pipelineWith(overrides: Partial<PipelineOptions> = {}) {
  const model = createFakeJudge(() => CONFIRM);
  const harness = stubHarness((batch) => attemptsFor(batch, () => 3));
  const pipeline = new JudgePipeline({
    ctx,
    lenses: [],
    observers: () => [],
    viewports: [VIEWPORT],
    interaction: 'safe',
    model,
    unavailable: null,
    decisions: NO_DECISIONS,
    lookoverVersion: '0.0.0-test',
    now: () => NOW,
    harness: harness.factory,
    concurrency: 1,
    ...overrides,
  });
  return { pipeline, model };
}

async function judged(pipeline: JudgePipeline, findings: readonly Finding[]) {
  pipeline.attach(UNUSED_SESSION);
  pipeline.onScreenInspected(SETTINGS, [...findings], []);
  return (await pipeline.drain(candidatesFile(ctx, findings))).file;
}

describe('JudgePipeline around a model call', () => {
  test('evidence that cannot be read skips the judge for that finding alone, which the harness confirms', async () => {
    const unreadable = withUnreadableCrop(focusOn(SETTINGS, '#unreadable'));
    const readable = focusOn(SETTINGS);
    const { pipeline, model } = pipelineWith();

    const file = await judged(pipeline, [unreadable, readable]);

    const [skipped, asked] = file.findings;
    expect(skipped).toMatchObject({
      id: unreadable.id,
      status: 'confirmed',
      judgement: { decidedBy: 'harness', attribution: 'product-defect', model: null, usage: null },
    });
    expect(skipped?.judgement?.note).toMatch(/^judge skipped: evidence unreadable \(ENOENT: no such file/);
    expect(skipped?.judgement?.note).not.toContain('\n');
    // The model is still asked about the next finding: an unreadable crop is not a model failure.
    expect(asked).toMatchObject({ id: readable.id, status: 'confirmed', judgement: { decidedBy: 'model' } });
    expect(model.calls).toHaveLength(1);
    expect(file.judge).toMatchObject({ calls: 1, usage: FAKE_JUDGE_USAGE, unavailable: null });
    expect(await eventsOf(ctx, 'judge.unavailable')).toEqual([]);
  });

  test('a verdict that cannot be cached is kept, and its call counted', async () => {
    vi.mocked(writeCachedVerdict).mockRejectedValueOnce(permissionDenied('open .lookover/cache/judge'));
    const finding = focusOn(SETTINGS);
    const { pipeline, model } = pipelineWith();

    const file = await judged(pipeline, [finding]);

    expect(file.findings).toMatchObject([
      {
        id: finding.id,
        status: 'confirmed',
        judgement: { decidedBy: 'model', note: CONFIRM.note, usage: FAKE_JUDGE_USAGE, cached: false },
      },
    ]);
    expect(model.calls).toHaveLength(1);
    expect(writeCachedVerdict).toHaveBeenCalledTimes(1);
    expect(file.judge).toMatchObject({ calls: 1, cacheHits: 0, usage: FAKE_JUDGE_USAGE, unavailable: null });
    expect(await eventsOf(ctx, 'judge.unavailable')).toEqual([]);
  });

  test('a verdict cache that cannot be read is a miss: the model is asked', async () => {
    vi.mocked(readCachedVerdict).mockRejectedValueOnce(permissionDenied('open .lookover/cache/judge'));
    const finding = focusOn(SETTINGS);
    const { pipeline, model } = pipelineWith();

    const file = await judged(pipeline, [finding]);

    expect(file.findings).toMatchObject([
      { id: finding.id, status: 'confirmed', judgement: { decidedBy: 'model', cached: false } },
    ]);
    expect(model.calls).toHaveLength(1);
    expect(file.judge).toMatchObject({ calls: 1, cacheHits: 0, usage: FAKE_JUDGE_USAGE, unavailable: null });
  });

  test.each<[string, StepFinding, (failure: LookoverError) => void]>([
    [
      'reading the evidence',
      // The crop makes the bundle read evidence; the stubbed `resolve` fails before the file is looked for.
      withUnreadableCrop(focusOn(SETTINGS)),
      (failure) => {
        vi.spyOn(ctx.evidence, 'resolve').mockImplementationOnce(() => {
          throw failure;
        });
      },
    ],
    [
      'reading the verdict cache',
      focusOn(SETTINGS),
      (failure) => vi.mocked(readCachedVerdict).mockRejectedValueOnce(failure),
    ],
    [
      'writing the verdict cache',
      focusOn(SETTINGS),
      (failure) => vi.mocked(writeCachedVerdict).mockRejectedValueOnce(failure),
    ],
  ])('a LookoverError while %s still fails the drain', async (_while, finding, failWith) => {
    const failure = new LookoverError('E_RUN_FAILED', 'The run directory went away');
    failWith(failure);
    const { pipeline } = pipelineWith();

    await expect(judged(pipeline, [finding])).rejects.toBe(failure);
  });
});
