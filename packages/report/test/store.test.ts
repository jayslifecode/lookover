// @vitest-environment node
import type { RunEvent } from '@jayslifecode/lookover-core';
import { afterEach, expect, test, vi } from 'vitest';
import type { RunFileName, RunManifest } from '../node/api';
import { ApiError, STREAM_RECONNECTING } from '../src/data/api';
import { createReportStore, type ReportApi, type ReportStore } from '../src/data/store';
import { eventsOf, fixtureEvents, fixtureFindings, fixturePreviousFindings } from './fixture';

const EVENTS = fixtureEvents();
const PREVIOUS_RUN_ID = fixturePreviousFindings().runId;
const MANIFEST: RunManifest = {
  runId: '20261022-195459-canl',
  baseUrl: 'http://localhost:3123',
  startedAt: '2026-10-22T10:54:59.071Z',
  status: 'finished',
  previousRunId: null,
  lookoverVersion: '0.0.0',
};

interface FakeServer {
  readonly api: ReportApi;
  readonly requestedFiles: RunFileName[];
  emit(events: readonly RunEvent[]): void;
  failStream(message: string): void;
  openStream(): void;
  readonly subscribe: ReturnType<typeof vi.fn>;
}

function fakeServer(options: {
  manifest?: Partial<RunManifest>;
  manifestError?: Error;
  files?: Partial<Record<RunFileName, unknown>>;
}): FakeServer {
  const requestedFiles: RunFileName[] = [];
  let onEvent: ((event: RunEvent) => void) | null = null;
  let onError: ((message: string) => void) | null = null;
  let onOpen: (() => void) | undefined;
  const subscribe = vi.fn(
    (next: (event: RunEvent) => void, fail: (message: string) => void, _lastSeq = 0, open?: () => void) => {
      onEvent = next;
      onError = fail;
      onOpen = open;
      return () => {
        onEvent = null;
      };
    },
  );
  const fetchRunFile = async (name: RunFileName) => {
    requestedFiles.push(name);
    const body = options.files?.[name];
    if (body === undefined) throw new ApiError(404, `No run file ${name}`);
    return body;
  };
  const api: ReportApi = {
    fetchManifest: async () => {
      if (options.manifestError !== undefined) throw options.manifestError;
      return { ...MANIFEST, ...options.manifest };
    },
    fetchRunFile: fetchRunFile as ReportApi['fetchRunFile'],
    fetchPreviousFindings: async () => fixturePreviousFindings(),
    subscribe,
  };
  return {
    api,
    requestedFiles,
    subscribe,
    emit: (events) => {
      for (const event of events) onEvent?.(event);
    },
    failStream: (message) => onError?.(message),
    openStream: () => onOpen?.(),
  };
}

let store: ReportStore | null = null;

function started(api: ReportApi): ReportStore {
  store = createReportStore(api);
  store.subscribe(() => undefined);
  return store;
}

afterEach(() => {
  store?.stop();
  store = null;
});

test('a finished run: the manifest, then the event stream, and its findings file as the authoritative list', async () => {
  const server = fakeServer({ files: { 'findings.json': fixtureFindings() } });
  const report = started(server.api);

  await vi.waitFor(() => expect(report.getSnapshot().findingsSource).toBe('file'));
  // Followed from the last event reduced; the stream tells the store when it (re)opens.
  expect(server.subscribe).toHaveBeenCalledWith(
    expect.any(Function),
    expect.any(Function),
    0,
    expect.any(Function),
  );
  expect(report.getSnapshot().manifest).toEqual(MANIFEST);
  await vi.waitFor(() => expect(report.getSnapshot().decisions).toEqual({ version: 1, decisions: {} }));

  server.emit(EVENTS);
  const state = report.getSnapshot();
  expect(state.screens).toHaveLength(3);
  expect(state.judged.size).toBe(28);
  expect(state.lastSeq).toBe(95);
  expect(server.requestedFiles.filter((name) => name === 'findings.json')).toHaveLength(1);
  // No previous run: nothing asked for, nothing wrong.
  expect(state.previous).toBeNull();
  expect(state.errors).toEqual([]);
});

