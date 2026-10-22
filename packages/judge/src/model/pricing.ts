import type { TokenUsage } from '@jayslifecode/lookover-core';

/**
 * US dollars per million tokens, from Anthropic's price list as of 2026-10-22 (standard API rates, prompts
 * under 100K tokens). Update by hand when the prices change; a model missing here gets no estimate.
 */
export const PRICES_PER_MILLION: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-opus-5-5': { input: 4, output: 20 },
};

/**
 * A cache read costs this much of the input price, for every model here. Opus 5.5 charges less (0.05x,
 * $0.20 per million), so an Opus estimate overstates its cache reads.
 */
export const CACHE_READ_FACTOR = 0.1;
/** A cache write (the five-minute cache) costs this much of the input price. */
export const CACHE_WRITE_FACTOR = 1.25;

const TOKENS_PER_MILLION = 1_000_000;

/** What `usage` cost on `model`, in US dollars; `null` for a model the price table does not know. */
export function estimateUsd(model: string, usage: TokenUsage): number | null {
  // `hasOwn`, so `toString` and the other inherited names are unknown models rather than functions.
  if (!Object.hasOwn(PRICES_PER_MILLION, model)) return null;
  const price = PRICES_PER_MILLION[model];
  if (price === undefined) return null;
  const inputUsd =
    usage.input * price.input +
    usage.cacheRead * price.input * CACHE_READ_FACTOR +
    usage.cacheWrite * price.input * CACHE_WRITE_FACTOR;
  return (inputUsd + usage.output * price.output) / TOKENS_PER_MILLION;
}
