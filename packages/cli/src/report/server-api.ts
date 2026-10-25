import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import {
  DECISIONS_FILE,
  type Decision,
  FINDINGS_FILE,
  type Finding,
  type FindingsFile,
  isMissingFile,
  type RunEvent,
  RunLog,
  readFindingsAt,
  writeDecision,
} from '@jayslifecode/lookover-core';
import {
  API_PATHS,
  type DecisionRequest,
  type DecisionResponse,
  type ReplayRequest,
  type ReplayResult,
  RUN_FILES,
  type RunManifest,
  type RunStatus,
} from '@jayslifecode/lookover-report/api';
import { EVIDENCE_DIR, previousFinishedRun, RUN_LOG_FILE, runDirOf } from './runs.js';
import {
  HttpError,
  IMMUTABLE,
  JSON_TYPE,
  OCTET_STREAM,
  readJsonBody,
  safeSegments,
  sendFile,
  sendJson,
} from './server-http.js';
import { streamRunLog } from './sse.js';

/*
 * The report's API over one run, as `@jayslifecode/lookover-report/api` has it: the manifest, the event
 * stream, the run's files, the previous run's findings, the evidence, and the two writes (a decision, a
 * replay). The token and the origin have been checked before a request gets here.
 */

/** Measures a finding again, as `lookover replay` does; what `POST /api/replay` runs. */
export type ReplayFinding = (finding: Finding) => Promise<ReplayResult>;

/** The run the API serves, and what it falls back on while its log has no `run.started` yet. */
export interface ApiContext {
  readonly lookoverDir: string;
  readonly runId: string;
  readonly lookoverVersion: string;
  /** `config.baseUrl`, until the run log says it. */
  readonly baseUrl: string;
  /** When the server started, until the run log says when the run did. */
  readonly startedAt: string;
  readonly replay: ReplayFinding;
}

/** Answers one `/api/*` request: `path` is the raw path, without the query. */
export type ApiHandler = (req: IncomingMessage, res: ServerResponse, path: string) => Promise<void>;

/** An endpoint: the one method it answers, and how. */
interface Route {
  readonly method: 'GET' | 'POST';
  readonly handle: ApiHandler;
}

const BUSY = 'A replay is already running';
const DECISION_SHAPE = 'Expected { findingId, status: "intended" | null, note? }';
const REPLAY_SHAPE = 'Expected { findingId }';
const NO_FINDINGS = 'The run has not written its findings yet';
const NO_EVIDENCE = 'No such evidence in this run';
/** Evidence is screenshots and measurements; anything else is served as bytes, never as a page. */
const EVIDENCE_TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.json': JSON_TYPE };
const FINISHED_BY: Readonly<Partial<Record<RunEvent['type'], RunStatus>>> = {
  'run.finished': 'finished',
  'run.failed': 'failed',
};

/** One decision written at a time per lookover directory: `writeDecision` reads, then writes the file. */
const decisionWrites = new Map<string, Promise<unknown>>();

function serialisedFor<T>(lookoverDir: string, write: () => Promise<T>): Promise<T> {
  const key = resolve(lookoverDir);
  const written = (decisionWrites.get(key) ?? Promise.resolve()).then(write);
  decisionWrites.set(
    key,
    written.catch(() => undefined),
  );
  return written;
}

export function createApi(context: ApiContext): ApiHandler {
  const runDir = runDirOf(context.lookoverDir, context.runId);
  const replay = replayHandler(context, runDir);
  const routes: ReadonlyMap<string, Route> = new Map<string, Route>([
    [
      API_PATHS.run,
      { method: 'GET', handle: async (_req, res) => sendJson(res, 200, await manifest(context)) },
    ],
    [
      API_PATHS.events,
      { method: 'GET', handle: async (req, res) => streamRunLog(req, res, join(runDir, RUN_LOG_FILE)) },
    ],
    [API_PATHS.previousFindings, { method: 'GET', handle: (_req, res) => sendPrevious(context, res) }],
    [API_PATHS.decisions, { method: 'POST', handle: (req, res) => postDecision(context, runDir, req, res) }],
    [API_PATHS.replay, { method: 'POST', handle: replay }],
  ]);
  return async (req, res, path) => {
    const route = routes.get(path) ?? prefixRoute(path, runDir, context);
    if (route === null) throw new HttpError(404, `The report API has no ${path}`);
    if (req.method !== route.method) throw new HttpError(405, `${path} answers ${route.method} only`);
    return route.handle(req, res, path);
  };
}

/** The routes that take the rest of the path: a run file, or a piece of evidence. */
function prefixRoute(path: string, runDir: string, context: ApiContext): Route | null {
  if (path.startsWith(API_PATHS.files)) {
    const name = path.slice(API_PATHS.files.length);
    return { method: 'GET', handle: (_req, res) => sendRunFile(context, runDir, name, res) };
  }
  if (path.startsWith(API_PATHS.evidence)) {
    const rest = path.slice(API_PATHS.evidence.length);
    return { method: 'GET', handle: (_req, res) => sendEvidence(runDir, rest, res) };
  }
  return null;
}

