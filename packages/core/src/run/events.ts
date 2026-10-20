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
  | { type: 'screen.captured'; screen: Screen }
  | { type: 'screen.truncated'; screenId: string; elements: number; kept: number }
  | { type: 'run.finished'; screens: number; durationMs: number }
  | { type: 'run.failed'; error: { code: string; message: string } };

export type RunEvent = RunEventBody & { seq: number; at: string; runId: string };
