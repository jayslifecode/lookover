import type { Severity } from '@jayslifecode/lookover-core';

/*
 * How the report shows a severity: its name, and its colour as Tailwind classes, written out whole so
 * Tailwind finds them. The palettes have three severity colours (spec §11), so a blocker takes the
 * high one.
 */

export const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  blocker: 'Blocker',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** A fill in the severity's colour, with the ink that holds 4.5:1 on it (`--on-*` in tokens.css). */
export const SEVERITY_FILL: Readonly<Record<Severity, string>> = {
  blocker: 'bg-high text-on-high',
  high: 'bg-high text-on-high',
  medium: 'bg-medium text-on-medium',
  low: 'bg-low text-on-low',
};

/** A small dot in the severity's colour, beside a count or a title. */
export const SEVERITY_DOT: Readonly<Record<Severity, string>> = {
  blocker: 'bg-high',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
};
