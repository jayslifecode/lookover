import type { Finding, FindingsFile } from './types.js';

/** How the findings changed between two runs, told apart by `id`. */
export interface FindingsDrift {
  /** In the current run and not in the previous one. */
  added: Finding[];
  /** In the previous run and not in the current one. */
  fixed: Finding[];
  /** In both; the current run's version of each. */
  unchanged: Finding[];
}

/**
 * Compares the `findings` lists of two runs by `id`, each list in its own order. `worthALook`,
 * `rejected` and `intended` are not findings and are left out. A `null` previous run (there was none)
 * makes everything added. Builds new arrays; the inputs are untouched.
 */
export function diffFindings(previous: FindingsFile | null, current: FindingsFile): FindingsDrift {
  const before = previous?.findings ?? [];
  const beforeIds = new Set(before.map((finding) => finding.id));
  const afterIds = new Set(current.findings.map((finding) => finding.id));
  return {
    added: current.findings.filter((finding) => !beforeIds.has(finding.id)),
    fixed: before.filter((finding) => !afterIds.has(finding.id)),
    unchanged: current.findings.filter((finding) => beforeIds.has(finding.id)),
  };
}
