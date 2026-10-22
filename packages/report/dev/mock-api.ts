import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Decision, DecisionsFile, Finding, FindingsFile, RunEvent } from '@jayslifecode/lookover-core';
import type { Plugin } from 'vite';
import {
  API_PATHS,
  type ApiErrorBody,
  type DecisionRequest,
  type DecisionResponse,
  LAST_EVENT_ID_HEADER,
  type ReplayRequest,
  type ReplayResult,
  RUN_FILES,
  type RunFileName,
  type RunManifest,
} from '../node/api.ts';

/*
 * The report's API in development (`pnpm dev`), over the fixture run in `fixtures/`: the same contract
 * as the CLI's server (node/api.ts), without the token. Each page load watches the run go by again:
 * `/api/run` says it is running, `/api/events` replays run.jsonl with a gap between events, and the
 * findings file is not there (404) until the stream has sent the log's last event, so the live states
 * can be seen; a stream that resumes (`Last-Event-ID`) carries on with the same replay. Decisions are
 * written to a temporary copy of fixtures/decisions.json, so the fixture never changes; a replay answers
 * the finding's recorded attempts after a pause.
 */

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));
const RUN_DIR = join(FIXTURES_DIR, 'run');
const EVIDENCE_DIR = join(RUN_DIR, 'evidence');
const PREVIOUS_FINDINGS_FILE = join(FIXTURES_DIR, 'previous-findings.json');
const DECISIONS_FILE: RunFileName = 'decisions.json';
const FINDINGS_FILE: RunFileName = 'findings.json';
const EVENT_GAP_MS = 40;
/** A replay takes this long, so the busy state can be seen (and a second one answers 409). */
const REPLAY_PAUSE_MS = 1_500;
const MAX_BODY_BYTES = 16 * 1024;
const FALLBACK_VERSION = '0.0.0-dev';
const JSON_TYPE = 'application/json; charset=utf-8';
const CONTENT_TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.json': JSON_TYPE };
const NO_STORE = 'no-store';
const IMMUTABLE = 'public, max-age=31536000, immutable';

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface FixtureRun {
  readonly manifest: RunManifest;
  readonly events: readonly RunEvent[];
  readonly findings: FindingsFile;
  /** The temporary directory holding the writable decisions.json. */
  readonly scratchDir: string;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function previousRunId(): Promise<string | null> {
  try {
    return (await readJson<FindingsFile>(PREVIOUS_FINDINGS_FILE)).runId;
  } catch {
    // No earlier run in the fixture: the report shows this one as the first.
    return null;
  }
}

async function openFixtureRun(): Promise<FixtureRun> {
  const log = await readFile(join(RUN_DIR, 'run.jsonl'), 'utf8');
  const events = log
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RunEvent);
  const started = events.find((event) => event.type === 'run.started');
  if (started === undefined)
    throw new Error(`The fixture's run.jsonl in ${RUN_DIR} has no run.started event`);
  const findings = await readJson<FindingsFile>(join(RUN_DIR, 'findings.json'));
  const scratchDir = await mkdtemp(join(tmpdir(), 'lookover-report-dev-'));
  await copyFile(join(FIXTURES_DIR, DECISIONS_FILE), join(scratchDir, DECISIONS_FILE));
  const manifest: RunManifest = {
    runId: started.runId,
    baseUrl: started.baseUrl,
    startedAt: started.at,
    // Each page load watches the run go by: the events close it.
    status: 'running',
    previousRunId: await previousRunId(),
    lookoverVersion: findings.environment?.lookover ?? FALLBACK_VERSION,
  };
  return { manifest, events, findings, scratchDir };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': JSON_TYPE, 'cache-control': NO_STORE });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message } satisfies ApiErrorBody);
}

async function sendFile(res: ServerResponse, path: string, cacheControl = NO_STORE): Promise<void> {
  const body = await readFile(path).catch(() => null);
  if (body === null) throw new HttpError(404, 'No such file in the fixture run');
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
    'cache-control': cacheControl,
  });
  res.end(body);
}

/** A path under the run's evidence/, or a 404: nothing outside it is served. */
function evidencePath(encoded: string): string {
  let relative: string;
  try {
    relative = decodeURIComponent(encoded);
  } catch {
    throw new HttpError(404, 'No such evidence');
  }
  const path = resolve(EVIDENCE_DIR, relative);
  if (!path.startsWith(`${EVIDENCE_DIR}${sep}`)) throw new HttpError(404, 'No such evidence');
  return path;
}

function runFilePath(run: FixtureRun, name: string): string {
  if (!(RUN_FILES as readonly string[]).includes(name)) throw new HttpError(404, `No run file ${name}`);
  return name === DECISIONS_FILE ? join(run.scratchDir, DECISIONS_FILE) : join(RUN_DIR, name);
}

/**
 * Replays the run log from after `Last-Event-ID`, one event every EVENT_GAP_MS, then stays open; calls
 * `onReplayed` once the log's last event has been sent (at once when there is nothing left to send).
 */
