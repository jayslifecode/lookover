import type { Rule } from '@jayslifecode/lookover-rules';
import { fixPromptFor } from './fix-prompt.js';
import { findingId } from './id.js';
import type { EvidenceItem, Occurrence, OccurrenceFinding } from './types.js';

export interface OccurrenceFindingInput {
  rule: Rule;
  /** The rule's group key for this problem (see `findingId`); the same key gives the same finding next run. */
  key: string;
  /** Where it was seen; the first one leads the fix prompt. */
  occurrences: Occurrence[];
  /** Finishes the sentence that starts the fix prompt: `logged "Failed to load"`. */
  observed: string;
  evidence: EvidenceItem[];
  /** Defaults to now. */
  createdAt?: string;
}

/**
 * An occurrence candidate for `rule`: its id from the rule and key, its text from the rule, and a fix
 * prompt for the page of the first occurrence that lists them all. Throws when there is no occurrence,
 * because then there is no page to lead the prompt.
 */
export function occurrenceFinding(input: OccurrenceFindingInput): OccurrenceFinding {
  const { rule, key, occurrences, observed, evidence, createdAt = new Date().toISOString() } = input;
  const [lead] = occurrences;
  if (lead === undefined) {
    throw new Error(`Finding ${rule.id} needs at least one occurrence`);
  }
  return {
    shape: 'occurrence',
    id: findingId(rule.id, key),
    key,
    source: rule.source,
    rule: { id: rule.id, source: 'catalogue' },
    severity: rule.severity,
    status: 'candidate',
    title: rule.title,
    expected: rule.expected,
    observed,
    whyItMatters: rule.whyItMatters,
    evidence,
    fixPrompt: fixPromptFor({ rule, route: lead.route, url: lead.url, target: null, observed, occurrences }),
    createdAt,
    occurrences,
  };
}
