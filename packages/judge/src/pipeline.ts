import { readFile } from 'node:fs/promises';
import {
  type Attempt,
  applyDecisions,
  type BrowserSession,
  type DecisionsFile,
  describeError,
  type Environment,
  type EvidenceRef,
  type Finding,
  type FindingsFile,
  type Judge,
  type JudgeOutcome,
  type JudgeTotals,
  type Lens,
  LookoverError,
  type Observer,
  type OccurrenceFinding,
  type RunContext,
  type RunEventBody,
  type Screen,
  type StepFinding,
  type TokenUsage,
  type Viewport,
} from '@jayslifecode/lookover-core';
import { ruleById } from '@jayslifecode/lookover-rules';
import { batchesFor, type ScreenBatch } from './batch.js';
import { JUDGE_CONCURRENCY, REPRODUCTION_ATTEMPTS } from './constants.js';
import {
  decideOccurrence,
  decideStep,
  evidenceUnreadableNote,
  type ModelVerdict,
  modelUnavailableNote,
  splitOccurrences,
  withKeptOccurrences,
} from './decide.js';
import { Harness, type HarnessOptions, isReproduced, targetKey } from './harness.js';
import type { JudgeModel } from './model/anthropic.js';
import { type BundleInput, bundleFor, type JudgeBundle } from './model/bundle.js';
import { readCachedVerdict, writeCachedVerdict } from './model/cache.js';
import { estimateUsd } from './model/pricing.js';
import { BoundedQueue } from './queue.js';

/** What the pipeline uses of a harness: `Harness` itself, or a test's stub. */
export type PipelineHarness = Pick<Harness, 'reproduce' | 'environment'>;

export interface PipelineOptions {
  ctx: RunContext;
  lenses: readonly Lens[];
  observers: () => readonly Observer[];
  viewports: readonly Viewport[];
  interaction: 'full' | 'safe';
  /** `null`: the harness decides alone. */
  model: JudgeModel | null;
  /** Why `model` is `null`, when it is; ignored when there is a model. */
  unavailable: JudgeTotals['unavailable'];
  decisions: DecisionsFile;
  lookoverVersion: string;
  /** Batches reproduced at once. Default `JUDGE_CONCURRENCY`. */
  concurrency?: number;
  /** The time each decision is made at. Default now, as an ISO string. */
  now?: () => string;
  /** Builds the harness once the session is attached. Default `new Harness(options)`. */
  harness?: (options: HarnessOptions) => PipelineHarness;
}

/** What the model made of one reproduced finding: its verdict, or why the harness decides alone. */
interface ModelAnswer {
  verdict: ModelVerdict | null;
  /** The note of a harness decision made because the model was unavailable. */
  note: string | null;
}

/** A finding's bundle, or the note of a harness decision made because its evidence could not be read. */
type BuiltBundle = { bundle: JudgeBundle } | { note: string };

const NO_ANSWER: ModelAnswer = { verdict: null, note: null };
const NO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const UNAVAILABLE_MESSAGES: Readonly<Record<NonNullable<JudgeTotals['unavailable']>, string>> = {
  'no-api-key': 'ANTHROPIC_API_KEY is not set, so the findings are decided by reproduction alone',
  disabled: 'The judge model is turned off, so the findings are decided by reproduction alone',
  'api-error': 'The judge model failed, so the findings are decided by reproduction alone',
};

/**
 * Judges the candidates while the crawl goes on (a core `Judge`). Each inspected screen's candidates are
 * split by the user's decisions first: an intended one is logged as `finding.judged` at once and never
 * reproduced. The rest go to the harness as one batch per screen, at most `concurrency` batches at a time.
 * When a batch is back, each of its step findings is decided (see `decideStep`) and logged as
 * `finding.judged`; occurrence findings wait for `drain`, where each one's attempts from every screen are
 * decided together (see `decideOccurrence`). A step finding already queued from an earlier screen is not
 * queued again (the run keeps the first one), and worth-a-look entries are neither reproduced nor judged.
 *
 * The model is asked only about what reproduced on every attempt (a step finding, or an occurrence finding's
 * kept occurrences): the project's verdict cache first, then the model, whose verdict is cached. The first
 * error the model throws (anything but a `LookoverError`) is logged once as `judge.unavailable`; that
 * finding and every later one is decided by the harness, its note saying why. A finding whose evidence
 * cannot be read for its bundle is decided by the harness alone, its note saying so, and the model is
 * still asked about the next one; a verdict cache that cannot be read is a miss, and a verdict that
 * cannot be cached is kept, its call counted. Any other error, and a `LookoverError` from any of these,
 * fails its batch and `drain`, and no batch starts after it.
 */
