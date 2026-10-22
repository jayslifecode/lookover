import type { TokenUsage } from '@jayslifecode/lookover-core';
import { describe, expect, test } from 'vitest';
import { CACHE_READ_FACTOR, CACHE_WRITE_FACTOR, estimateUsd, PRICES_PER_MILLION } from '../src/index.js';

const MILLION = 1_000_000;
const NONE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

describe('estimateUsd', () => {
  test('estimates sonnet at $2 in / $10 out per million with cache factors, null for an unknown model', () => {
    expect(
      estimateUsd('claude-sonnet-5-5', { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 }),
    ).toBeCloseTo(3);
    expect(estimateUsd('claude-sonnet-5-5', { ...NONE, cacheRead: MILLION })).toBeCloseTo(0.2);
    expect(estimateUsd('claude-sonnet-5-5', { ...NONE, cacheWrite: MILLION })).toBeCloseTo(2.5);
    expect(CACHE_READ_FACTOR).toBe(0.1);
    expect(CACHE_WRITE_FACTOR).toBe(1.25);
    expect(estimateUsd('gpt-unknown', { ...NONE, input: MILLION })).toBeNull();
    expect(estimateUsd('toString', { ...NONE, input: MILLION })).toBeNull();
  });

  test('prices haiku and opus from the same table', () => {
    expect(PRICES_PER_MILLION).toEqual({
      'claude-sonnet-5-5': { input: 2, output: 10 },
      'claude-haiku-5-5': { input: 0.1, output: 0.5 },
      'claude-opus-5-5': { input: 4, output: 20 },
    });
    expect(estimateUsd('claude-haiku-5-5', { ...NONE, input: MILLION, output: MILLION })).toBeCloseTo(0.6);
    expect(estimateUsd('claude-opus-5-5', { ...NONE, input: MILLION, output: MILLION })).toBeCloseTo(24);
  });

  test('a call that used no tokens costs nothing', () => {
    expect(estimateUsd('claude-sonnet-5-5', NONE)).toBe(0);
  });
});
