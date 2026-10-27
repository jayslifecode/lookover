import {
  type Finding,
  LookoverError,
  mergeFindings,
  type RunContext,
  type Screen,
  type TokenUsage,
  withRebuiltFixPrompt,
} from '@jayslifecode/lookover-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createFakeJudge,
  estimateUsd,
  FAKE_JUDGE_USAGE,
  JUDGE_CONCURRENCY,
  JudgeModelError,
  JudgePipeline,
  type PipelineOptions,
  readCachedVerdict,
  type Verdict,
} from '../src/index.js';
import { MODEL, VIEWPORT } from './helpers/bundle-fixtures.js';
import {
  attemptsFor,
  candidatesFile,
  environmentAt,
  errorOn,
  eventsOf,
  focusOn,
  gate,
  NO_DECISIONS,
  NOW,
  nextEvent,
  openRun,
  screenAt,
  stubHarness,
  UNUSED_SESSION,
} from './helpers/pipeline-bed.js';

const CONFIRM: Verdict = {
  verdict: 'confirm',
  attribution: 'product-defect',
  oracle: 'WCAG 2.2 2.4.7 Focus Visible',
  note: 'The Save button shows no outline when it is reached with the keyboard.',
};
const EXEMPTION: Verdict = {
  verdict: 'reject',
  attribution: 'exemption',
  oracle: 'WCAG 2.2 2.4.7 Focus Visible, user agent default',
  note: 'The browser draws its own focus ring around this control, which the standard accepts.',
};
const NO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const OVERLOADED = 'The judge model call failed: 529 Overloaded';
const TIMING_NOTE = 'Reproduced 2 of 3 times; a problem that comes and goes is not reported';
const SETTINGS = screenAt('screen-settings', '/settings');

let ctx: RunContext;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ ctx, close } = await openRun());
});

afterEach(() => close());

function pipelineWith(options: Partial<PipelineOptions>): JudgePipeline {
  return new JudgePipeline({
    ctx,
    lenses: [],
    observers: () => [],
    viewports: [VIEWPORT],
    interaction: 'safe',
    model: null,
    unavailable: 'no-api-key',
    decisions: NO_DECISIONS,
    lookoverVersion: '0.0.0-test',
    now: () => NOW,
    ...options,
  });
}

/** Attaches, hands each screen its findings in turn, and drains the run's merged candidates. */
async function judgeRun(pipeline: JudgePipeline, screens: readonly [Screen, Finding[]][]) {
  pipeline.attach(UNUSED_SESSION);
  for (const [screen, findings] of screens) pipeline.onScreenInspected(screen, findings, []);
  const merged = mergeFindings(screens.flatMap(([, findings]) => findings));
  return (await pipeline.drain(candidatesFile(ctx, merged))).file;
}

