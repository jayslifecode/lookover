import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Attempt,
  type DecisionsFile,
  type Finding,
  type FindingsFile,
  readFindingsAt,
} from '@jayslifecode/lookover-core';
import type { ReplayResult, RunManifest } from '@jayslifecode/lookover-report/api';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ReportServer } from '../src/report/server.js';
import {
  createFixtureProject,
  FIXTURE_RUN_ID,
  FIXTURE_VERSION,
  type FixtureProject,
  OLDEST_RUN_ID,
  PREVIOUS_RUN_ID,
  serveFixtureRun,
} from './report-fixture.js';
import { rawGet } from './report-sse.js';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";
const IMMUTABLE = 'public, max-age=31536000, immutable';
const MAX_BODY_BYTES = 16 * 1024;
const EVIDENCE_PNG = '102580572b2d2bd5.png';

/** The finding a replay gets, and the promise it waits on (so a second replay finds it busy). */
interface ReplayCall {
  readonly finding: Finding;
  readonly release: (result: ReplayResult | Error) => void;
}

let project: FixtureProject;
let server: ReportServer;
let origin: string;
let cookie: string;
let findings: FindingsFile;
let replayCalls: ReplayCall[] = [];

function attempt(index: number, reproduced: boolean): Attempt {
  return { index, occurrence: null, reproduced, observed: null, skipped: null, durationMs: 10, evidence: [] };
}

beforeAll(async () => {
  project = await createFixtureProject('lookover-report-server-');
  findings = await readFindingsAt(join(project.runsDir, FIXTURE_RUN_ID, 'findings.json'));
  server = await serveFixtureRun(
    project,
    FIXTURE_RUN_ID,
    (finding) =>
      new Promise((resolve, reject) => {
        replayCalls = [
          ...replayCalls,
          { finding, release: (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome)) },
        ];
      }),
  );
  origin = `http://127.0.0.1:${server.port}`;
  cookie = `lookover_token=${server.token}`;
});

afterAll(async () => {
  await server.close();
  await rm(project.dir, { recursive: true, force: true });
});

