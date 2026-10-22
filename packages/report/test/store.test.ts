// @vitest-environment node
import type { RunEvent } from '@jayslifecode/lookover-core';
import { afterEach, expect, test, vi } from 'vitest';
import type { RunFileName, RunManifest } from '../node/api';
import { ApiError } from '../src/data/api';
import { createReportStore, type ReportApi, type ReportStore } from '../src/data/store';
import { eventsOf, fixtureEvents, fixtureFindings, fixturePreviousFindings } from './fixture';

const EVENTS = fixtureEvents();
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
  const subscribe = vi.fn((next: (event: RunEvent) => void, fail: (message: string) => void) => {
    onEvent = next;
    onError = fail;
    return () => {
      onEvent = null;
    };
  });
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
  expect(server.subscribe).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), 0);
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
    manifest: { status: 'running', previousRunId: '20261022-195451-z1gy' },
    files: { 'findings.json': fixtureFindings(), 'decisions.json': { version: 1, decisions: {} } },
  });
  const report = started(server.api);
  await vi.waitFor(() => expect(server.subscribe).toHaveBeenCalled());
  await vi.waitFor(() => expect(report.getSnapshot().previous?.runId).toBe('20261022-195451-z1gy'));

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