export class JudgePipeline implements Judge {
  private readonly queue: BoundedQueue;
  private readonly now: () => string;
  private readonly captureViewport: Viewport;
  private harness: PipelineHarness | null = null;
  /** The ids of every finding handed to the harness. */
  private queued: ReadonlySet<string> = new Set();
  /** The intended findings, by id, as first logged. */
  private intended: ReadonlyMap<string, Finding> = new Map();
  private judgedSteps: ReadonlyMap<string, StepFinding> = new Map();
  /** Each occurrence's attempts, by `targetKey`, from every batch back so far. */
  private occurrenceAttempts: ReadonlyMap<string, readonly Attempt[]> = new Map();
  private totals: JudgeTotals;
  /** Why the model failed, once it has: from then on the harness decides alone. */
  private modelFailure: string | null = null;
  /** The last log write made outside a batch; the log writes in call order, so it settles last. */
  private lastWrite: Promise<void> = Promise.resolve();
  private writeFailure: { error: unknown } | null = null;

  constructor(private readonly options: PipelineOptions) {
    const [first] = options.viewports;
    if (first === undefined) throw new Error('The judge needs the configured viewports, and none were given');
    this.captureViewport = first;
    this.queue = new BoundedQueue(options.concurrency ?? JUDGE_CONCURRENCY);
    this.now = options.now ?? (() => new Date().toISOString());
    const { model } = options;
    this.totals = {
      model: model?.model ?? null,
      calls: 0,
      cacheHits: 0,
      usage: NO_USAGE,
      estimatedUsd: model === null ? null : estimateUsd(model.model, NO_USAGE),
      unavailable: model === null ? options.unavailable : null,
    };
  }

  attach(session: BrowserSession): void {
    const { ctx, lenses, observers, viewports, interaction, lookoverVersion } = this.options;
    const harnessOptions: HarnessOptions = {
      session,
      ctx,
      lenses,
      observers,
      viewports,
      interaction,
      lookoverVersion,
    };
    this.harness = (this.options.harness ?? ((built) => new Harness(built)))(harnessOptions);
    const reason = this.totals.unavailable;
    if (this.options.model === null && reason !== null) {
      this.logSoon({ type: 'judge.unavailable', reason, message: UNAVAILABLE_MESSAGES[reason] });
    }
  }

  /** The worth-a-look entries are neither reproduced nor judged: they pass through `drain` as they are. */
  onScreenInspected(screen: Screen, findings: readonly Finding[], _worthALook: readonly Finding[]): void {
    const harness = this.attachedHarness();
    const fresh = findings.filter((finding) => this.isFresh(finding));
    const { kept, intended } = applyDecisions(fresh, this.options.decisions, this.now());
    this.intended = new Map([...this.intended, ...intended.map((finding) => [finding.id, finding] as const)]);
    for (const finding of intended) this.logSoon({ type: 'finding.judged', finding });
    const batch = batchesFor(screen, kept);
    if (batch.targets.length === 0) return;
    this.queued = new Set([...this.queued, ...batch.targets.map(({ finding }) => finding.id)]);
    this.queue.add(() => this.judgeBatch(batch, harness));
  }

