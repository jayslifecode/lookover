import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type Finding, readFindingsAt } from '@jayslifecode/lookover-core';
import { tokenCookieName } from '@jayslifecode/lookover-report/api';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ReportServer } from '../src/report/server.js';
import {
  createFixtureProject,
  FIXTURE_RUN_ID,
  type FixtureProject,
  serveFixtureRun,
} from './report-fixture.js';
import { rawGet, rawRequest } from './report-sse.js';

/*
 * Who gets in: a request addressed to the server by its own name, holding its own cookie (whatever other
 * cookies of that name ride along), and for a write, a page of one of the server's own origins.
 */

let project: FixtureProject;
let server: ReportServer;
let cookie: string;
let finding: Finding;

beforeAll(async () => {
  project = await createFixtureProject('lookover-report-access-');
  server = await serveFixtureRun(project, FIXTURE_RUN_ID);
  cookie = `${tokenCookieName(server.port)}=${server.token}`;
  const [first] = (await readFindingsAt(join(project.runsDir, FIXTURE_RUN_ID, 'findings.json'))).findings;
  if (first === undefined) throw new Error('The fixture run has no finding');
  finding = first;
});

afterAll(async () => {
  await server.close();
  await rm(project.dir, { recursive: true, force: true });
});

/** `POST /api/decisions` for the fixture's first finding, with the cookie and these `headers`. */
function decide(headers: Readonly<Record<string, string>>) {
  return rawRequest(server.port, {
    method: 'POST',
    path: '/api/decisions',
    headers: { cookie, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ findingId: finding.id, status: 'intended' }),
  });
}

describe('the cookie, one per port', () => {
  test('of another server on 127.0.0.1 is refused, its own accepted, each by its own name', async () => {
    const other = await serveFixtureRun(project, FIXTURE_RUN_ID);
    const run = (port: number, sent: string) =>
      fetch(`http://127.0.0.1:${port}/api/run`, { headers: { cookie: sent } });
    try {
      const otherCookie = `${tokenCookieName(other.port)}=${other.token}`;

      expect((await run(server.port, otherCookie)).status).toBe(401);
      expect((await run(other.port, cookie)).status).toBe(401);
      expect((await run(server.port, `${cookie}; ${otherCookie}`)).status).toBe(200);
      expect((await run(other.port, `${cookie}; ${otherCookie}`)).status).toBe(200);
      expect((await run(server.port, `lookover_token=${server.token}`)).status).toBe(401);
    } finally {
      await other.close();
    }
  });

  test('lets the request in when any cookie of its name holds the token, not only the first', async () => {
    const planted = `${tokenCookieName(server.port)}=${'0'.repeat(32)}`;

    const response = await rawGet(server.port, '/api/run', { cookie: `${planted}; ${cookie}` });

    expect(response.status).toBe(200);
  });
});

describe('the Host header', () => {
  test.each([
    ['/', () => ({ host: `evil.test:${server.port}` })],
    ['/api/run', () => ({ host: 'evil.test', cookie })],
    ['/assets/missing.js', () => ({ host: '127.0.0.1:1' })],
    ['/api/decisions', () => ({ host: `127.0.0.1.evil.test:${server.port}`, cookie })],
  ])('of anything but this server answers %s with 421, before anything else', async (path, headersOf) => {
    const response = await rawGet(server.port, path, headersOf());

    expect(response.status).toBe(421);
    expect(response.headers['content-security-policy']).toBeDefined();
  });

  test('may name the server as localhost', async () => {
    expect((await rawGet(server.port, '/', { host: `localhost:${server.port}` })).status).toBe(200);
    expect((await rawGet(server.port, '/api/run', { host: `localhost:${server.port}`, cookie })).status).toBe(
      200,
    );
  });
});

describe('the Origin of a POST', () => {
  test.each([
    ['no Origin', (): Record<string, string> => ({})],
    ['another origin', () => ({ origin: 'http://evil.test' })],
    ['localhost on another port', () => ({ origin: `http://localhost:${server.port + 1}` })],
    ['https on the same port', () => ({ origin: `https://127.0.0.1:${server.port}` })],
  ])('is refused with 403 for %s', async (_what, headersOf) => {
    expect((await decide(headersOf())).status).toBe(403);
  });

  test.each([
    ['127.0.0.1', '127.0.0.1'],
    ['localhost', 'localhost'],
  ])('is accepted from the report opened as %s', async (_what, name) => {
    const host = `${name}:${server.port}`;

    const response = await decide({ host, origin: `http://${host}` });

    expect(response.status).toBe(200);
  });
});
