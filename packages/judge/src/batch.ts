import type { Finding, ReproductionTarget, Screen } from '@jayslifecode/lookover-core';

/** What the judge measures again on one screen: every target shares its URL, so one load serves them all. */
export interface ScreenBatch {
  screen: Screen;
  targets: ReproductionTarget[];
}

/**
 * The targets of `findings` on `screen`, in the order of `findings`: a step finding is a target of its own
 * screen only, and an occurrence finding contributes one target for each of its occurrences on `screen`.
 */
export function batchesFor(screen: Screen, findings: readonly Finding[]): ScreenBatch {
  return { screen, targets: findings.flatMap((finding) => targetsOn(screen, finding)) };
}

function targetsOn(screen: Screen, finding: Finding): ReproductionTarget[] {
  if (finding.shape === 'step') return finding.screenId === screen.id ? [{ finding }] : [];
  return finding.occurrences
    .filter((occurrence) => occurrence.screenId === screen.id)
    .map((occurrence) => ({ finding, occurrence }));
}