function streamEvents(
  run: FixtureRun,
  req: IncomingMessage,
  res: ServerResponse,
  onReplayed: () => void,
): void {
  const header = req.headers[LAST_EVENT_ID_HEADER];
  const lastSeq = typeof header === 'string' && /^\d+$/.test(header) ? Number(header) : 0;
  const pending = run.events.filter((event) => event.seq > lastSeq);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': NO_STORE,
    connection: 'keep-alive',
  });
  if (pending.length === 0) onReplayed();
  let next = 0;
  const timer = setInterval(() => {
    const event = pending[next];
    if (event === undefined) {
      clearInterval(timer);
      return;
    }
    next += 1;
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    if (next === pending.length) onReplayed();
  }, EVENT_GAP_MS);
  req.on('close', () => clearInterval(timer));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, `The body is over ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The body is not JSON');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDecisionRequest(value: unknown): value is DecisionRequest {
  if (!isRecord(value) || typeof value.findingId !== 'string' || value.findingId === '') return false;
  const hasValidNote = value.note === undefined || typeof value.note === 'string';
  return (value.status === 'intended' || value.status === null) && hasValidNote;
}

function isReplayRequest(value: unknown): value is ReplayRequest {
  return isRecord(value) && typeof value.findingId === 'string' && value.findingId !== '';
}

function findingById(findings: FindingsFile, id: string): Finding | undefined {
  const all = [...findings.findings, ...findings.worthALook, ...findings.intended, ...findings.rejected];
  return all.find((finding) => finding.id === id);
}

async function postDecision(run: FixtureRun, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  if (!isDecisionRequest(body)) {
    throw new HttpError(400, 'Expected { findingId, status: "intended" | null, note? }');
  }
  if (findingById(run.findings, body.findingId) === undefined) {
    throw new HttpError(404, `No finding ${body.findingId} in this run`);
  }
  const path = join(run.scratchDir, DECISIONS_FILE);
  const current = await readJson<DecisionsFile>(path);
  const others = Object.entries(current.decisions).filter(([id]) => id !== body.findingId);
  const decision: Decision = { status: 'intended', at: new Date().toISOString(), note: body.note ?? null };
  const decisions = Object.fromEntries(
    body.status === null ? others : [...others, [body.findingId, decision]],
  );
  await writeFile(path, `${JSON.stringify({ version: 1, decisions } satisfies DecisionsFile, null, 2)}\n`);
  sendJson(res, 200, { decisions } satisfies DecisionResponse);
}

/** Answers POST /api/replay with the finding's recorded attempts; one replay at a time, as the CLI. */
function replayHandler(run: FixtureRun) {
  let isReplaying = false;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJsonBody(req);
    if (!isReplayRequest(body)) throw new HttpError(400, 'Expected { findingId }');
    if (isReplaying) throw new HttpError(409, 'A replay is already running');
    const finding = findingById(run.findings, body.findingId);
    if (finding === undefined) throw new HttpError(404, `No finding ${body.findingId} in this run`);
    isReplaying = true;
    try {
      await delay(REPLAY_PAUSE_MS);
      const attempts = finding.judgement?.attempts ?? [];
      const reproduced = attempts.filter((attempt) => attempt.reproduced).length;
      sendJson(res, 200, { attempts, reproduced, of: attempts.length } satisfies ReplayResult);
    } finally {
      isReplaying = false;
    }
  };
}

function apiHandler(run: FixtureRun) {
  const replay = replayHandler(run);
  // Whether the page's replay of the run has sent its last event: until then the run is going.
  let isReplayed = false;
  const markReplayed = () => {
    isReplayed = true;
  };
  return async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const isGet = req.method === 'GET';
    if (isGet && path === API_PATHS.run) {
      // A page load: the run goes by again.
      isReplayed = false;
      return sendJson(res, 200, run.manifest);
    }
    if (isGet && path === API_PATHS.events) return streamEvents(run, req, res, markReplayed);
    if (isGet && path === API_PATHS.previousFindings) return sendFile(res, PREVIOUS_FINDINGS_FILE);
    if (isGet && path === `${API_PATHS.files}${FINDINGS_FILE}` && !isReplayed) {
      throw new HttpError(404, 'The run has not finished yet');
    }
    if (isGet && path.startsWith(API_PATHS.files)) {
      return sendFile(res, runFilePath(run, path.slice(API_PATHS.files.length)));
    }
    if (isGet && path.startsWith(API_PATHS.evidence)) {
      return sendFile(res, evidencePath(path.slice(API_PATHS.evidence.length)), IMMUTABLE);
    }
    if (req.method === 'POST' && path === API_PATHS.decisions) return postDecision(run, req, res);
    if (req.method === 'POST' && path === API_PATHS.replay) return replay(req, res);
    throw new HttpError(404, `The report API has no ${req.method} ${path}`);
  };
}

/** The Vite plugin: serves `/api/*` from the fixture run while `vite` (dev) runs. */
export function mockApi(): Plugin {
  return {
    name: 'lookover-mock-api',
    apply: 'serve',
    async configureServer(server) {
      const run = await openFixtureRun();
      const handle = apiHandler(run);
      server.httpServer?.once('close', () => {
        // The scratch copy is in the OS's temporary directory, which is cleaned anyway.
        rm(run.scratchDir, { recursive: true, force: true }).catch(() => undefined);
      });
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (!path.startsWith('/api/')) return next();
        handle(req, res, path).catch((error: unknown) => {
          const status = error instanceof HttpError ? error.status : 500;
          const message = error instanceof Error ? error.message : String(error);
          if (res.headersSent) res.end();
          else sendError(res, status, message);
        });
      });
    },
  };
}