  /**
   * Waits for every batch, decides the occurrence findings and returns `file` judged: its candidates, in
   * their order, split into `findings` (the confirmed ones, and any candidate never handed to the judge),
   * `rejected` and `intended`, with the judge's totals and environment. `worthALook` and `skipped` are
   * as given.
   */
  async drain(file: FindingsFile): Promise<JudgeOutcome> {
    const harness = this.attachedHarness();
    await this.queue.idle();
    await this.writesSettled();
    let decided: Finding[] = [];
    for (const candidate of file.findings) decided = [...decided, await this.outcomeOf(candidate, harness)];
    const withStatus = (status: Finding['status']) => decided.filter((finding) => finding.status === status);
    return {
      file: {
        ...file,
        version: 2,
        findings: decided.filter(({ status }) => status === 'confirmed' || status === 'candidate'),
        rejected: [...file.rejected, ...withStatus('rejected')],
        intended: [...file.intended, ...withStatus('intended')],
        judge: { ...this.totals, usage: { ...this.totals.usage } },
        environment: harness.environment(this.captureViewport),
      },
    };
  }

  /** Not intended already, nor a step finding already queued: an occurrence finding gains occurrences. */
  private isFresh(finding: Finding): boolean {
    if (this.intended.has(finding.id)) return false;
    return finding.shape === 'occurrence' || !this.queued.has(finding.id);
  }

  private async judgeBatch(batch: ScreenBatch, harness: PipelineHarness): Promise<void> {
    const attempts = await harness.reproduce(batch);
    const newOccurrences = batch.targets
      .filter((target) => 'occurrence' in target && !this.occurrenceAttempts.has(targetKey(target)))
      .map((target) => [targetKey(target), attempts.get(targetKey(target)) ?? []] as const);
    this.occurrenceAttempts = new Map([...this.occurrenceAttempts, ...newOccurrences]);
    const environment = harness.environment(batch.screen.viewport);
    const steps = batch.targets.flatMap((target) => ('occurrence' in target ? [] : [target.finding]));
    for (const finding of steps) {
      const judged = await this.judgeStep(finding, attempts.get(targetKey({ finding })) ?? [], environment);
      this.judgedSteps = new Map([...this.judgedSteps, [finding.id, judged]]);
      await this.options.ctx.log.append({ type: 'finding.judged', finding: judged });
    }
  }

  private async judgeStep(
    finding: StepFinding,
    attempts: readonly Attempt[],
    environment: Environment,
  ): Promise<StepFinding> {
    const isAsked = isReproduced(attempts, REPRODUCTION_ATTEMPTS);
    const answer = isAsked ? await this.askModel(finding, attempts, environment) : NO_ANSWER;
    return decideStep(finding, attempts, answer.verdict, environment, {
      judgedAt: this.now(),
      harnessNote: answer.note,
    });
  }

  /** The candidate as `drain` returns it, deciding (and logging) an occurrence finding now. */
  private async outcomeOf(candidate: Finding, harness: PipelineHarness): Promise<Finding> {
    const intended = this.intended.get(candidate.id);
    if (intended !== undefined) return { ...candidate, status: 'intended', judgement: intended.judgement };
    if (!this.queued.has(candidate.id)) return candidate;
    if (candidate.shape === 'step') return this.judgedSteps.get(candidate.id) ?? candidate;
    const judged = await this.judgeOccurrence(candidate, harness);
    await this.options.ctx.log.append({ type: 'finding.judged', finding: judged });
    return judged;
  }

  /** The model sees the occurrences that reproduced every time, and their attempts alone. */
  private async judgeOccurrence(
    finding: OccurrenceFinding,
    harness: PipelineHarness,
  ): Promise<OccurrenceFinding> {
    const split = splitOccurrences(finding, this.occurrenceAttempts);
    const [lead] = split.kept.length > 0 ? split.kept : finding.occurrences;
    const environment = harness.environment(lead?.viewport ?? this.captureViewport);
    const answer =
      split.kept.length > 0
        ? await this.askModel(withKeptOccurrences(finding, split), split.keptAttempts, environment)
        : NO_ANSWER;
    return decideOccurrence(finding, this.occurrenceAttempts, answer.verdict, environment, {
      judgedAt: this.now(),
      harnessNote: answer.note,
    });
  }

