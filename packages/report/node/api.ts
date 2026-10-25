import type { AppMap, Attempt, DecisionsFile, FindingsFile, RunEvent } from '@jayslifecode/lookover-core';

/*
 * The HTTP and SSE contract between the report and the server that serves it: the CLI implements it
 * (`lookover run`, `lookover report`), the report's dev mock (`dev/mock-api.ts`) imitates it over the
 * fixture run, and the report's data layer consumes it. Plain types and constants, nothing Node-only, so
 * the browser bundle can import it too.
 *
 *   GET  /                          the built report; `/?token=<t>` sets the token cookie, then redirects to `/`
 *   GET  /api/run                   RunManifest
 *   GET  /api/events                SSE: every RunEvent of run.jsonl as `id: <seq>` / `data: <json>`, then
 *                                   the live appends; resumes after the `Last-Event-ID` request header
 *   GET  /api/files/<RunFileName>   the run's file (404 while it does not exist yet)
 *   GET  /api/previous/findings.json  the previous run's findings (404 for the first run)
 *   GET  /api/evidence/<path>       a file under the run's evidence/ (`Cache-Control: immutable`); else 404
 *   POST /api/decisions             DecisionRequest → DecisionResponse, after writing .lookover/decisions.json
 *                                   (while the run is going, for a finding its log names, for the next run)
 *   POST /api/replay                ReplayRequest → ReplayResult; 409 while a replay is running, and while
 *                                   the run is going (its browser session is busy)
 *
 * Every request needs a `Host` naming the server (`127.0.0.1:<port>` or `localhost:<port>`), else 421.
 * Every `/api/*` request needs the run's token: the server's own cookie, `tokenCookieName(port)`
 * (`SameSite=Strict; HttpOnly`), or the `X-Lookover-Token` header. A POST also needs an `Origin` equal to
 * the server's own. Responses carry `Cache-Control: no-store`, except evidence. A refused or failed
 * request answers `ApiErrorBody`.
 */

export const API_PATHS = {
  run: '/api/run',
  events: '/api/events',
  /** Followed by a `RunFileName`. */
  files: '/api/files/',
  previousFindings: '/api/previous/findings.json',
  /** Followed by the part of an `EvidenceRef.path` after `EVIDENCE_PATH_PREFIX`. */
  evidence: '/api/evidence/',
  decisions: '/api/decisions',
  replay: '/api/replay',
} as const;

/** Where every `EvidenceRef.path` starts; the evidence URL is `API_PATHS.evidence` + the rest. */
export const EVIDENCE_PATH_PREFIX = 'evidence/';

/**
 * The token cookie's name is this, then the server's port: a cookie is the host's whatever its port, so
 * two servers on 127.0.0.1 would otherwise overwrite each other's.
 */
export const TOKEN_COOKIE_PREFIX = 'lookover_token_';

/** The name of the token cookie of the server on `port`: `lookover_token_<port>`. */
export function tokenCookieName(port: number): string {
  return `${TOKEN_COOKIE_PREFIX}${port}`;
}

/** Header names are case-insensitive; Node gives them lower-cased. */
export const TOKEN_HEADER = 'x-lookover-token';
/** `GET /?token=<t>`: the query parameter the CLI's printed URL carries. */
export const TOKEN_QUERY = 'token';
export const LAST_EVENT_ID_HEADER = 'last-event-id';

export const RUN_FILES = ['app-map.json', 'findings.json', 'decisions.json'] as const;
export type RunFileName = (typeof RUN_FILES)[number];

/** What `GET /api/files/<name>` answers, by name. */
export interface RunFileBody {
  'app-map.json': AppMap;
  'findings.json': FindingsFile;
  'decisions.json': DecisionsFile;
}

export type RunStatus = 'running' | 'finished' | 'failed';

/** `GET /api/run`: the run the report shows. */
export interface RunManifest {
  runId: string;
  baseUrl: string;
  /** ISO 8601, from the run's `run.started` event. */
  startedAt: string;
  status: RunStatus;
  /** The project's run before this one, for drift; `null` when this is the first. */
  previousRunId: string | null;
  lookoverVersion: string;
}

/** The `data` of each `GET /api/events` message; its `id` is the event's `seq`. */
export type EventStreamData = RunEvent;

/** `POST /api/decisions`: mark a finding intended, or forget the decision with `status: null`. */
export interface DecisionRequest {
  findingId: string;
  status: 'intended' | null;
  note?: string;
}

/** The project's decisions after the write. */
export interface DecisionResponse {
  decisions: DecisionsFile['decisions'];
  /**
   * `true` when the run was still going: the decision is recorded and the next run applies it, while
   * this run's findings stay as its judge leaves them. Absent once the run has written its findings.
   */
  appliesNextRun?: true;
}

/** `POST /api/replay`: reproduce one finding again, in a fresh browser context. */
export interface ReplayRequest {
  findingId: string;
}

export interface ReplayResult {
  attempts: Attempt[];
  reproduced: number;
  of: number;
}

export interface ApiErrorBody {
  error: string;
}
