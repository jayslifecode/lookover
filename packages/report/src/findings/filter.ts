import type { Finding, Severity } from '@jayslifecode/lookover-core';

/*
 * The Findings view's filters, as pure functions over a finding: by severity and by lens (none chosen:
 * all), and a search over the title, the routes and the selectors, ignoring case. Which list is filtered
 * (confirmed or intended) is the view's choice; the filters apply to the worth-a-look entries too.
 */

export const LENS_FILTERS = ['interaction', 'observers'] as const;
export type LensFilter = (typeof LENS_FILTERS)[number];
export type StatusFilter = 'confirmed' | 'intended';

export interface FindingFilters {
  readonly severities: ReadonlySet<Severity>;
  readonly lenses: ReadonlySet<LensFilter>;
  readonly status: StatusFilter;
  readonly query: string;
}

export const NO_FILTERS: FindingFilters = {
  severities: new Set(),
  lenses: new Set(),
  status: 'confirmed',
  query: '',
};

/** `set` with `value` added, or taken out when it was in; a new set. */
export function toggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  return set.has(value) ? new Set([...set].filter((known) => known !== value)) : new Set([...set, value]);
}

/** The routes `finding` was seen on, each once. */
export function routesOf(finding: Finding): string[] {
  if (finding.shape === 'step') return [finding.trace.route];
  return [...new Set(finding.occurrences.map((occurrence) => occurrence.route))];
}

function selectorsOf(finding: Finding): string[] {
  if (finding.shape === 'step') return finding.target === null ? [] : [finding.target.selector];
  return finding.occurrences.flatMap((occurrence) =>
    occurrence.selector === null ? [] : [occurrence.selector],
  );
}

function matchesQuery(finding: Finding, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  const haystack = [finding.title, ...routesOf(finding), ...selectorsOf(finding)];
  return haystack.some((text) => text.toLowerCase().includes(needle));
}

/** Whether `finding` passes the severity, lens and search filters. */
export function matchesFilters(finding: Finding, filters: FindingFilters): boolean {
  const { severities, lenses, query } = filters;
  if (severities.size > 0 && !severities.has(finding.severity)) return false;
  if (lenses.size > 0 && !(lenses as ReadonlySet<string>).has(finding.source)) return false;
  return matchesQuery(finding, query);
}

/** Whether any filter narrows the list. */
export function isFiltered(filters: FindingFilters): boolean {
  return filters.severities.size > 0 || filters.lenses.size > 0 || filters.query.trim() !== '';
}