  /**
   * The cached verdict, or the model's (then cached); none without a model or after it failed, nor when
   * the finding's evidence cannot be read (the note says so). A cache that cannot be read is a miss, and
   * a verdict that cannot be cached is kept all the same.
   */
  private async askModel(
    finding: Finding,
    attempts: readonly Attempt[],
    environment: Environment,
  ): Promise<ModelAnswer> {
    const { model, ctx } = this.options;
    if (model === null) return NO_ANSWER;
    if (this.modelFailure !== null) return { verdict: null, note: modelUnavailableNote(this.modelFailure) };
    const built = await this.bundleOf(finding, attempts, environment, model.model);
    if ('note' in built) return { verdict: null, note: built.note };
    const { bundle } = built;
    const hit = await unlessFailed(
      () => readCachedVerdict(ctx.lookoverDir, bundle.hash),
      () => null,
    );
    if (hit !== null) {
      this.totals = { ...this.totals, cacheHits: this.totals.cacheHits + 1 };
      const verdict = { verdict: hit.verdict, model: hit.model, usage: null, estimatedUsd: 0, cached: true };
      return { verdict, note: null };
    }
    let answer: Awaited<ReturnType<JudgeModel['judge']>>;
    try {
      answer = await model.judge(bundle);
    } catch (error) {
      if (error instanceof LookoverError) throw error;
      return { verdict: null, note: await this.modelFailed(error) };
    }
    this.addCall(model.model, answer.usage);
    // Not cached, the verdict still stands: only the next run's cache hit is lost.
    await unlessFailed(
      () => writeCachedVerdict(ctx.lookoverDir, bundle.hash, answer.verdict, model.model),
      () => undefined,
    );
    const estimatedUsd = estimateUsd(model.model, answer.usage);
    const verdict = {
      verdict: answer.verdict,
      model: model.model,
      usage: answer.usage,
      estimatedUsd,
      cached: false,
    };
    return { verdict, note: null };
  }

  /** The finding's bundle for `model`, or the note of a harness decision when its evidence cannot be read. */
  private bundleOf(
    finding: Finding,
    attempts: readonly Attempt[],
    environment: Environment,
    model: string,
  ): Promise<BuiltBundle> {
    const { evidence } = this.options.ctx;
    const input: BundleInput = {
      finding,
      rule: ruleById(finding.rule.id),
      attempts,
      environment,
      model,
      readEvidence: (ref: EvidenceRef) => readFile(evidence.resolve(ref)),
    };
    return unlessFailed<BuiltBundle>(
      async () => ({ bundle: await bundleFor(input) }),
      (error) => ({ note: evidenceUnreadableNote(describeError(error)) }),
    );
  }

  /** Marks the model unavailable and logs it, the first time only; returns the failed finding's note. */
  private async modelFailed(error: unknown): Promise<string> {
    const message = describeError(error);
    if (this.modelFailure === null) {
      this.modelFailure = message;
      this.totals = { ...this.totals, unavailable: 'api-error' };
      await this.options.ctx.log.append({ type: 'judge.unavailable', reason: 'api-error', message });
    }
    return modelUnavailableNote(message);
  }

  private addCall(model: string, usage: TokenUsage): void {
    const { totals } = this;
    const sum: TokenUsage = {
      input: totals.usage.input + usage.input,
      output: totals.usage.output + usage.output,
      cacheRead: totals.usage.cacheRead + usage.cacheRead,
      cacheWrite: totals.usage.cacheWrite + usage.cacheWrite,
    };
    this.totals = { ...totals, calls: totals.calls + 1, usage: sum, estimatedUsd: estimateUsd(model, sum) };
  }

  private attachedHarness(): PipelineHarness {
    if (this.harness === null) throw new Error('The judge was used before a session was attached to it');
    return this.harness;
  }

  /** Queues a log write the caller cannot wait for; `drain` waits for it and throws if it failed. */
  private logSoon(body: RunEventBody): void {
    this.lastWrite = this.options.ctx.log.append(body).then(
      () => undefined,
      (error: unknown) => {
        this.writeFailure ??= { error };
      },
    );
  }

  private async writesSettled(): Promise<void> {
    await this.lastWrite;
    if (this.writeFailure !== null) throw this.writeFailure.error;
  }
}

/** What `operation` resolves to, or what `fallback` makes of its error; a `LookoverError` is rethrown. */
async function unlessFailed<T>(operation: () => Promise<T>, fallback: (error: unknown) => T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof LookoverError) throw error;
    return fallback(error);
  }
}