interface ApiInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** A request with the token cookie, as the report sends it once the printed URL has been opened. */
function api(path: string, init: ApiInit = {}): Promise<Response> {
  return fetch(`${origin}${path}`, { ...init, headers: { cookie, ...init.headers } });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return api(path, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function firstFinding(): Finding {
  const [finding] = findings.findings;
  if (finding === undefined) throw new Error('The fixture run has no finding');
  return finding;
}

describe('the report server', () => {
  test('listens on 127.0.0.1 and prints a URL that carries a 32-hex-digit token', () => {
    expect(server.token).toMatch(/^[0-9a-f]{32}$/);
    expect(server.url).toBe(`${origin}/?token=${server.token}`);
  });

  describe('the built report', () => {
    test('serves index.html for /, with no cookie', async () => {
      const response = await fetch(`${origin}/`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await response.text()).toContain('<div id="root"></div>');
    });

    test('sets the token cookie from ?token and redirects to /', async () => {
      const response = await fetch(server.url, { redirect: 'manual' });

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/');
      expect(response.headers.get('set-cookie')).toBe(
        `lookover_token=${server.token}; Path=/; HttpOnly; SameSite=Strict`,
      );
    });

    test('serves a wrong ?token as plain /, setting no cookie', async () => {
      const response = await fetch(`${origin}/?token=${'0'.repeat(32)}`, { redirect: 'manual' });

      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toBeNull();
    });

    test('serves the hashed assets with their content type, immutable', async () => {
      const index = await (await fetch(`${origin}/`)).text();
      const script = /src="\.\/(assets\/[^"]+\.js)"/.exec(index)?.[1];
      const style = /href="\.\/(assets\/[^"]+\.css)"/.exec(index)?.[1];

      const js = await fetch(`${origin}/${script}`);
      const css = await fetch(`${origin}/${style}`);

      expect(js.status).toBe(200);
      expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
      expect(js.headers.get('cache-control')).toBe(IMMUTABLE);
      expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    });

    test.each([
      '/screens',
      '/assets/missing.js',
      '/../package.json',
      '/assets/../index.html',
      '/assets/%2e%2e/%2e%2e/package.json',
      '/assets/..%2f..%2fpackage.json',
      '/assets/',
    ])('answers %s with 404', async (path) => {
      const response = await rawGet(server.port, path);

      expect(response.status).toBe(404);
    });
  });

  describe('the token', () => {
    const gets = [
      '/api/run',
      '/api/events',
      '/api/files/app-map.json',
      '/api/files/findings.json',
      '/api/files/decisions.json',
      '/api/previous/findings.json',
      `/api/evidence/${EVIDENCE_PNG}`,
    ];

    test.each(gets)('GET %s is 401 without it', async (path) => {
      const response = await fetch(`${origin}${path}`);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: expect.any(String) });
    });

    test.each(['/api/decisions', '/api/replay'])('POST %s is 401 without it', async (path) => {
      const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { origin }, body: '{}' });

      expect(response.status).toBe(401);
    });

    test.each(gets.filter((path) => path !== '/api/events'))(
      'GET %s is 200 with the cookie',
      async (path) => {
        expect((await api(path)).status).toBe(200);
      },
    );

    test('is taken from the X-Lookover-Token header too', async () => {
      const response = await fetch(`${origin}/api/run`, { headers: { 'x-lookover-token': server.token } });

      expect(response.status).toBe(200);
    });

    // The tokens are made once the server is up: `test.each` reads its table before `beforeAll` runs.
    test.each([
      ['another token', () => '0'.repeat(32)],
      ['the token less its first digit', () => server.token.slice(1)],
      ['an empty one', () => ''],
    ])('refuses %s', async (_what, tokenOf) => {
      const token = tokenOf();
      const byCookie = await fetch(`${origin}/api/run`, { headers: { cookie: `lookover_token=${token}` } });
      const byHeader = await fetch(`${origin}/api/run`, { headers: { 'x-lookover-token': token } });

      expect(byCookie.status).toBe(401);
      expect(byHeader.status).toBe(401);
    });
  });

  describe('every response', () => {
    test.each([
      ['/', {}],
      ['/api/run', { cookie: 'x=1' }],
      ['/nope', {}],
    ])('of %s carries the security headers and no CORS header', async (path, headers) => {
      const response = await rawGet(server.port, path, headers);

      expect(response.headers['content-security-policy']).toBe(CSP);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(Object.keys(response.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
    });

    test.each(['PUT', 'DELETE', 'PATCH', 'OPTIONS'])('to %s is 405', async (method) => {
      const response = await api('/api/run', { method });

      expect(response.status).toBe(405);
    });
  });

  describe('GET /api/run', () => {
    test('answers the manifest of the run, with the previous run that wrote findings', async () => {
      const manifest = (await (await api('/api/run')).json()) as RunManifest;

      expect(manifest).toEqual({
        runId: FIXTURE_RUN_ID,
        baseUrl: 'http://localhost:3123',
        startedAt: '2026-10-22T12:28:02.814Z',
        status: 'finished',
        previousRunId: PREVIOUS_RUN_ID,
        lookoverVersion: FIXTURE_VERSION,
      } satisfies RunManifest);
    });

    test('says the oldest run is running and has no previous run', async () => {
      const oldest = await serveFixtureRun(project, OLDEST_RUN_ID);
      try {
        const headers = { 'x-lookover-token': oldest.token };
        const base = `http://127.0.0.1:${oldest.port}`;
        const manifest = (await (await fetch(`${base}/api/run`, { headers })).json()) as RunManifest;

        expect(manifest).toMatchObject({ runId: OLDEST_RUN_ID, status: 'running', previousRunId: null });
        expect((await fetch(`${base}/api/previous/findings.json`, { headers })).status).toBe(404);
        expect((await fetch(`${base}/api/files/findings.json`, { headers })).status).toBe(404);
      } finally {
        await oldest.close();
      }
    });
  });

  describe('the run files', () => {
    test('answers the app map and the findings of the run, and the project decisions', async () => {
      const map = (await (await api('/api/files/app-map.json')).json()) as { runId: string };
      const file = (await (await api('/api/files/findings.json')).json()) as FindingsFile;
      const decisions = (await (await api('/api/files/decisions.json')).json()) as DecisionsFile;

      expect(map.runId).toBe(FIXTURE_RUN_ID);
      expect(file.runId).toBe(FIXTURE_RUN_ID);
      expect(decisions.decisions).toHaveProperty('e9839cc1b237');
    });

    test('answers the previous run findings', async () => {
      const previous = (await (await api('/api/previous/findings.json')).json()) as FindingsFile;

      expect(previous.runId).toBe(PREVIOUS_RUN_ID);
    });

    test.each(['run.jsonl', 'nope.json', '../decisions.json'])(
      'answers /api/files/%s with 404',
      async (name) => {
        expect((await rawGet(server.port, `/api/files/${name}`, { cookie })).status).toBe(404);
      },
    );
  });

  describe('evidence', () => {
    test('serves a file under the run evidence/, immutable', async () => {
      const png = await api(`/api/evidence/${EVIDENCE_PNG}`);
      const json = await api('/api/evidence/gallery-38a8049145-11c8a5735bd278cc.json');

      expect(png.status).toBe(200);
      expect(png.headers.get('content-type')).toBe('image/png');
      expect(png.headers.get('cache-control')).toBe(IMMUTABLE);
      expect(json.headers.get('content-type')).toBe('application/json; charset=utf-8');
    });

    test.each([
      '/api/evidence/../findings.json',
      '/api/evidence/../../../decisions.json',
      '/api/evidence/%2e%2e/findings.json',
      '/api/evidence/..%2ffindings.json',
      '/api/evidence/%2e%2e%2f%2e%2e%2f%2e%2e%2fdecisions.json',
      '/api/evidence/%2fetc%2fpasswd',
      '/api/evidence//etc/passwd',
      '/api/evidence/',
      '/api/evidence/%E0%A4%A',
      '/api/evidence/nope.png',
    ])('answers %s with 404', async (path) => {
      expect((await rawGet(server.port, path, { cookie })).status).toBe(404);
    });
  });

  describe('POST', () => {
    test.each([
      ['no Origin', (): Record<string, string> => ({})],
      ['another origin', () => ({ origin: 'http://evil.test' })],
      ['the same port on localhost', () => ({ origin: `http://localhost:${server.port}` })],
    ])('with %s is 403', async (_what, headersOf) => {
      const response = await api('/api/decisions', {
        method: 'POST',
        headers: headersOf(),
        body: JSON.stringify({ findingId: firstFinding().id, status: 'intended' }),
      });

      expect(response.status).toBe(403);
    });

    test('of a body over 16 KB is 413', async () => {
      const note = 'x'.repeat(MAX_BODY_BYTES);
      const response = await post('/api/decisions', {
        findingId: firstFinding().id,
        status: 'intended',
        note,
      });

      expect(response.status).toBe(413);
    });

    test.each([
      ['not JSON', '{'],
      ['no finding id', { status: 'intended' }],
      ['another status', { findingId: 'abc', status: 'fixed' }],
      ['a note that is not text', { findingId: 'abc', status: 'intended', note: 3 }],
    ])('of %s is 400 with a message', async (_what, body) => {
      const response = await post('/api/decisions', body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
    });
  });

  describe('POST /api/decisions', () => {
    async function onDisk(): Promise<DecisionsFile> {
      return JSON.parse(await readFile(join(project.lookoverDir, 'decisions.json'), 'utf8')) as DecisionsFile;
    }

    test('marks a finding intended, keeping the other decisions, and answers them all', async () => {
      const { id } = firstFinding();

      const response = await post('/api/decisions', {
        findingId: id,
        status: 'intended',
        note: 'on purpose',
      });

      expect(response.status).toBe(200);
      const { decisions } = (await response.json()) as { decisions: DecisionsFile['decisions'] };
      expect(decisions[id]).toMatchObject({ status: 'intended', note: 'on purpose' });
      expect(decisions).toHaveProperty('e9839cc1b237');
      expect((await onDisk()).decisions).toEqual(decisions);
    });

    test('forgets a decision with status null', async () => {
      const { id } = firstFinding();
      await post('/api/decisions', { findingId: id, status: 'intended' });

      const response = await post('/api/decisions', { findingId: id, status: null });

      expect(response.status).toBe(200);
      expect((await onDisk()).decisions).not.toHaveProperty(id);
    });

    test('writes two decisions sent at once one after the other, so both land', async () => {
      const [a, b] = findings.findings.slice(1, 3).map(({ id }) => id);

      const responses = await Promise.all([
        post('/api/decisions', { findingId: a, status: 'intended' }),
        post('/api/decisions', { findingId: b, status: 'intended' }),
      ]);

      expect(responses.map(({ status }) => status)).toEqual([200, 200]);
      expect(Object.keys((await onDisk()).decisions)).toEqual(expect.arrayContaining([a, b]));
    });

    test('is 404 for a finding the run does not have', async () => {
      const response = await post('/api/decisions', { findingId: 'ffffffffffff', status: 'intended' });

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/replay', () => {
    test('replays the finding and answers its attempts; a second replay meanwhile is 409', async () => {
      const finding = firstFinding();
      const first = post('/api/replay', { findingId: finding.id });
      await expect.poll(() => replayCalls.length).toBe(1);

      const second = await post('/api/replay', { findingId: finding.id });
      replayCalls[0]?.release({ attempts: [attempt(1, true)], reproduced: 1, of: 1 });
      const response = await first;

      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({ error: 'A replay is already running' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ attempts: [attempt(1, true)], reproduced: 1, of: 1 });
      expect(replayCalls[0]?.finding.id).toBe(finding.id);
    });

    test('answers a replay that fails with 500 and the first line of its message, redacted', async () => {
      replayCalls = [];
      const pending = post('/api/replay', { findingId: firstFinding().id });
      await expect.poll(() => replayCalls.length).toBe(1);

      replayCalls[0]?.release(new Error('The browser closed for ann@example.com\n    at stack'));
      const response = await pending;

      expect(response.status).toBe(500);
      const { error } = (await response.json()) as { error: string };
      expect(error).toContain('The browser closed');
      expect(error).not.toContain('ann@example.com');
      expect(error).not.toContain('at stack');
    });

    test('is 404 for a finding the run does not have, and replays nothing', async () => {
      replayCalls = [];

      const response = await post('/api/replay', { findingId: 'ffffffffffff' });

      expect(response.status).toBe(404);
      expect(replayCalls).toEqual([]);
    });
  });
});
