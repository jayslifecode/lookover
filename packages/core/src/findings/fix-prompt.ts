import type { Rule } from '@jayslifecode/lookover-rules';
import type { ElementTarget, Occurrence } from './types.js';

const MAX_LISTED_OCCURRENCES = 10;
const CLOSING_LINE_FOR_ELEMENT = "Keep the control's accessible name, then tell me which file you changed.";
/** A finding with no element (a console error, a failed request) has no control whose name to keep. */
const CLOSING_LINE_WITHOUT_ELEMENT = 'Tell me which file you changed.';

export interface FixPromptInput {
  rule: Rule;
  route: string;
  url: string;
  target: ElementTarget | null;
  /** Finishes the sentence that starts with the element: `shows no change when it receives keyboard focus`. */
  observed: string;
  occurrences?: readonly Occurrence[];
}

/**
 * The prompt a builder pastes into their coding agent: where the problem is, what the rule expects and
 * why it matters, how to fix it and (when the rule has one) the standard behind it. The first line names
 * the element; with no target it is just the route and the observation, and the last line no longer asks
 * to keep the control's accessible name. A finding seen in several places lists them (at most 10) under it.
 */
export function fixPromptFor(input: FixPromptInput): string {
  const { rule, target, occurrences = [] } = input;
  return [
    firstLine(input),
    ...occurrenceLines(occurrences),
    `Rule: ${rule.title}. Expected: ${rule.expected} ${rule.whyItMatters}`,
    fixLine(rule),
    target === null ? CLOSING_LINE_WITHOUT_ELEMENT : CLOSING_LINE_FOR_ELEMENT,
  ].join('\n');
}

function firstLine({ route, url, target, observed }: FixPromptInput): string {
  const where = `In ${route} (${url}), `;
  if (target === null) return `${where}${observed}.`;
  const component = target.componentName === null ? '' : `, React component ${target.componentName}`;
  return `${where}the ${target.role} "${target.name}" (selector \`${target.selector}\`${component}) ${observed}.`;
}

function fixLine({ fixHint, reference }: Rule): string {
  if (reference === null) return `Fix: ${fixHint}`;
  return `Fix: ${fixHint} Reference: ${reference.standard} ${reference.criterion} (${reference.url}).`;
}

function occurrenceLines(occurrences: readonly Occurrence[]): string[] {
  if (occurrences.length === 0) return [];
  const rest = occurrences.length - MAX_LISTED_OCCURRENCES;
  return [
    `Occurrences (${occurrences.length}):`,
    ...occurrences.slice(0, MAX_LISTED_OCCURRENCES).map(occurrenceLine),
    ...(rest > 0 ? [`… and ${rest} more`] : []),
  ];
}

function occurrenceLine({ route, selector, measured }: Occurrence): string {
  const where = `${route} ${selector ?? 'page'}`;
  const facts = Object.entries(measured).map(([name, value]) => `${name}=${oneLine(String(value))}`);
  return facts.length === 0 ? where : `${where} — ${facts.join(', ')}`;
}

/** A measured value such as a console message can span lines; the list keeps one line per occurrence. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
