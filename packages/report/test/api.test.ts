import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { RunManifest } from '../node/api';
import { FakeEventSource } from './event-source';
import { eventOf } from './fixture';

const MANIFEST: RunManifest = {
  runId: '20261022-195459-canl',
  baseUrl: 'http://localhost:3123',
  startedAt: '2026-10-22T10:54:59.071Z',
  status: 'finished',
  previousRunId: null,
  lookoverVersion: '0.0.0',
};

/** A fresh copy of the API module, as after a page load: the page's token is read once per load. */
async function loadApi() {
  vi.resetModules();
  return import('../src/data/api');
}

function stubFetch(body: unknown, status = 200) {
  const fetch = vi.fn(
    async (_path: string, _init?: RequestInit) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response,
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('evidence URLs stay inside the run evidence directory', async () => {
  const { evidenceUrl } = await loadApi();
  expect(evidenceUrl({ path: 'evidence/0a1b2c3d4e5f6a7b.png' })).toBe('/api/evidence/0a1b2c3d4e5f6a7b.png');
  expect(evidenceUrl({ path: 'evidence/crops/a b#c.png' })).toBe('/api/evidence/crops/a%20b%23c.png');
  const outside = [
    'evidence/../findings.json',
    'evidence/crops/../../decisions.json',
    'evidence/./x.png',
    'evidence/..',
    'evidence/',
    'evidence//x.png',
    'other/x.png',
    '../evidence/x.png',
  ];
  for (const path of outside) expect(evidenceUrl({ path }), path).toBeNull();
});

test('a page opened with ?token= sends it as the header and takes it out of the address bar', async () => {
  window.history.replaceState(null, '', '/?token=s3cret&view=1#/findings');
  const fetch = stubFetch(MANIFEST);
  const api = await loadApi();

  await expect(api.fetchManifest()).resolves.toEqual(MANIFEST);
  expect(window.location.search).toBe('?view=1');
  expect(window.location.hash).toBe('#/findings');
  // Read once: the next request still carries it, though the address bar no longer does.
  await api.fetchManifest();

  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [path, init] of fetch.mock.calls) {
    expect(path).toBe('/api/run');
    expect(init?.headers).toMatchObject({ 'x-lookover-token': 's3cret' });
  }
});

test('without ?token= the cookie is relied on: no token header', async () => {
  const fetch = stubFetch(MANIFEST);
  const api = await loadApi();
  await api.fetchManifest();
  expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty('x-lookover-token');
});

test("a refused request is an ApiError with the server's message; an answer of the wrong shape is refused", async () => {
  stubFetch({ error: 'The report token is missing or wrong' }, 403);
  const api = await loadApi();
  await expect(api.fetchManifest()).rejects.toMatchObject({
    name: 'ApiError',
    status: 403,
    message: 'The report token is missing or wrong',
  });

  stubFetch({ runId: 1 });
  await expect(api.fetchManifest()).rejects.toThrow(/cannot read/u);

  stubFetch({ error: 'No previous run' }, 404);
  await expect(api.fetchPreviousFindings()).resolves.toBeNull();
});

test('the event stream delivers each event once and after lastSeq, and reports what is not an event', async () => {
  vi.stubGlobal('EventSource', FakeEventSource);
  const api = await loadApi();
  const seen: number[] = [];
  const errors: string[] = [];
  const opened = vi.fn();
  const unsubscribe = api.subscribe(
    (event) => seen.push(event.seq),
    (message) => errors.push(message),
    5,
    opened,
  );
  const source = FakeEventSource.latest as FakeEventSource;
  expect(source.url).toBe('/api/events');
  source.open();
  expect(opened).toHaveBeenCalledTimes(1);

  // A server that starts over replays what was seen; an older event arriving late is dropped too.
  for (const seq of [4, 5, 6, 6, 8, 7])
    source.send(eventOf({ type: 'judge.unavailable', reason: 'disabled', message: 'off' }, seq));
  expect(seen).toEqual([6, 8]);

  source.send('not json');
  source.send({ hello: 'world' });
  expect(errors).toHaveLength(2);

  // A dropped stream the browser is reconnecting (CONNECTING) is reported as such, and its reopening
  // told; the browser resumes after the last id it saw. A stream it gave up on (CLOSED) is an error.
  source.drop();
  expect(errors.at(-1)).toBe(api.STREAM_RECONNECTING);
  source.open();
  expect(opened).toHaveBeenCalledTimes(2);
  source.send(eventOf({ type: 'judge.unavailable', reason: 'disabled', message: 'off' }, 9));
  expect(seen).toEqual([6, 8, 9]);
  source.readyState = FakeEventSource.CLOSED;
  source.onerror?.();
  expect(errors).toHaveLength(4);
  expect(errors.at(-1)).toMatch(/closed by the report server/);

  unsubscribe();
  expect(source.isClosed).toBe(true);
});

/** A `fetch` that never answers, and rejects as the browser's does when its request is aborted. */
function stubHungFetch() {
  const fetch = vi.fn(
    (_path: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

test('a POST the server never answers is given up on: a decision after 15 s, a replay after 120 s', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    stubHungFetch();
    const api = await loadApi();
    const decision = api.postDecision({ findingId: 'a', status: 'intended' });
    const replay = api.postReplay({ findingId: 'a' });
    const settled: string[] = [];
    decision.catch(() => settled.push('decision'));
    replay.catch(() => settled.push('replay'));

    await vi.advanceTimersByTimeAsync(api.DECISION_TIMEOUT_MS - 1);
    expect(settled).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(decision).rejects.toThrow('The report server did not answer within 15 s');
    expect(settled).toEqual(['decision']);

    await vi.advanceTimersByTimeAsync(api.REPLAY_TIMEOUT_MS - api.DECISION_TIMEOUT_MS);
    await expect(replay).rejects.toThrow('The report server did not answer within 120 s');
  } finally {
    vi.useRealTimers();
  }
});

test('an answered POST leaves no timer behind, and a refusal stays a refusal', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    stubFetch({ attempts: [], reproduced: 1, of: 1 });
    const api = await loadApi();
    await expect(api.postReplay({ findingId: 'a' })).resolves.toMatchObject({ reproduced: 1, of: 1 });
    expect(vi.getTimerCount()).toBe(0);

    stubFetch({ error: 'A replay is already running' }, 409);
    await expect(api.postReplay({ findingId: 'a' })).rejects.toMatchObject({ status: 409 });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
