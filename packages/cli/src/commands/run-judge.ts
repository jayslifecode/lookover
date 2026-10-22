import {
  defaultObservers,
  type Judge,
  type Lens,
  type LookoverConfig,
  type RunContext,
  readDecisions,
} from '@jayslifecode/lookover-core';
import {
  createAnthropicJudge,
  createDecisionsOnlyJudge,
  JudgePipeline,
  type PipelineOptions,
} from '@jayslifecode/lookover-judge';
import type { RunOptions } from './run-options.js';

/** The environment variable the judge model's API key is read from; nothing else holds it. */
export const API_KEY_ENV = 'ANTHROPIC_API_KEY';

export interface CreateJudgeOptions {
  readonly ctx: RunContext;
  /** The run's lenses: the harness reproduces each lens finding through the lens that reported it. */
  readonly lenses: readonly Lens[];
  /** The run's config (with this run's flags applied). */
  readonly config: LookoverConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly flags: Pick<RunOptions, 'isJudged' | 'judgeModel'>;
  /** Lookover's own version, recorded in every judgement's environment. */
  readonly lookoverVersion: string;
}

/**
 * The judge of a `lookover run`: a `JudgePipeline` (see `pipelineOptions`), or with `--no-judge` a judge
 * that reproduces nothing and only applies the project's decisions, so a finding marked intended stays
 * out either way. Fails with `E_RUN_FAILED` when the decisions cannot be read.
 */
export async function createJudge(options: CreateJudgeOptions): Promise<Judge> {
  if (!options.flags.isJudged) {
    const decisions = await readDecisions(options.ctx.lookoverDir);
    return createDecisionsOnlyJudge({ ctx: options.ctx, decisions });
  }
  return new JudgePipeline(await pipelineOptions(options));
}

/**
 * What a judged run's pipeline is built from. The project's decisions are read from the lookover
 * directory, and each reproduction attempt gets fresh default observers. The judge model is
 * `--judge-model`, else `config.model.judge`, asked only when `ANTHROPIC_API_KEY` holds a key; without
 * one the harness decides alone (`unavailable: 'no-api-key'`).
 */
export async function pipelineOptions(options: CreateJudgeOptions): Promise<PipelineOptions> {
  const { ctx, lenses, config, env, flags, lookoverVersion } = options;
  const decisions = await readDecisions(ctx.lookoverDir);
  // An empty key would let the SDK look for other credentials on the machine: it counts as none.
  const apiKey = env[API_KEY_ENV]?.trim() ?? '';
  const model =
    apiKey === '' ? null : createAnthropicJudge({ apiKey, model: flags.judgeModel ?? config.model.judge });
  return {
    ctx,
    lenses,
    observers: () => defaultObservers(ctx),
    viewports: config.viewports,
    interaction: config.interaction,
    model,
    unavailable: model === null ? 'no-api-key' : null,
    decisions,
    lookoverVersion,
  };
}
