import type { Severity } from '@jayslifecode/lookover-rules';
import type { EvidenceRef } from '../evidence/store.js';
import type { Box, Viewport } from '../map/types.js';

export type { Severity };

export type LensName = 'interaction' | 'consistency' | 'behaviour';
/** Who produced a finding: one of the lenses, or the always-on observers. */
export type FindingSource = LensName | 'observers';
/**
 * Where a finding stands: a `candidate` is what the lenses saw and nothing has judged; the judge makes it
 * `confirmed` (reproduced) or `rejected`; the user's decision makes it `intended`.
 */
export type FindingStatus = 'candidate' | 'confirmed' | 'rejected' | 'intended';
/** Why a judged finding is what it is. */
export type Attribution = 'product-defect' | 'timing' | 'explorer-error' | 'exemption';
export type DecidedBy = 'harness' | 'model' | 'user';
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

/** Where and with what a finding was judged, so the verdict can be read in context. */
export interface Environment {
  browser: string;
  os: string;
  node: string;
  lookover: string;
  viewport: Viewport;
}

/** One attempt to see a finding again, in a fresh browser context. */
export interface Attempt {
  /** 1-based. */
  index: number;
  /** For an occurrence finding: which occurrence this attempt ran for; `null` for a step finding. */
  occurrence: { screenId: string; selector: string | null; viewport: string } | null;
  reproduced: boolean;
  /** The re-measured finding's `observed`, when it reproduced. */
  observed: string | null;
  /** The lens's skip reason, when it could not measure. */
  skipped: string | null;
  durationMs: number;
  evidence: EvidenceItem[];
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** How a finding was judged, and by whom. `null` on a finding nobody has judged. */
export interface Judgement {
  /** Step finding: the attempts that reproduced. Occurrence finding: the occurrences that reproduced every time. */
  reproduced: number;
  /** Step finding: the attempts made. Occurrence finding: the occurrences tried. `0` for a user decision. */
  of: number;
  attempts: Attempt[];
  decidedBy: DecidedBy;
  /** `null` only while `decidedBy` is `'user'`. */
  attribution: Attribution | null;
  /** The standard or rule the judge applied, at most 120 characters. */
  oracle: string | null;
  /** Plain language for the report, at most 280 characters. */
  note: string | null;
  /** The model id, when the model decided. */
  model: string | null;
  usage: TokenUsage | null;
  estimatedUsd: number | null;
  /** The verdict came from the judge cache. */
  cached: boolean;
  /** Occurrence findings: the occurrences that did not reproduce. */
  droppedOccurrences: Occurrence[];
  /** `null` for a user decision. */
  environment: Environment | null;
  judgedAt: string;
}

/** What the judge model cost across a run. */
export interface JudgeTotals {
  model: string | null;
  calls: number;
  cacheHits: number;
  usage: TokenUsage;
  estimatedUsd: number | null;
  /** Why no model was used, when it was not. */
  unavailable: 'no-api-key' | 'disabled' | 'api-error' | null;
}

interface FindingBase {
  id: string;
  /** What makes this the same finding next run; `id` is derived from the rule id and this key. */
  key: string;
  source: FindingSource;
  rule: RuleRef;
  severity: Severity;
  status: FindingStatus;
  /** How the judge or the user decided; `null` while the finding is a candidate. */
  judgement: Judgement | null;
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

/**
 * `findings.json`: what a run found. `findings` holds the candidates of a run that was not judged
 * (`--no-judge`) or the confirmed findings of one that was; `worthALook` holds the lower-confidence
 * candidates. `rejected` and `intended` are kept apart, for transparency, so a reader never mistakes
 * them for findings.
 */
export interface FindingsFile {
  version: 2;
  runId: string;
  createdAt: string;
  findings: Finding[];
  worthALook: Finding[];
  /**
   * What the lenses skipped on every screen, added up per reason, the most frequent first (then by
   * reason). Absent from files written before it was added.
   */
  skipped?: SkipTally[];
  /** Judged and not reproduced, or explained away. Never listed as findings. */
  rejected: Finding[];
  /** Decided by the user to be on purpose (`decisions.json`). Never listed as findings. */
  intended: Finding[];
  /** What the judge model cost; `null` for a run that was not judged. */
  judge: JudgeTotals | null;
  /** Where the judge ran; `null` for a run that was not judged. */
  environment: Environment | null;
}
