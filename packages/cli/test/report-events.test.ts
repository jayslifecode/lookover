import { appendFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ReportServer } from '../src/report/server.js';
import { POLL_INTERVAL_MS } from '../src/report/sse.js';
import {
  createFixtureProject,
  FIXTURE_RUN_ID,
  type FixtureProject,
  OLDEST_RUN_ID,
  serveFixtureRun,
  startedEvent,
} from './report-fixture.js';
import { StreamReader } from './report-sse.js';

/** The fixture run's log has this many events, `run.finished` last. */
const FIXTURE_EVENTS = 95;
const RESUMED_AFTER = 90;

let project: FixtureProject;
let server: ReportServer;

beforeAll(async () => {
  project = await createFixtureProject('lookover-report-events-');
  server = await serveFixtureRun(project, FIXTURE_RUN_ID);
});

afterAll(async () => {
  await server.close();
  await rm(project.dir, { recursive: true, force: true });
});

/** `GET /api/events` of `on`, with its token and the extra `headers`. */
function events(on: ReportServer, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${on.port}/api/events`, {
    headers: { 'x-lookover-token': on.token, ...headers },
  });
}

/** A route.discovered event as the run log would hold it. */
function routeEvent(seq: number): Record<string, unknown> {
  return { type: 'route.discovered', route: { pattern: `/${seq}` }, seq, at: 'now', runId: OLDEST_RUN_ID };
}

describe('GET /api/events', () => {
  test('streams every event of the run log with its seq as the id', async () => {
    const response = await events(server);
    const stream = new StreamReader(response);
    try {
      const messages = await stream.next(FIXTURE_EVENTS);

      expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(messages.map(({ id }) => id)).toEqual(
        Array.from({ length: FIXTURE_EVENTS }, (_, index) => String(index + 1)),
      );
      expect(messages.at(-1)?.data.type).toBe('run.finished');
    } finally {
      await stream.cancel();
    }
  });

  test('starts after Last-Event-ID', async () => {
    const stream = new StreamReader(await events(server, { 'last-event-id': String(RESUMED_AFTER) }));
    try {
      const messages = await stream.next(FIXTURE_EVENTS - RESUMED_AFTER);

      expect(messages.map(({ id }) => id)).toEqual(['91', '92', '93', '94', '95']);
    } finally {
      await stream.cancel();
    }
  });

  test('then streams each event appended to the log, once its line is complete', async () => {
    const log = join(project.runsDir, OLDEST_RUN_ID, 'run.jsonl');
    await writeFile(log, `${JSON.stringify(startedEvent(OLDEST_RUN_ID))}\n`);
    const live = await serveFixtureRun(project, OLDEST_RUN_ID);
    const stream = new StreamReader(await events(live));
    try {
      const [existing] = await stream.next(1);
      const line = JSON.stringify(routeEvent(2));
      // Half a line first, read by a poll or two: nothing is sent for it until its newline is written.
      await appendFile(log, line.slice(0, 20));
      await delay(POLL_INTERVAL_MS * 2);
      await appendFile(log, `${line.slice(20)}\n${JSON.stringify(routeEvent(3))}\n`);
      const appended = await stream.next(2);

      expect(existing?.id).toBe('1');
      expect(appended).toEqual([
        { id: '2', data: routeEvent(2) },
        { id: '3', data: routeEvent(3) },
      ]);
    } finally {
      await stream.cancel();
      await live.close();
    }
  });

  test('lets the server close while a stream is open', async () => {
    const other = await serveFixtureRun(project, FIXTURE_RUN_ID);
    const stream = new StreamReader(await events(other));
    await stream.next(1);

    await other.close();

    await expect(fetch(`http://127.0.0.1:${other.port}/`)).rejects.toThrow();
    await stream.cancel();
  });
});
