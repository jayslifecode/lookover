import { open, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RunEvent } from '@jayslifecode/lookover-core';
import { LAST_EVENT_ID_HEADER } from '@jayslifecode/lookover-report/api';
import { streamHeaders } from './server-http.js';

/*
 * The run log as an event stream: every event already in `run.jsonl`, then each one appended to it, as
 * `id: <seq>` / `data: <json>`. The log is append-only and written a whole line at a time, so it is read
 * from where the last read ended, and a line is only read once its newline is there.
 */

/** How often the log is looked at for appended lines (its size and modification time). */
export const POLL_INTERVAL_MS = 250;
/** A comment this often keeps the connection from being closed as idle by anything in between. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
const NEWLINE = 0x0a;
const HEARTBEAT = ': ping\n\n';
const DIGITS = /^\d+$/;

/** Where the reading of the log is: the bytes read, the line not complete yet, the file as last seen. */
interface TailState {
  readonly offset: number;
  readonly partial: Buffer;
  readonly size: number;
  readonly mtimeMs: number;
  /** The highest `seq` sent: an event at or below it is not sent again. */
  readonly lastSeq: number;
}

/**
 * Calls `onEvent` with every event of the log at `file` whose `seq` is above `lastSeq`, in order, then
 * with each event appended to it, looking every `POLL_INTERVAL_MS`. A log that does not exist yet is
 * waited for; a line that is not a run event is passed over (the report reads the run's files besides).
 * Returns the function that stops it.
 */
export function tailRunLog(file: string, lastSeq: number, onEvent: (event: RunEvent) => void): () => void {
  let isStopped = false;
  let timer: NodeJS.Timeout | undefined;
  let state: TailState = { offset: 0, partial: Buffer.alloc(0), size: -1, mtimeMs: -1, lastSeq };

  const poll = async () => {
    try {
      state = await readAppended(file, state, (event) => {
        if (!isStopped) onEvent(event);
      });
    } catch {
      // A log that does not exist yet is waited for, and one that cannot be read now is read again at
      // the next poll, from where the last read ended: the state only moves on with a read that worked.
    }
    if (!isStopped) timer = setTimeout(poll, POLL_INTERVAL_MS);
  };
  void poll();
  return () => {
    isStopped = true;
    clearTimeout(timer);
  };
}

/** Reads what was appended to `file` since `state`, hands its complete lines' events on, and says where it is. */
async function readAppended(
  file: string,
  state: TailState,
  onEvent: (event: RunEvent) => void,
): Promise<TailState> {
  const stats = await stat(file);
  if (stats.size === state.size && stats.mtimeMs === state.mtimeMs) return state;
  // A log that got shorter was replaced: read it again from the start; `lastSeq` keeps out what was sent.
  const from = stats.size < state.offset ? { ...state, offset: 0, partial: Buffer.alloc(0) } : state;
  const appended = await readFrom(file, from.offset, stats.size - from.offset);
  const text = Buffer.concat([from.partial, appended]);
  const end = text.lastIndexOf(NEWLINE) + 1;
  const events = parseLines(text.subarray(0, end).toString('utf8')).filter(
    (event) => event.seq > from.lastSeq,
  );
  for (const event of events) {
    onEvent(event);
  }
  return {
    offset: from.offset + appended.length,
    partial: Buffer.from(text.subarray(end)),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    lastSeq: events.at(-1)?.seq ?? from.lastSeq,
  };
}

async function readFrom(file: string, position: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function parseLines(text: string): RunEvent[] {
  return text.split('\n').flatMap((line) => {
    const event = parseEvent(line);
    return event === null ? [] : [event];
  });
}

function parseEvent(line: string): RunEvent | null {
  if (line.trim() === '') return null;
  try {
    const value: unknown = JSON.parse(line);
    return isRunEvent(value) ? value : null;
  } catch {
    return null;
  }
}

function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== 'object' || value === null) return false;
  const { seq, type } = value as Record<string, unknown>;
  return Number.isInteger(seq) && typeof type === 'string';
}

/**
 * Answers `GET /api/events`: the run log at `file` as an event stream, from after the request's
 * `Last-Event-ID`, with a heartbeat comment every `HEARTBEAT_INTERVAL_MS`, until the client goes away.
 */
export function streamRunLog(req: IncomingMessage, res: ServerResponse, file: string): void {
  res.writeHead(
    200,
    streamHeaders({ 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' }),
  );
  res.flushHeaders();
  const stop = tailRunLog(file, lastEventId(req), (event) => {
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(HEARTBEAT), HEARTBEAT_INTERVAL_MS);
  res.on('close', () => {
    stop();
    clearInterval(heartbeat);
  });
}

function lastEventId(req: IncomingMessage): number {
  const header = req.headers[LAST_EVENT_ID_HEADER];
  return typeof header === 'string' && DIGITS.test(header) ? Number(header) : 0;
}
