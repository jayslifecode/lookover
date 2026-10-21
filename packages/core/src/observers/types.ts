import type { InstrumentedPage } from '../browser/session.js';
import type { EvidenceItem, Finding } from '../findings/types.js';
import type { Screen } from '../map/types.js';

export interface ObserverResult {
  findings: Finding[];
  /** Lower-confidence candidates, kept apart from `findings`. */
  worthALook: Finding[];
  evidence: EvidenceItem[];
}

/**
 * Always on: watches the crawl page from before its first navigation and reports, per captured screen,
 * what it saw while that screen loaded. `collect` runs before any lens touches the page.
 */
export interface Observer {
  readonly name: string;
  /** Called once, with the crawl page, before any navigation. */
  attach(ipage: InstrumentedPage): void;
  /** What was seen on `screen` since the previous `collect`. */
  collect(screen: Screen): Promise<ObserverResult>;
}
