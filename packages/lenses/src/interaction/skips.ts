import type { LensSkip } from '@jayslifecode/lookover-core';

/** One skip per reason, the counts of the same reason added up, in the order the reasons first appear. */
export function tally(skips: readonly LensSkip[]): LensSkip[] {
  const counts = new Map<string, number>();
  for (const { reason, count } of skips) counts.set(reason, (counts.get(reason) ?? 0) + count);
  return Array.from(counts, ([reason, count]) => ({ reason, count }));
}
