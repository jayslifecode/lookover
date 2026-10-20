import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LookoverError } from '../src/errors.js';
import type { RunEvent, RunEventBody } from '../src/run/events.js';
import { RunLog } from '../src/run/run-log.js';

const RUN_ID = '20261020-124455-ab12';
const CONCURRENT_APPENDS = 50;

function authLost(n: number): RunEventBody {
  return { type: 'auth.lost', url: `https://app.test/${n}` };
}

describe('RunLog', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lookover-run-log-'));
    file = join(dir, 'run.jsonl');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function lines(): Promise<string[]> {
    const text = await readFile(file, 'utf8');
    return text.split('\n').filter((line) => line !== '');
  }

  test('exposes the file it writes to', async () => {
    const log = await RunLog.open(file, RUN_ID);

    expect(log.file).toBe(file);
  });

  test('appends three events and reads them back with seq 1..3, an ISO timestamp and the run id', async () => {
    const log = await RunLog.open(file, RUN_ID);

    await log.append(authLost(1));
    await log.append(authLost(2));
    await log.append(authLost(3));
    const events = await RunLog.read(file);

    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.runId)).toEqual([RUN_ID, RUN_ID, RUN_ID]);
    expect(events.map((e) => (e.type === 'auth.lost' ? e.url : null))).toEqual([
      'https://app.test/1',
      'https://app.test/2',
      'https://app.test/3',
    ]);
    for (const event of events) {
      expect(new Date(event.at).toISOString()).toBe(event.at);
    }
  });

  test('returns the full event it wrote', async () => {
    const log = await RunLog.open(file, RUN_ID);

    const event = await log.append(authLost(1));

    expect(event).toEqual({ ...authLost(1), seq: 1, at: event.at, runId: RUN_ID });
    expect(await RunLog.read(file)).toEqual([event]);
  });

  test('writes one JSON object per line', async () => {
    const log = await RunLog.open(file, RUN_ID);

    await log.append(authLost(1));
    await log.append(authLost(2));

    const written = await lines();
    expect(written).toHaveLength(2);
    expect(written.map((line) => JSON.parse(line).seq)).toEqual([1, 2]);
  });

  test('continues the sequence from the last line when reopening an existing file', async () => {
    const first = await RunLog.open(file, RUN_ID);
    await first.append(authLost(1));
    await first.append(authLost(2));
    await first.append(authLost(3));

    const reopened = await RunLog.open(file, RUN_ID);
    const event = await reopened.append(authLost(4));

    expect(event.seq).toBe(4);
    expect((await RunLog.read(file)).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  test('creates the parent directory when it does not exist yet', async () => {
    const nested = join(dir, 'runs', RUN_ID, 'run.jsonl');
    const log = await RunLog.open(nested, RUN_ID);

    await log.append(authLost(1));

    expect(await RunLog.read(nested)).toHaveLength(1);
  });

  test('stores strings redacted without mutating the body it was given', async () => {
    const log = await RunLog.open(file, RUN_ID);
    const body: RunEventBody = {
      type: 'run.failed',
      error: { code: 'E_AUTH_FAILED', message: 'jay@example.com' },
    };

    const event = await log.append(body);

    expect(event).toMatchObject({ error: { message: '[email]' } });
    expect(await readFile(file, 'utf8')).not.toContain('jay@example.com');
    expect(body.error.message).toBe('jay@example.com');
  });

  describe('subscribe', () => {
    test('delivers each event after its write has resolved', async () => {
      const log = await RunLog.open(file, RUN_ID);
      const seen: RunEvent[] = [];
      const linesAtDelivery: number[] = [];
      log.subscribe((event) => {
        seen.push(event);
        linesAtDelivery.push(countLinesSync(file));
      });

      const appended = await log.append(authLost(1));

      expect(seen).toEqual([appended]);
      expect(linesAtDelivery).toEqual([1]);
    });

    test('stops delivering once the returned function is called', async () => {
      const log = await RunLog.open(file, RUN_ID);
      const seen: number[] = [];
      const unsubscribe = log.subscribe((event) => seen.push(event.seq));

      await log.append(authLost(1));
      unsubscribe();
      await log.append(authLost(2));

      expect(seen).toEqual([1]);
    });

    describe('when a subscriber throws', () => {
      const failure = new Error('subscriber blew up');

      test('append still resolves, later subscribers still receive the event and the handler gets the error and the event', async () => {
        const handled: { error: unknown; event: RunEvent }[] = [];
        const log = await RunLog.open(file, RUN_ID, {
          onSubscriberError: (error, event) => handled.push({ error, event }),
        });
        const seen: number[] = [];
        log.subscribe(() => {
          throw failure;
        });
        log.subscribe((event) => seen.push(event.seq));

        const first = await log.append(authLost(1));
        const second = await log.append(authLost(2));

        expect(seen).toEqual([1, 2]);
        expect(handled).toEqual([
          { error: failure, event: first },
          { error: failure, event: second },
        ]);
        expect((await RunLog.read(file)).map((e) => e.seq)).toEqual([1, 2]);
      });

      test('without a handler the error is re-raised asynchronously and append is unaffected', async () => {
        const raised = captureAsyncErrors();
        const log = await RunLog.open(file, RUN_ID);
        const seen: number[] = [];
        log.subscribe(() => {
          throw failure;
        });
        log.subscribe((event) => seen.push(event.seq));

        const event = await log.append(authLost(1));
        await nextMacrotask();

        expect(event.seq).toBe(1);
        expect(seen).toEqual([1]);
        expect(raised).toEqual([failure]);
      });

      test('a handler that throws is re-raised asynchronously and append is unaffected', async () => {
        const raised = captureAsyncErrors();
        const handlerFailure = new Error('handler blew up');
        const log = await RunLog.open(file, RUN_ID, {
          onSubscriberError: () => {
            throw handlerFailure;
          },
        });
        log.subscribe(() => {
          throw failure;
        });

        const event = await log.append(authLost(1));
        await nextMacrotask();

        expect(event.seq).toBe(1);
        expect(raised).toEqual([handlerFailure]);
      });
    });
  });

  describe('reopening a file whose last line has no trailing newline', () => {
    function eventLine(seq: number): string {
      return JSON.stringify({ ...authLost(seq), seq, at: new Date().toISOString(), runId: RUN_ID });
    }

    test('starts the next event on its own line', async () => {
      await writeFile(file, eventLine(1));

      const log = await RunLog.open(file, RUN_ID);
      await log.append(authLost(2));
      await log.append(authLost(3));

      expect((await RunLog.read(file)).map((e) => e.seq)).toEqual([1, 2, 3]);
      const written = await lines();
      expect(written).toHaveLength(3);
      expect(await readFile(file, 'utf8')).toMatch(/\n$/);
    });

    test('adds no blank line when the file already ends with a newline', async () => {
      await writeFile(file, `${eventLine(1)}\n`);

      const log = await RunLog.open(file, RUN_ID);
      await log.append(authLost(2));

      expect(await readFile(file, 'utf8')).not.toContain('\n\n');
      expect((await RunLog.read(file)).map((e) => e.seq)).toEqual([1, 2]);
    });
  });

  test('keeps 50 concurrent appends as 50 well-formed lines in order', async () => {
    const log = await RunLog.open(file, RUN_ID);
    const bodies = Array.from({ length: CONCURRENT_APPENDS }, (_, n) => authLost(n));

    const events = await Promise.all(bodies.map((body) => log.append(body)));

    const written = await lines();
    expect(written).toHaveLength(CONCURRENT_APPENDS);
    const parsed = written.map((line) => JSON.parse(line) as RunEvent);
    expect(parsed.map((e) => e.seq)).toEqual(Array.from({ length: CONCURRENT_APPENDS }, (_, n) => n + 1));
    expect(parsed.map((e) => (e.type === 'auth.lost' ? e.url : null))).toEqual(
      bodies.map((body) => (body.type === 'auth.lost' ? body.url : null)),
    );
    expect(events).toEqual(parsed);
  });

  test('a failed write rejects without consuming a sequence number or breaking later appends', async () => {
    const log = await RunLog.open(file, RUN_ID);
    await rm(dir, { recursive: true, force: true });

    await expect(log.append(authLost(1))).rejects.toThrow();
    await mkdir(dir, { recursive: true });
    const event = await log.append(authLost(2));

    expect(event.seq).toBe(1);
  });

  describe('read', () => {
    test('skips blank lines', async () => {
      const log = await RunLog.open(file, RUN_ID);
      await log.append(authLost(1));
      await writeFile(file, `\n${await readFile(file, 'utf8')}\n\n`);

      expect(await RunLog.read(file)).toHaveLength(1);
    });

    test('throws E_RUN_FAILED naming the line number of a malformed line', async () => {
      const log = await RunLog.open(file, RUN_ID);
      await log.append(authLost(1));
      await writeFile(file, `${await readFile(file, 'utf8')}{"type":"auth.lo\n`);

      const error = await RunLog.read(file).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(LookoverError);
      expect(error).toMatchObject({ code: 'E_RUN_FAILED' });
      expect((error as LookoverError).message).toContain('line 2');
    });

    test('throws E_RUN_FAILED for a line that is JSON but not a run event', async () => {
      await writeFile(file, '{"type":"auth.lost"}\n');

      const error = await RunLog.read(file).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'E_RUN_FAILED' });
      expect((error as LookoverError).message).toContain('line 1');
    });

    test('open refuses to continue a log that has a malformed line', async () => {
      await writeFile(file, 'not json\n');

      await expect(RunLog.open(file, RUN_ID)).rejects.toMatchObject({ code: 'E_RUN_FAILED' });
    });
  });
});

function countLinesSync(path: string): number {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '').length;
}

/** Records what `queueMicrotask` callbacks throw instead of letting it become an uncaught exception. */
function captureAsyncErrors(): unknown[] {
  const raised: unknown[] = [];
  const queue = globalThis.queueMicrotask.bind(globalThis);
  vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
    queue(() => {
      try {
        callback();
      } catch (error) {
        raised.push(error);
      }
    });
  });
  return raised;
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
