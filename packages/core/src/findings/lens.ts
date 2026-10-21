import type { InstrumentedPage } from '../browser/session.js';
import type { EvidenceRef } from '../evidence/store.js';
import type { Screen, Viewport } from '../map/types.js';
import type { RunContext } from '../run/run-context.js';
import type { Finding, LensName } from './types.js';

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

/**
 * Inspects each captured screen on the page it was captured from. A lens may force states, move focus,
 * press Tab, resize the viewport and reload the screen's own URL; it never acts on data or navigates
 * elsewhere. The pipeline restores the capture viewport after it, whatever it did.
 */
export interface Lens {
  readonly name: LensName;
  /** The catalogue rule ids the lens can report. */
  readonly rules: readonly string[];
  inspect(context: LensContext): Promise<LensResult>;
}
