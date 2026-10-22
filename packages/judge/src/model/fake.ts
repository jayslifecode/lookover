import type { TokenUsage } from '@jayslifecode/lookover-core';
import type { JudgeModel } from './anthropic.js';
import type { JudgeBundle } from './bundle.js';
import { clampVerdict, type Verdict } from './schema.js';

/** What every call of a fake judge reports it used. */
export const FAKE_JUDGE_USAGE: Readonly<TokenUsage> = Object.freeze({
  input: 1_000,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
});

/**
 * A judge for tests: `script` decides each bundle, returning the verdict (cut to its limits, as the real
 * client does) or the error to throw. Every bundle it was asked about is recorded in `calls`, in order.
 */
export function createFakeJudge(
  script: (bundle: JudgeBundle) => Verdict | Error,
  model = 'fake-judge',
): JudgeModel & { calls: JudgeBundle[] } {
  const calls: JudgeBundle[] = [];
  return {
    model,
    calls,
    async judge(bundle) {
      calls.push(bundle);
      const outcome = script(bundle);
      if (outcome instanceof Error) throw outcome;
      return { verdict: clampVerdict(outcome), usage: { ...FAKE_JUDGE_USAGE } };
    },
  };
}