/** The run as the report shows it: where its log has got to, and the run before it. */
async function manifest(context: ApiContext): Promise<RunManifest> {
  const events = await readLog(join(runDirOf(context.lookoverDir, context.runId), RUN_LOG_FILE));
  const started = events.find((event) => event.type === 'run.started');
  const last = events.at(-1);
  return {
    runId: context.runId,
    baseUrl: started?.baseUrl ?? context.baseUrl,
    startedAt: started?.at ?? context.startedAt,
    status: (last === undefined ? undefined : FINISHED_BY[last.type]) ?? 'running',
    previousRunId: await previousFinishedRun(context.lookoverDir, context.runId),
    lookoverVersion: context.lookoverVersion,
  };
}

/** The run's events; none while its log does not exist. */
async function readLog(file: string): Promise<RunEvent[]> {
  try {
    return await RunLog.read(file);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

async function sendRunFile(context: ApiContext, runDir: string, name: string, res: ServerResponse) {
  if (!(RUN_FILES as readonly string[]).includes(name)) throw new HttpError(404, `No run file ${name}`);
  const dir = name === DECISIONS_FILE ? context.lookoverDir : runDir;
  return sendFile(res, join(dir, name), { missing: `The run has no ${name} yet` });
}

async function sendPrevious(context: ApiContext, res: ServerResponse): Promise<void> {
  const previous = await previousFinishedRun(context.lookoverDir, context.runId);
  if (previous === null) throw new HttpError(404, 'This is the first run of the project');
  return sendFile(res, join(runDirOf(context.lookoverDir, previous), FINDINGS_FILE));
}

/** A file under the run's `evidence/`, resolved and then checked to be in it; anything else is a 404. */
async function sendEvidence(runDir: string, rest: string, res: ServerResponse): Promise<void> {
  const segments = safeSegments(rest);
  if (segments === null) throw new HttpError(404, NO_EVIDENCE);
  const evidenceDir = resolve(runDir, EVIDENCE_DIR);
  const file = resolve(evidenceDir, ...segments);
  if (!file.startsWith(`${evidenceDir}${sep}`)) throw new HttpError(404, NO_EVIDENCE);
  const contentType = EVIDENCE_TYPES[extname(file).toLowerCase()] ?? OCTET_STREAM;
  return sendFile(res, file, { cacheControl: IMMUTABLE, contentType, missing: NO_EVIDENCE });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDecisionRequest(value: unknown): value is DecisionRequest {
  if (!isRecord(value) || typeof value.findingId !== 'string' || value.findingId === '') return false;
  const hasValidNote = value.note === undefined || typeof value.note === 'string';
  return (value.status === 'intended' || value.status === null) && hasValidNote;
}

function isReplayRequest(value: unknown): value is ReplayRequest {
  return isRecord(value) && typeof value.findingId === 'string' && value.findingId !== '';
}

/** The finding of the run with this id, in any of its lists; a 404 `HttpError` when it has none. */
async function runFinding(runDir: string, findingId: string): Promise<Finding> {
  const path = join(runDir, FINDINGS_FILE);
  const isWritten = await stat(path).then(
    (stats) => stats.isFile(),
    (error: unknown) => {
      if (isMissingFile(error)) return false;
      throw error;
    },
  );
  if (!isWritten) throw new HttpError(404, NO_FINDINGS);
  const finding = everyFinding(await readFindingsAt(path)).find(({ id }) => id === findingId);
  if (finding === undefined) throw new HttpError(404, `No finding ${findingId} in this run`);
  return finding;
}

function everyFinding(file: FindingsFile): Finding[] {
  return [...file.findings, ...file.worthALook, ...file.intended, ...file.rejected];
}

async function postDecision(
  context: ApiContext,
  runDir: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!isDecisionRequest(body)) throw new HttpError(400, DECISION_SHAPE);
  await runFinding(runDir, body.findingId);
  const decision: Decision | null =
    body.status === null
      ? null
      : { status: 'intended', at: new Date().toISOString(), note: body.note ?? null };
  const file = await serialisedFor(context.lookoverDir, () =>
    writeDecision(context.lookoverDir, body.findingId, decision),
  );
  sendJson(res, 200, { decisions: file.decisions } satisfies DecisionResponse);
}

/** Answers `POST /api/replay`, one replay at a time: another one meanwhile is a 409. */
function replayHandler(context: ApiContext, runDir: string): ApiHandler {
  let isReplaying = false;
  return async (req, res) => {
    const body = await readJsonBody(req);
    if (!isReplayRequest(body)) throw new HttpError(400, REPLAY_SHAPE);
    if (isReplaying) throw new HttpError(409, BUSY);
    isReplaying = true;
    try {
      const finding = await runFinding(runDir, body.findingId);
      // A replay that fails is a 500 with the first line of its message, redacted (see the server).
      const { attempts, reproduced, of } = await context.replay(finding);
      sendJson(res, 200, { attempts, reproduced, of } satisfies ReplayResult);
    } finally {
      isReplaying = false;
    }
  };
}