test('a running run builds from its events, and loads the findings file once they close the run', async () => {
  const server = fakeServer({
    manifest: { status: 'running', previousRunId: PREVIOUS_RUN_ID },
    files: { 'findings.json': fixtureFindings(), 'decisions.json': { version: 1, decisions: {} } },
  });
  const report = started(server.api);
  await vi.waitFor(() => expect(server.subscribe).toHaveBeenCalled());
  await vi.waitFor(() => expect(report.getSnapshot().previous?.runId).toBe(PREVIOUS_RUN_ID));

  const finished = EVENTS.findIndex((event) => event.type === 'run.finished');
  server.emit(EVENTS.slice(0, finished));
  expect(report.getSnapshot().findingsSource).toBe('events');
  expect(report.getSnapshot().judged.size).toBe(eventsOf(EVENTS, 'finding.judged').length);
  expect(server.requestedFiles).not.toContain('findings.json');

  server.emit(EVENTS.slice(finished));
  await vi.waitFor(() => expect(report.getSnapshot().findingsSource).toBe('file'));
  expect(report.getSnapshot().run.status).toBe('finished');
});

test('what cannot be loaded is kept as a plain message; a failed run without a findings file is not an error', async () => {
  const refused = fakeServer({ manifestError: new ApiError(403, 'The report token is missing or wrong') });
  const report = started(refused.api);
  await vi.waitFor(() => expect(report.getSnapshot().errors).toHaveLength(1));
  expect(report.getSnapshot().errors).toEqual([
    { source: 'manifest', message: 'The report token is missing or wrong' },
  ]);
  expect(refused.subscribe).not.toHaveBeenCalled();
  report.stop();

  const failed = fakeServer({ manifest: { status: 'failed' } });
  const failedReport = started(failed.api);
  await vi.waitFor(() => expect(failed.requestedFiles).toContain('findings.json'));
  failed.failStream('The event stream was closed');
  await vi.waitFor(() => expect(failedReport.getSnapshot().decisions).not.toBeNull());
  expect(failedReport.getSnapshot().errors).toEqual([
    { source: 'events', message: 'The event stream was closed' },
  ]);
});

test('an event of a known type without its payload is reported, and the run is still followed', async () => {
  const server = fakeServer({ manifest: { status: 'running' } });
  const report = started(server.api);
  await vi.waitFor(() => expect(server.subscribe).toHaveBeenCalled());
  const [runStarted, , third] = EVENTS;
  const broken = { type: 'finding.judged', seq: 2, at: MANIFEST.startedAt, runId: MANIFEST.runId };

  server.emit([runStarted, broken as unknown as RunEvent, third].filter((event) => event !== undefined));

  const state = report.getSnapshot();
  expect(state.errors).toEqual([
    {
      source: 'events',
      message: expect.stringMatching(/^The run event 2 \(finding\.judged\) could not be read: /u),
    },
  ]);
  expect(state.judged.size).toBe(0);
  expect(state.lastSeq).toBe(third?.seq);
});

test('a dropped stream is reported until it opens again; other stream errors stay', async () => {
  const server = fakeServer({ manifest: { status: 'running' } });
  const report = started(server.api);
  await vi.waitFor(() => expect(server.subscribe).toHaveBeenCalled());

  server.failStream(STREAM_RECONNECTING);
  expect(report.getSnapshot().errors).toEqual([{ source: 'events', message: STREAM_RECONNECTING }]);
  server.openStream();
  expect(report.getSnapshot().errors).toEqual([]);

  server.failStream('The event stream sent a message that is not a run event');
  server.openStream();
  expect(report.getSnapshot().errors).toHaveLength(1);
});

test('a run the server does not have (its manifest is not found) is marked so, for the no-run state', async () => {
  const missing = fakeServer({ manifestError: new ApiError(404, 'No run yet') });
  const report = started(missing.api);
  await vi.waitFor(() => expect(report.getSnapshot().errors).toHaveLength(1));

  expect(report.getSnapshot().errors).toEqual([
    { source: 'manifest', message: 'No run yet', isNotFound: true },
  ]);
});

test("the decisions the server answers a decision with replace the store's, and the store tells its readers", async () => {
  const server = fakeServer({ files: { 'findings.json': fixtureFindings() } });
  const report = started(server.api);
  await vi.waitFor(() => expect(report.getSnapshot().decisions).toEqual({ version: 1, decisions: {} }));
  const listener = vi.fn();
  report.subscribe(listener);
  const decision = { status: 'intended', at: '2026-10-22T13:00:00.000Z', note: 'On purpose' } as const;

  report.applyDecisions({ da77d007d373: decision });

  expect(report.getSnapshot().decisions).toEqual({ version: 1, decisions: { da77d007d373: decision } });
  expect(listener).toHaveBeenCalledTimes(1);
});
