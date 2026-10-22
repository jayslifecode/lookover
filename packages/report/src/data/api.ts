import type { EvidenceRef, FindingsFile, RunEvent } from '@jayslifecode/lookover-core';
import {
  API_PATHS,
  type DecisionRequest,
  type DecisionResponse,
  EVIDENCE_PATH_PREFIX,
  type ReplayRequest,
  type ReplayResult,
  type RunFileBody,
  type RunFileName,
  type RunManifest,
  TOKEN_HEADER,
  TOKEN_QUERY,
} from '../../node/api';

/*
 * The report's side of the HTTP and SSE contract in node/api.ts. The server sets the token cookie when
 * the CLI's printed URL is opened, and the browser sends it with every request, the event stream
 * included. Only when the page itself carries `?token=` (a server that could not set the cookie) is the
 * token also sent as the `X-Lookover-Token` header; it is read once and taken out of the address bar.
 * Everything the server answers is checked for its shape before the report uses it.
 */

/** A request the server refused or failed, with its status (404: the file does not exist yet). */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const NOT_FOUND = 404;

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === NOT_FOUND;
}

const JSON_TYPE = 'application/json';
/** `undefined` until the page's URL has been read. */
let pageToken: string | null | undefined;

function tokenFromPage(): string | null {
  if (pageToken !== undefined) return pageToken;
  const url = new URL(window.location.href);
  pageToken = url.searchParams.get(TOKEN_QUERY);
  if (pageToken !== null) {
    url.searchParams.delete(TOKEN_QUERY);
    window.history.replaceState(window.history.state, '', url);
  }
  return pageToken;
}

function requestHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const token = tokenFromPage();
  return { accept: JSON_TYPE, ...extra, ...(token === null ? {} : { [TOKEN_HEADER]: token }) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function errorOf(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => null);
  const message = isRecord(body) && typeof body.error === 'string' ? body.error : null;
  return new ApiError(response.status, message ?? `The report server answered ${response.status}`);
}

/** GETs `path` and reads its JSON body; a refusal or failure is an `ApiError`. */
export async function fetchJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { headers: requestHeaders(), signal: signal ?? null });
  if (!response.ok) throw await errorOf(response);
  return response.json();
}

/** How long a decision may take to be written before the report gives up on it. */
export const DECISION_TIMEOUT_MS = 15_000;
/** How long a replay may take: three attempts in fresh browser contexts. */
export const REPLAY_TIMEOUT_MS = 120_000;
const MS_PER_SECOND = 1_000;

/**
 * POSTs `body` as JSON and reads the JSON answer. A server that has not answered within `timeoutMs` is
 * given up on (the request is aborted) with a plain error saying so. The timer is the page's own
 * `setTimeout`, cleared as soon as the answer is in, so no timer outlives its request.
 */
async function postJson(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: requestHeaders({ 'content-type': JSON_TYPE }),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw await errorOf(response);
    return await response.json();
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    throw new Error(`The report server did not answer within ${timeoutMs / MS_PER_SECOND} s`, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

function checked<T>(value: unknown, isValid: (value: unknown) => boolean, what: string): T {
  if (!isValid(value)) throw new Error(`The report server sent ${what} the report cannot read`);
  return value as T;
}

const RUN_STATUSES: ReadonlySet<unknown> = new Set(['running', 'finished', 'failed']);

function isRunManifest(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.runId === 'string' &&
    typeof value.baseUrl === 'string' &&
    typeof value.startedAt === 'string' &&
    RUN_STATUSES.has(value.status) &&
    (value.previousRunId === null || typeof value.previousRunId === 'string')
  );
}

function isFindingsFile(value: unknown): boolean {
  const lists = ['findings', 'worthALook', 'rejected', 'intended'] as const;
  return isRecord(value) && value.version === 2 && lists.every((list) => Array.isArray(value[list]));
}

const RUN_FILE_SHAPES: Readonly<Record<RunFileName, (value: unknown) => boolean>> = {
  'app-map.json': (value) => isRecord(value) && value.version === 1 && Array.isArray(value.screens),
  'findings.json': isFindingsFile,
  'decisions.json': (value) => isRecord(value) && value.version === 1 && isRecord(value.decisions),
};

function isRunEvent(value: unknown): value is RunEvent {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    Number.isInteger(value.seq) &&
    typeof value.at === 'string'
  );
}

