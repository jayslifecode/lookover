import type { BrowserSession } from '../browser/session.js';
import type { Screen } from '../map/types.js';
import type { Finding, FindingsFile } from './types.js';

/** What the judge made of the run's candidates. */
export interface JudgeOutcome {
  file: FindingsFile;
}

/**
 * Decides on the candidates while the crawl goes on. The engine hands it the session once it exists, then
 * each inspected screen's yield, and drains it after the crawl, with the session still open; the file the
 * drain returns is the one written.
 */
export interface Judge {
  /** The session, once it exists (the harness opens isolated contexts on it). */
  attach(session: BrowserSession): void;
  /** Each inspected screen's candidates and worth-a-look entries, as the screen yielded them (before the run-level merge). */
  onScreenInspected(screen: Screen, findings: readonly Finding[], worthALook: readonly Finding[]): void;
  /** Waits for every queued judgement and returns the judged file built from the run's merged candidates. */
  drain(file: FindingsFile): Promise<JudgeOutcome>;
}
