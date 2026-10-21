import type { Severity } from '@jayslifecode/lookover-rules';
import type { EvidenceRef } from '../evidence/store.js';
import type { Box, Viewport } from '../map/types.js';

export type { Severity };

export type LensName = 'interaction' | 'consistency' | 'behaviour';
/** Who produced a finding: one of the lenses, or the always-on observers. */
export type FindingSource = LensName | 'observers';
/** Plan 03 adds `'confirmed' | 'rejected' | 'intended'`. */
export type FindingStatus = 'candidate';
export type ForcedState = 'hover' | 'focus' | 'active';

/** The rule a finding applies. v1 adds `{ source: 'code'; file: string; line: number }`. */
export interface RuleRef {
  id: string;
  source: 'catalogue';
}

export interface EvidenceItem {
  kind: 'screenshot' | 'crop' | 'styles' | 'console' | 'requests' | 'text' | 'measurements' | 'gallery';
  label: string;
  ref: EvidenceRef;
}

export interface ElementTarget {
  selector: string;
  role: string;
  name: string;
  /** The React component name, when the app runs in development mode and exposes it. */
  componentName: string | null;
  /**
   * The tag and the sorted class list, joined by `.` (`button.btn.primary`): controls that share it look
   * alike, so it groups findings about one component. `null` when the element could not be read.
   */
  signature: string | null;
  box: Box;
}

export type Step =
  | { kind: 'navigate'; url: string }
  | { kind: 'set-viewport'; viewport: Viewport }
  | { kind: 'force-state'; selector: string; state: ForcedState }
  | { kind: 'focus'; selector: string }
  | { kind: 'press'; key: 'Tab'; times: number }
  | { kind: 'measure'; what: string };

/** What it takes to see a step finding again: where to go, at what size, and what to do there. */
export interface StepTrace {
  route: string;
  url: string;
  viewport: Viewport;
  steps: Step[];
}

/** One place an occurrence finding was seen: a screen, and the element on it when there is one. */
export interface Occurrence {
  screenId: string;
  route: string;
  url: string;
  viewport: Viewport;
  selector: string | null;
  measured: Record<string, string | number | boolean | null>;
}

interface FindingBase {
  id: string;
  /** What makes this the same finding next run; `id` is derived from the rule id and this key. */
  key: string;
  source: FindingSource;
  rule: RuleRef;
  severity: Severity;
  status: FindingStatus;
  title: string;
  expected: string;
  observed: string;
  whyItMatters: string;
  evidence: EvidenceItem[];
  fixPrompt: string;
  createdAt: string;
}

/** One element on one screen, reproduced by `trace`. */
export type StepFinding = FindingBase & {
  shape: 'step';
  screenId: string;
  target: ElementTarget | null;
  trace: StepTrace;
};

/** One problem seen in several places: a console message, a failing request, a raw value in the text. */
export type OccurrenceFinding = FindingBase & {
  shape: 'occurrence';
  occurrences: Occurrence[];
};

export type Finding = StepFinding | OccurrenceFinding;

/** What the lenses left out across a run for one reason, and how many times. */
export interface SkipTally {
  reason: string;
  count: number;
}

/** `findings.json`: what a run found. `worthALook` holds the lower-confidence candidates. */
export interface FindingsFile {
  version: 1;
  runId: string;
  createdAt: string;
  findings: Finding[];
  worthALook: Finding[];
  /**
   * What the lenses skipped on every screen, added up per reason, the most frequent first (then by
   * reason). Absent from files written before it was added.
   */
  skipped?: SkipTally[];
}
