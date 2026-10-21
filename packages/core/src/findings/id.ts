import { shortId } from '../util/hash.js';
import type { EvidenceItem, Finding, Occurrence } from './types.js';

const FINDING_ID_LENGTH = 12;

/**
 * The same rule and key give the same id on every run. For a step finding the key is
 * `${route}|${selector}` (plus `|${viewport.name}` when the rule is viewport-specific); for an
 * occurrence finding it is the rule's own group key (a normalised console message, a request's
 * `METHOD host/pattern`, a rendered text).
 */
export function findingId(ruleId: string, key: string): string {
  return shortId(`${ruleId}|${key}`, FINDING_ID_LENGTH);
}

/**
 * Folds findings with the same `id` into one, in the order each id first appears. Occurrence findings
 * gain the occurrences and evidence of the later ones they repeat (an occurrence is told apart by
 * screen, selector and viewport name, a piece of evidence by its ref id; the first seen wins). Any
 * other repeat is dropped in favour of the first. Builds new arrays and objects; the input is untouched.
 */
export function mergeFindings(findings: readonly Finding[]): Finding[] {
  const byId = new Map<string, Finding>();
  for (const finding of findings) {
    const known = byId.get(finding.id);
    byId.set(finding.id, known === undefined ? finding : combine(known, finding));
  }
  return [...byId.values()];
}

function combine(known: Finding, repeat: Finding): Finding {
  if (known.shape !== 'occurrence' || repeat.shape !== 'occurrence') return known;
  return {
    ...known,
    occurrences: uniqueBy([...known.occurrences, ...repeat.occurrences], occurrenceKey),
    evidence: uniqueBy([...known.evidence, ...repeat.evidence], evidenceKey),
  };
}

function occurrenceKey(occurrence: Occurrence): string {
  return JSON.stringify([occurrence.screenId, occurrence.selector, occurrence.viewport.name]);
}

function evidenceKey(item: EvidenceItem): string {
  return item.ref.id;
}

function uniqueBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
