import type { Reproduction, ReproductionTarget } from '../findings/lens.js';
import type { Finding, OccurrenceFinding } from '../findings/types.js';
import type { Screen } from '../map/types.js';
import type { Observer } from './types.js';

const NOT_REPRODUCED: Reproduction = { reproduced: false, observed: null, skipped: null, evidence: [] };

/**
 * Whether an observer finding came up again on a freshly loaded page. The observers were attached to
 * that page before it navigated to `screen`; each one's `collect(screen)` is called, in order, so all of
 * them are drained, and the finding reproduced when one of them reports a finding with the target's
 * `id` that has an occurrence on `screen` (worth-a-look included: a console warning is one). Observers
 * measure the whole page, so nothing is ever skipped.
 */
export async function reproduceObservation(
  target: ReproductionTarget & { finding: OccurrenceFinding },
  observers: readonly Observer[],
  screen: Screen,
): Promise<Reproduction> {
  let seen: Finding[] = [];
  for (const observer of observers) {
    const { findings, worthALook } = await observer.collect(screen);
    seen = [...seen, ...findings, ...worthALook];
  }
  const match = seen.find(
    (finding) => finding.id === target.finding.id && hasOccurrenceOn(finding, screen.id),
  );
  if (match === undefined) return NOT_REPRODUCED;
  return { reproduced: true, observed: match.observed, skipped: null, evidence: match.evidence };
}

function hasOccurrenceOn(finding: Finding, screenId: string): boolean {
  return (
    finding.shape === 'occurrence' &&
    finding.occurrences.some((occurrence) => occurrence.screenId === screenId)
  );
}
