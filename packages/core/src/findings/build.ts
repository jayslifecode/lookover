import type { Rule } from '@jayslifecode/lookover-rules';
import type { Screen } from '../map/types.js';
import { fixPromptFor } from './fix-prompt.js';
import { findingId } from './id.js';
import type {
  ElementTarget,
  EvidenceItem,
  Occurrence,
  OccurrenceFinding,
  StepFinding,
  StepTrace,
} from './types.js';

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

export interface StepFindingInput {
  rule: Rule;
  /** The screen the element is on; its route and URL lead the fix prompt. */
  screen: Pick<Screen, 'id' | 'route' | 'url'>;
  target: ElementTarget;
  /** How to see it again: where to go, at what size, and what to do there. */
  trace: StepTrace;
  /** Finishes the sentence that starts with the element: `shows no change when it receives keyboard focus`. */
  observed: string;
  evidence: EvidenceItem[];
  /** Ends the key of a viewport-specific rule (the viewport's name), so each viewport is its own finding. */
  keySuffix?: string;
  /** Defaults to now. */
  createdAt?: string;
}

/**
 * A step candidate for `rule` on one element of one screen: its key is `${route}|${selector}` (and
 * `|${keySuffix}` when given), its id comes from the rule and the key, its text from the rule, and its
 * fix prompt names the element on the screen's route and URL.
 */
export function stepFinding(input: StepFindingInput): StepFinding {
  const {
    rule,
    screen,
    target,
    trace,
    observed,
    evidence,
    keySuffix,
    createdAt = new Date().toISOString(),
  } = input;
  const elementKey = `${screen.route}|${target.selector}`;
  const key = keySuffix === undefined ? elementKey : `${elementKey}|${keySuffix}`;
  return {
    shape: 'step',
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
    fixPrompt: fixPromptFor({ rule, route: screen.route, url: screen.url, target, observed }),
    createdAt,
    screenId: screen.id,
    target,
    trace,
  };
}
