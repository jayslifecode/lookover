import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type DecisionsFile, type Finding, readFindingsAt } from '@jayslifecode/lookover-core';
import { type DecisionResponse, tokenCookieName } from '@jayslifecode/lookover-report/api';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ReplayFinding, ReportServer } from '../src/report/server.js';
import {
  createFixtureProject,
  FIXTURE_RUN_ID,
  type FixtureProject,
  serveFixtureRun,
  startedEvent,
  UNFINISHED_RUN_ID,
} from './report-fixture.js';

/*
 * A run that is still going has no findings.json yet: its findings are in its log, as `finding.candidate`
 * and `finding.judged` events. A decision on one of them is written for the next run; a replay waits for
 * the run to finish, since the run's browser session is busy.
 */

let project: FixtureProject;
let live: ReportServer;
let candidate: Finding;
let judged: Finding;
let notLogged: Finding;
const replay = vi.fn<ReplayFinding>();

beforeAll(async () => {
  project = await createFixtureProject('lookover-report-live-');
  const [first, second, third] = (
    await readFindingsAt(join(project.runsDir, FIXTURE_RUN_ID, 'findings.json'))
  ).findings;
  if (first === undefined || second === undefined || third === undefined) {
    throw new Error('The fixture run has fewer than three findings');
  }
  [candidate, judged, notLogged] = [first, second, third];
  const events = [
    startedEvent(UNFINISHED_RUN_ID),
    { type: 'finding.candidate', finding: candidate, seq: 2, at: 'now', runId: UNFINISHED_RUN_ID },
    { type: 'finding.judged', finding: judged, seq: 3, at: 'now', runId: UNFINISHED_RUN_ID },
  ];
  await writeFile(
    join(project.runsDir, UNFINISHED_RUN_ID, 'run.jsonl'),
    events.map((event) => `${JSON.stringify(event)}\n`).join(''),
  );
  live = await serveFixtureRun(project, UNFINISHED_RUN_ID, replay);
});

afterAll(async () => {
  await live.close();
  await rm(project.dir, { recursive: true, force: true });
});

/** A POST to `on` as the report sends it: the token cookie, the server's own origin, a JSON body. */
function post(on: ReportServer, path: string, body: unknown): Promise<Response> {
  const origin = `http://127.0.0.1:${on.port}`;
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      cookie: `${tokenCookieName(on.port)}=${on.token}`,
      origin,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function onDisk(): Promise<DecisionsFile> {
  return JSON.parse(await readFile(join(project.lookoverDir, 'decisions.json'), 'utf8')) as DecisionsFile;
}

describe('a run that is still going', () => {
  test.each([
    ['a candidate', () => candidate],
    ['a judged finding', () => judged],
  ])('records a decision on %s of its log, for the next run', async (_what, findingOf) => {
    const { id } = findingOf();

    const response = await post(live, '/api/decisions', { findingId: id, status: 'intended' });

    expect(response.status).toBe(200);
    const body = (await response.json()) as DecisionResponse;
    expect(body.appliesNextRun).toBe(true);
    expect(body.decisions[id]).toMatchObject({ status: 'intended', note: null });
    expect((await onDisk()).decisions).toHaveProperty(id);
  });

  test('forgets a decision for the next run too', async () => {
    await post(live, '/api/decisions', { findingId: candidate.id, status: 'intended' });

    const response = await post(live, '/api/decisions', { findingId: candidate.id, status: null });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ appliesNextRun: true });
    expect((await onDisk()).decisions).not.toHaveProperty(candidate.id);
  });

  test('is 404 for a finding its log does not name', async () => {
    const response = await post(live, '/api/decisions', { findingId: notLogged.id, status: 'intended' });

    expect(response.status).toBe(404);
    expect((await onDisk()).decisions).not.toHaveProperty(notLogged.id);
  });

  test('answers a replay with 409 until the run finishes, and replays nothing', async () => {
    const response = await post(live, '/api/replay', { findingId: candidate.id });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Replay is available when the run finishes' });
    expect(replay).not.toHaveBeenCalled();
  });
});

describe('a run that has finished', () => {
  test('answers a decision without appliesNextRun: its findings file is what the report shows', async () => {
    const finished = await serveFixtureRun(project, FIXTURE_RUN_ID);
    try {
      const response = await post(finished, '/api/decisions', {
        findingId: notLogged.id,
        status: 'intended',
      });

      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty('appliesNextRun');
    } finally {
      await finished.close();
    }
  });
});
