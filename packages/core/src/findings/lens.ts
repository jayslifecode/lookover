import type { InstrumentedPage } from '../browser/session.js';
import type { EvidenceRef } from '../evidence/store.js';
import type { Screen, Viewport } from '../map/types.js';
import type { RunContext } from '../run/run-context.js';
import type { EvidenceItem, Finding, LensName, Occurrence, OccurrenceFinding, StepFinding } from './types.js';

/** What a lens left out on a screen, and why (a cap, the deadline, a measurement it could not trust). */
export interface LensSkip {
  reason: string;
  count: number;
}

/** What a lens is handed for one screen: the page is still on it, at the viewport it was captured at. */
export interface LensContext {
  readonly ctx: RunContext;
  readonly screen: Screen;
  readonly ipage: InstrumentedPage;
  /** `config.viewports`; `viewports[0]` is the one the screen was captured at. */
  readonly viewports: readonly Viewport[];
  readonly interaction: 'full' | 'safe';
  /** A `performance.now()` value: the lens checks it between steps and stops once it has passed. */
  readonly deadline: number;
}

export interface LensResult {
  findings: Finding[];
  /** Lower-confidence candidates, kept apart from `findings`. */
  worthALook: Finding[];
  /** The lens's per-screen gallery evidence, when it writes one. */
  gallery: EvidenceRef | null;
  skipped: LensSkip[];
}

/** What the judge asks to see again: a step finding, or one occurrence of an occurrence finding. */
export type ReproductionTarget =
  | { finding: StepFinding }
  | { finding: OccurrenceFinding; occurrence: Occurrence };

/** How one attempt to see a finding again went. */
export interface Reproduction {
  /** The re-run measurement reported a finding with the target's `id`. */
  reproduced: boolean;
  /** That finding's `observed`; `null` when it did not reproduce. */
  observed: string | null;
  /**
   * Why the target could not be measured (`gone`, `background-uncertain:…`, …), which counts as not
   * reproduced; `null` when it was measured.
   */
  skipped: string | null;
  /** The evidence the re-run measurement attached to the finding it reproduced; `[]` otherwise. */
  evidence: EvidenceItem[];
}

/**
 * Inspects each captured screen on the page it was captured from. A lens may force states, move focus,
 * press Tab, resize the viewport and reload the screen's own URL; it never acts on data or navigates
 * elsewhere. The pipeline restores the capture viewport after it, whatever it did.
 */
export interface Lens {
  readonly name: LensName;
  /**
   * The catalogue rule ids the lens can report, in the order of the steps that report them: the judge
   * measures a screen's findings again on one page in this order.
   */
  readonly rules: readonly string[];
  inspect(context: LensContext): Promise<LensResult>;
  /**
   * Measures one of its findings again on a freshly loaded page: `context.screen` is the screen as
   * re-captured there (new element refs), `context.viewports[0]` the capture viewport. The lens
   * re-runs the step that owns the rule, restricted to the target as far as the step allows.
   */
  reproduce(target: ReproductionTarget, context: LensContext): Promise<Reproduction>;
}
