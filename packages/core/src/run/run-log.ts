import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LookoverError } from '../errors.js';
import { redactDeep } from '../util/redact.js';
import type { RunEvent, RunEventBody } from './events.js';

const EMPTY_LOG_SEQ = 0;
const FIRST_SEQ = EMPTY_LOG_SEQ + 1;
const LINE_SEPARATOR = '\n';

type Subscriber = (event: RunEvent) => void;

/**
 * Append-only JSONL stream of everything a run does: one `RunEvent` per line.
 *
 * Appends are serialised, so concurrent callers never interleave lines and `seq` is gap-free.
 * Bodies are redacted before they are written. The live report reads the same file back with
 * `RunLog.read`, so the file is the source of truth and `subscribe` is only a notification.
 */
export class RunLog {
  private readonly subscribers = new Set<Subscriber>();
  private tail: Promise<void> = Promise.resolve();

  private constructor(
    readonly file: string,
    private readonly runId: string,
    private nextSeq: number,
  ) {}

  /** Creates the file if needed. An existing log is continued: `seq` resumes after its last line. */
  static async open(file: string, runId: string): Promise<RunLog> {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, '');
    const existing = await RunLog.read(file);
    const lastSeq = existing.at(-1)?.seq ?? EMPTY_LOG_SEQ;
    return new RunLog(file, runId, lastSeq + 1);
  }

  /** Parses every non-empty line. A line that is not a run event throws `E_RUN_FAILED` naming it. */
  static async read(file: string): Promise<RunEvent[]> {
    const text = await readFile(file, 'utf8');
    return text
      .split(LINE_SEPARATOR)
      .flatMap((line, index) => (line.trim() === '' ? [] : [parseLine(file, line, index + 1)]));
  }

  /**
   * Redacts the body as it is now, queues the write and resolves with the event once it is on disk.
   * Subscribers run after the write; if one throws, every other subscriber is still notified and
   * the error then rejects this call, although the event is already written.
   */
  async append(body: RunEventBody): Promise<RunEvent> {
    const safeBody = redactDeep(body);
    const written = this.tail.then(() => this.write(safeBody));
    this.tail = written.then(ignore, ignore);
    return written;
  }

  /** Calls `fn` for every event appended from now on. Returns the function that stops delivery. */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  private async write(body: RunEventBody): Promise<RunEvent> {
    const event: RunEvent = { ...body, seq: this.nextSeq, at: new Date().toISOString(), runId: this.runId };
    await appendFile(this.file, `${JSON.stringify(event)}${LINE_SEPARATOR}`, 'utf8');
    this.nextSeq += 1;
    this.notify(event);
    return event;
  }

  private notify(event: RunEvent): void {
    const failures: unknown[] = [];
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(event);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  }
}

function ignore(): void {}

function parseLine(file: string, line: string, lineNumber: number): RunEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw malformed(file, lineNumber, `it is not valid JSON (${reason})`);
  }
  if (!hasEventEnvelope(value)) throw malformed(file, lineNumber, 'it is not a run event');
  return value;
}

function malformed(file: string, lineNumber: number, why: string): LookoverError {
  return new LookoverError(
    'E_RUN_FAILED',
    `Run log ${file} is damaged: line ${lineNumber} is unreadable because ${why}.`,
    'The run log is append-only JSONL; repair or remove the damaged line.',
  );
}

/** Checks the envelope only; the body shape is trusted because this file is only ever written by `append`. */
function hasEventEnvelope(value: unknown): value is RunEvent {
  if (typeof value !== 'object' || value === null) return false;
  const { seq, at, runId, type } = value as Record<string, unknown>;
  return (
    typeof seq === 'number' &&
    Number.isInteger(seq) &&
    seq >= FIRST_SEQ &&
    typeof at === 'string' &&
    typeof runId === 'string' &&
    typeof type === 'string'
  );
}