describe('JudgePipeline', () => {
  test('a config with no viewports is refused as the engine refuses it, as an invalid config', () => {
    let failure: unknown = null;
    try {
      pipelineWith({ viewports: [] });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(LookoverError);
    expect(failure).toMatchObject({
      code: 'E_CONFIG_INVALID',
      message: 'lookover.config.json lists no viewports, so there is nothing to capture screens at',
      hint: 'Add a viewport to "viewports", such as { "name": "desktop", "width": 1440, "height": 900 }',
    });
  });

  test('a 3/3 step finding is confirmed by the harness without a model', async () => {
    const finding = focusOn(SETTINGS);
    const harness = stubHarness((batch) => attemptsFor(batch, () => 3));

    const file = await judgeRun(pipelineWith({ harness: harness.factory }), [[SETTINGS, [finding]]]);

    const [confirmed] = file.findings;
    expect(file.findings).toHaveLength(1);
    expect(confirmed).toMatchObject({
      id: finding.id,
      status: 'confirmed',
      judgement: {
        reproduced: 3,
        of: 3,
        decidedBy: 'harness',
        attribution: 'product-defect',
        oracle: null,
        note: null,
        model: null,
        usage: null,
        estimatedUsd: null,
        cached: false,
        droppedOccurrences: [],
        environment: environmentAt(VIEWPORT),
        judgedAt: NOW,
      },
    });
    expect(confirmed?.judgement?.attempts).toHaveLength(3);
    expect(file).toMatchObject({
      version: 2,
      rejected: [],
      intended: [],
      environment: environmentAt(VIEWPORT),
    });
    expect(file.judge).toEqual({
      model: null,
      calls: 0,
      cacheHits: 0,
      usage: NO_USAGE,
      estimatedUsd: null,
      unavailable: 'no-api-key',
    });
    expect(await eventsOf(ctx, 'judge.unavailable')).toMatchObject([{ reason: 'no-api-key' }]);
    expect((await eventsOf(ctx, 'finding.judged')).map((event) => event.finding)).toEqual([confirmed]);
  });

  test('a 2/3 step finding is rejected as timing and the model is not asked', async () => {
    const finding = focusOn(SETTINGS);
    const model = createFakeJudge(() => CONFIRM);
    const harness = stubHarness((batch) => attemptsFor(batch, () => 2));

    const file = await judgeRun(pipelineWith({ harness: harness.factory, model, unavailable: null }), [
      [SETTINGS, [finding]],
    ]);

    expect(file.findings).toEqual([]);
    expect(file.rejected).toMatchObject([
      {
        id: finding.id,
        status: 'rejected',
        judgement: {
          reproduced: 2,
          of: 3,
          decidedBy: 'harness',
          attribution: 'timing',
          note: TIMING_NOTE,
          model: null,
        },
      },
    ]);
    expect(model.calls).toEqual([]);
    expect(file.judge).toMatchObject({ model: 'fake-judge', calls: 0, unavailable: null });
    expect(await eventsOf(ctx, 'judge.unavailable')).toEqual([]);
  });

  test('a reproduced finding the model rejects as exemption is rejected with its note', async () => {
    const finding = focusOn(SETTINGS);
    const model = createFakeJudge(() => EXEMPTION);
    const harness = stubHarness((batch) => attemptsFor(batch, () => 3));

    const file = await judgeRun(pipelineWith({ harness: harness.factory, model, unavailable: null }), [
      [SETTINGS, [finding]],
    ]);

    expect(file.findings).toEqual([]);
    expect(file.rejected).toMatchObject([
      {
        id: finding.id,
        status: 'rejected',
        judgement: {
          reproduced: 3,
          decidedBy: 'model',
          attribution: 'exemption',
          oracle: EXEMPTION.oracle,
          note: EXEMPTION.note,
          model: 'fake-judge',
          usage: FAKE_JUDGE_USAGE,
          cached: false,
        },
      },
    ]);
    const [bundle] = model.calls;
    expect(model.calls).toHaveLength(1);
    expect(bundle?.text).toContain('3 of 3 attempts reproduced it.');
    expect(await readCachedVerdict(ctx.lookoverDir, bundle?.hash ?? '')).toEqual({
      verdict: EXEMPTION,
      model: 'fake-judge',
    });
  });

  test('an intended finding is neither reproduced nor judged and is logged judged at once', async () => {
    const decided = focusOn(SETTINGS, '#decided');
    const other = focusOn(SETTINGS);
    const held = gate();
    const harness = stubHarness(async (batch) => {
      await held.promise;
      return attemptsFor(batch, () => 3);
    });
    const model = createFakeJudge(() => CONFIRM);
    const decisions = {
      version: 1 as const,
      decisions: {
        [decided.id]: { status: 'intended' as const, at: NOW, note: 'The outline is on the wrapper' },
      },
    };
    const pipeline = pipelineWith({ harness: harness.factory, model, unavailable: null, decisions });
    const firstJudged = nextEvent(ctx, 'finding.judged');

    pipeline.attach(UNUSED_SESSION);
    pipeline.onScreenInspected(SETTINGS, [decided, other], []);

    // Logged while the harness still holds the screen's batch.
    expect((await firstJudged).finding).toMatchObject({
      id: decided.id,
      status: 'intended',
      judgement: { decidedBy: 'user', of: 0, attempts: [], note: 'The outline is on the wrapper' },
    });
    held.open();
    const { file } = await pipeline.drain(candidatesFile(ctx, [decided, other]));
    expect(harness.batches.map(({ targets }) => targets.map(({ finding }) => finding.id))).toEqual([
      [other.id],
    ]);
    expect(model.calls).toHaveLength(1);
    expect(file.intended).toMatchObject([{ id: decided.id, status: 'intended' }]);
    expect(file.findings.map(({ id }) => id)).toEqual([other.id]);
    const judged = (await eventsOf(ctx, 'finding.judged')).map(({ finding }) => finding.id);
    expect(judged).toEqual([decided.id, other.id]);
  });

  test('batches run at most two at a time and step findings stream as finding.judged before drain', async () => {
    const screens = ['a', 'b', 'c'].map((name) => screenAt(`screen-${name}`, `/${name}`));
    const findings = screens.map((screen) => focusOn(screen));
    const gates = new Map(screens.map((screen) => [screen.id, gate()]));
    let running = 0;
    let most = 0;
    const harness = stubHarness(async (batch) => {
      running += 1;
      most = Math.max(most, running);
      await gates.get(batch.screen.id)?.promise;
      running -= 1;
      return attemptsFor(batch, () => 3);
    });
    const pipeline = pipelineWith({ harness: harness.factory });
    pipeline.attach(UNUSED_SESSION);
    screens.forEach((screen, index) => {
      pipeline.onScreenInspected(screen, [findings[index] as Finding], []);
    });

    await vi.waitFor(() => expect(harness.batches).toHaveLength(JUDGE_CONCURRENCY));
    expect(harness.batches.map(({ screen }) => screen.id)).toEqual(['screen-a', 'screen-b']);
    const firstJudged = nextEvent(ctx, 'finding.judged');
    gates.get('screen-a')?.open();
    expect((await firstJudged).finding).toMatchObject({ id: findings[0]?.id, status: 'confirmed' });
    await vi.waitFor(() => expect(harness.batches).toHaveLength(3));
    for (const held of gates.values()) held.open();
    const { file } = await pipeline.drain(candidatesFile(ctx, findings));

    expect(most).toBe(JUDGE_CONCURRENCY);
    expect(file.findings.map(({ id }) => id)).toEqual(findings.map(({ id }) => id));
  });

  test('occurrence findings keep the occurrences that reproduced on every attempt and drop the rest, rebuilding the fix prompt', async () => {
    const home = screenAt('screen-home', '/');
    const reports = screenAt('screen-reports', '/reports');
    const onHome = errorOn('Failed to load the chart', [home]);
    const onReports = errorOn('Failed to load the chart', [reports]);
    const [merged] = mergeFindings([onHome, onReports]);
    const model = createFakeJudge(() => CONFIRM);
    const harness = stubHarness((batch) =>
      attemptsFor(batch, (target) =>
        'occurrence' in target && target.occurrence.screenId === home.id ? 3 : 1,
      ),
    );
    const pipeline = pipelineWith({ harness: harness.factory, model, unavailable: null });
    pipeline.attach(UNUSED_SESSION);
    pipeline.onScreenInspected(home, [onHome], []);
    pipeline.onScreenInspected(reports, [onReports], []);

    await vi.waitFor(() => expect(harness.answered()).toBe(2));
    // Decided once, at the drain, from every screen's attempts.
    expect(await eventsOf(ctx, 'finding.judged')).toEqual([]);
    const { file } = await pipeline.drain(candidatesFile(ctx, merged === undefined ? [] : [merged]));

    const [kept] = file.findings;
    expect(merged?.fixPrompt).toContain('/reports');
    expect(kept).toMatchObject({
      id: onHome.id,
      status: 'confirmed',
      occurrences: onHome.occurrences,
      fixPrompt: withRebuiltFixPrompt({ ...onHome, occurrences: onHome.occurrences }).fixPrompt,
      judgement: { reproduced: 1, of: 2, droppedOccurrences: onReports.occurrences, decidedBy: 'model' },
    });
    expect(kept?.fixPrompt).not.toContain('/reports');
    expect(kept?.judgement?.attempts).toHaveLength(6);
    // The model sees the kept occurrence and its attempts alone.
    const [bundle] = model.calls;
    expect(bundle?.text).toContain('3 of 3 attempts reproduced it.');
    expect(bundle?.text).not.toContain('/reports');
    expect((await eventsOf(ctx, 'finding.judged')).map(({ finding }) => finding)).toEqual([kept]);
  });

  test('a model error keeps the finding confirmed by the harness, logs judge.unavailable once, and marks the totals', async () => {
    const screens = [SETTINGS, screenAt('screen-profile', '/profile')];
    const findings = screens.map((screen) => focusOn(screen));
    const model = createFakeJudge(() => new JudgeModelError('api-error', OVERLOADED, { status: 529 }));
    const harness = stubHarness((batch) => attemptsFor(batch, () => 3));
    const pipeline = pipelineWith({ harness: harness.factory, model, unavailable: null, concurrency: 1 });

    const file = await judgeRun(
      pipeline,
      screens.map((screen, index) => [screen, [findings[index] as Finding]]),
    );

    expect(file.findings.map(({ status }) => status)).toEqual(['confirmed', 'confirmed']);
    for (const confirmed of file.findings) {
      expect(confirmed.judgement).toMatchObject({ decidedBy: 'harness', attribution: 'product-defect' });
      expect(confirmed.judgement?.note).toContain('judge model');
      expect(confirmed.judgement?.note).toContain('529 Overloaded');
    }
    // The second finding came after the failure: it was not asked about.
    expect(model.calls).toHaveLength(1);
    expect(await eventsOf(ctx, 'judge.unavailable')).toMatchObject([
      { reason: 'api-error', message: OVERLOADED },
    ]);
    expect(file.judge).toMatchObject({
      model: 'fake-judge',
      calls: 0,
      usage: NO_USAGE,
      unavailable: 'api-error',
    });
  });

  test('a LookoverError from the harness fails the drain, and no batch starts after it', async () => {
    const failure = new LookoverError('E_NAVIGATION_BLOCKED', 'The replay left the allowed hosts');
    const harness = stubHarness(() => Promise.reject(failure));
    const pipeline = pipelineWith({ harness: harness.factory, concurrency: 1 });
    const later = screenAt('screen-profile', '/profile');

    pipeline.attach(UNUSED_SESSION);
    pipeline.onScreenInspected(SETTINGS, [focusOn(SETTINGS)], []);
    pipeline.onScreenInspected(later, [focusOn(later)], []);

    await expect(pipeline.drain(candidatesFile(ctx, []))).rejects.toBe(failure);
    expect(harness.batches.map(({ screen }) => screen.id)).toEqual([SETTINGS.id]);
  });

  test('totals add usage, cache hits and estimated cost across findings', async () => {
    const [cachedOne, ...asked] = ['#first', '#second', '#third'].map((selector) =>
      focusOn(SETTINGS, selector),
    );
    const harness = stubHarness((batch) => attemptsFor(batch, () => 3));
    // An earlier run judged the first one, so its verdict is in the project's cache.
    const earlier = pipelineWith({
      harness: harness.factory,
      model: createFakeJudge(() => CONFIRM, MODEL),
      unavailable: null,
    });
    await judgeRun(earlier, [[SETTINGS, [cachedOne as Finding]]]);
    const model = createFakeJudge(() => CONFIRM, MODEL);

    const file = await judgeRun(pipelineWith({ harness: harness.factory, model, unavailable: null }), [
      [SETTINGS, [cachedOne as Finding, ...asked]],
    ]);

    const perCall = estimateUsd(MODEL, FAKE_JUDGE_USAGE) ?? Number.NaN;
    expect(model.calls).toHaveLength(2);
    expect(file.judge).toMatchObject({
      model: MODEL,
      calls: 2,
      cacheHits: 1,
      usage: {
        input: 2 * FAKE_JUDGE_USAGE.input,
        output: 2 * FAKE_JUDGE_USAGE.output,
        cacheRead: 0,
        cacheWrite: 0,
      },
      unavailable: null,
    });
    expect(file.judge?.estimatedUsd).toBeCloseTo(2 * perCall, 10);
    const [first, second, third] = file.findings.map(({ judgement }) => judgement);
    expect(first).toMatchObject({
      decidedBy: 'model',
      model: MODEL,
      cached: true,
      usage: null,
      estimatedUsd: 0,
    });
    for (const judgement of [second, third]) {
      expect(judgement).toMatchObject({ cached: false, usage: FAKE_JUDGE_USAGE, estimatedUsd: perCall });
    }
  });
});
