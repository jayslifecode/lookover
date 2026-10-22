import type { Finding, JudgeTotals } from '../findings/types.js';
import type { RouteInfo, Screen, Viewport } from '../map/types.js';

export type RunEventBody =
  | { type: 'run.started'; baseUrl: string; interaction: 'full' | 'safe'; viewports: Viewport[] }
  | { type: 'route.discovered'; route: RouteInfo }
  | { type: 'auth.completed'; method: 'none' | 'storageState' | 'form'; statePath?: string }
  | { type: 'auth.lost'; url: string }
  /**
   * A host the app sent a request to, once per kind: `app-call` for fetch, XHR, websockets and event
   * streams, `subresource` for everything else a page loads (images, scripts, styles, fonts, media).
   */
  | { type: 'host.observed'; host: string; kind: 'navigation' | 'app-call' | 'subresource' }
  | { type: 'request.blocked'; url: string; reason: 'provider' | 'host-not-allowed' | 'unconfirmed-backend' }
  | { type: 'screen.discovered'; url: string; from: string | null }
  | {
      type: 'screen.skipped';
      url: string;
      reason: 'destructive-link' | 'route-cap' | 'max-screens' | 'not-same-app';
    }
  /** `url` redirected to `landed`, a screen of the app that was already captured or whose route is full. */
  | { type: 'screen.skipped'; url: string; reason: 'redirected-duplicate'; landed: string }
  | { type: 'screen.captured'; screen: Screen }
  | { type: 'screen.truncated'; screenId: string; elements: number; kept: number }
  /** A finding seen for the first time in this run. The run log redacts it like every other event body. */
  | { type: 'finding.candidate'; finding: Finding }
  /**
   * A screen has been inspected by the observers and the lenses. `candidates` and `worthALook` count what
   * the screen yielded, `skipped` is what the lenses left out and why, and `error` is the first line of
   * the message when the inspection stopped on an error.
   */
  | {
      type: 'screen.inspected';
      screenId: string;
      durationMs: number;
      candidates: number;
      worthALook: number;
      skipped: { reason: string; count: number }[];
      error: string | null;
    }
  /** A finding after the judge or the user decided on it, whole, so the report needs nothing else. */
  | { type: 'finding.judged'; finding: Finding }
  /** The judge model was not used, and why; the deterministic harness decided on its own. */
  | { type: 'judge.unavailable'; reason: 'no-api-key' | 'disabled' | 'api-error'; message: string }
  /**
   * The run is over. `confirmed`, `rejected` and `intended` count the findings by what became of them,
   * `worthALook` the lower-confidence candidates, and `judge` is what the judge model cost (`null` when
   * the run was not judged).
   */
  | {
      type: 'run.finished';
      screens: number;
      durationMs: number;
      confirmed: number;
      rejected: number;
      intended: number;
      worthALook: number;
      judge: JudgeTotals | null;
    }
  | { type: 'run.failed'; error: { code: string; message: string } };

export type RunEvent = RunEventBody & { seq: number; at: string; runId: string };