export async function fetchManifest(signal?: AbortSignal): Promise<RunManifest> {
  return checked<RunManifest>(await fetchJson(API_PATHS.run, signal), isRunManifest, 'a run manifest');
}

/** One of the run's files; an `ApiError` with status 404 while it does not exist yet. */
export async function fetchRunFile<N extends RunFileName>(
  name: N,
  signal?: AbortSignal,
): Promise<RunFileBody[N]> {
  const body = await fetchJson(`${API_PATHS.files}${name}`, signal);
  return checked<RunFileBody[N]>(body, RUN_FILE_SHAPES[name], name);
}

/** The previous run's findings; `null` when this is the project's first run. */
export async function fetchPreviousFindings(signal?: AbortSignal): Promise<FindingsFile | null> {
  try {
    const body = await fetchJson(API_PATHS.previousFindings, signal);
    return checked<FindingsFile>(body, isFindingsFile, "the previous run's findings");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Path segments that would step out of evidence/, or name no file. */
const UNSAFE_SEGMENTS: ReadonlySet<string> = new Set(['', '.', '..']);

/** Where the report loads `ref` from; `null` for a ref outside the run's evidence/ (`..` included). */
export function evidenceUrl(ref: Pick<EvidenceRef, 'path'>): string | null {
  if (!ref.path.startsWith(EVIDENCE_PATH_PREFIX)) return null;
  const segments = ref.path.slice(EVIDENCE_PATH_PREFIX.length).split('/');
  if (segments.some((segment) => UNSAFE_SEGMENTS.has(segment))) return null;
  return `${API_PATHS.evidence}${segments.map(encodeURIComponent).join('/')}`;
}

/** What `subscribe` tells `onError` while the browser reconnects a dropped stream. */
export const STREAM_RECONNECTING = 'The live event stream dropped; reconnecting';

/**
 * Follows the run's events. The browser reconnects a dropped stream by itself and sends the last `id`
 * it saw as `Last-Event-ID`; events at or below the last `seq` seen (from before `lastSeq`, or replayed
 * by a server that starts over) are dropped, so each reaches `onEvent` once. `onError` hears of a
 * message that is not an event, of a dropped stream the browser is reconnecting (`STREAM_RECONNECTING`),
 * and of a stream the server closed for good; `onOpen` of each time the stream (re)opens. Returns the
 * unsubscribe.
 */
export function subscribe(
  onEvent: (event: RunEvent) => void,
  onError: (message: string) => void,
  lastSeq = 0,
  onOpen?: () => void,
): () => void {
  if (typeof EventSource !== 'function') {
    onError('This browser cannot follow the run live: it has no EventSource');
    return () => undefined;
  }
  let seen = lastSeq;
  const source = new EventSource(API_PATHS.events);
  source.onmessage = (message: MessageEvent<string>) => {
    let data: unknown;
    try {
      data = JSON.parse(message.data);
    } catch {
      data = null;
    }
    if (!isRunEvent(data)) {
      onError('The event stream sent a message that is not a run event');
      return;
    }
    if (data.seq <= seen) return;
    seen = data.seq;
    onEvent(data);
  };
  source.onopen = () => onOpen?.();
  source.onerror = () => {
    // While the browser reconnects the state is CONNECTING; CLOSED means it gave up (the server refused).
    if (source.readyState === EventSource.CLOSED) {
      onError('The live event stream was closed by the report server; reload the page to follow the run');
      return;
    }
    onError(STREAM_RECONNECTING);
  };
  return () => source.close();
}

export async function postDecision(request: DecisionRequest): Promise<DecisionResponse> {
  const body = await postJson(API_PATHS.decisions, request, DECISION_TIMEOUT_MS);
  return checked<DecisionResponse>(
    body,
    (value) => isRecord(value) && isRecord(value.decisions),
    'a decision',
  );
}

export async function postReplay(request: ReplayRequest): Promise<ReplayResult> {
  const body = await postJson(API_PATHS.replay, request, REPLAY_TIMEOUT_MS);
  const isResult = (value: unknown) =>
    isRecord(value) && Array.isArray(value.attempts) && typeof value.reproduced === 'number';
  return checked<ReplayResult>(body, isResult, 'a replay result');
}
