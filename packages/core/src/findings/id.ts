import { ruleById } from '@jayslifecode/lookover-rules';
import { shortId } from '../util/hash.js';
import { fixPromptFor } from './fix-prompt.js';
import type { EvidenceItem, Finding, Occurrence, OccurrenceFinding } from './types.js';

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
 * screen, selector and viewport name, a piece of evidence by its ref id; the first seen wins), and when
 * that changes the list of occurrences, the fix prompt is built again to list them all, led by the first
 * one's route and URL (`observed` stays the first finding's). Any other repeat is dropped in favour of
 * the first. Builds new arrays and objects; the input is untouched. Throws, as `ruleById` does, for an
 * occurrence finding whose rule is not in the catalogue and whose occurrences changed.
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
  const merged: OccurrenceFinding = {
    ...known,
    occurrences: uniqueBy([...known.occurrences, ...repeat.occurrences], occurrenceKey),
    evidence: uniqueBy([...known.evidence, ...repeat.evidence], evidenceKey),
  };
  return merged.occurrences.length === known.occurrences.length ? merged : withRebuiltFixPrompt(merged);
}

/** The prompt of the first screen alone no longer fits; list every occurrence, the first one's page leading. */
function withRebuiltFixPrompt(finding: OccurrenceFinding): OccurrenceFinding {
  const [lead] = finding.occurrences;
  if (lead === undefined) return finding;
  const fixPrompt = fixPromptFor({
    rule: ruleById(finding.rule.id),
    route: lead.route,
    url: lead.url,
    target: null,
    observed: finding.observed,
    occurrences: finding.occurrences,
  });
  return { ...finding, fixPrompt };
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
