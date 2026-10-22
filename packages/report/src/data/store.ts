import type { DecisionsFile, RunEvent } from '@jayslifecode/lookover-core';
import { useSyncExternalStore } from 'react';
import type { RunManifest } from '../../node/api';
import * as api from './api';
import {
  initialState,
  isRunClosed,
  type ReportErrorSource,
  type ReportState,
  reduce,
  withDecisions,
  withError,
  withFindingsFile,
  withManifest,
  withoutError,
  withPrevious,
} from './reduce';

/*
 * The report's run, as one external store React reads with `useSyncExternalStore`. It starts when the
 * first component subscribes: the manifest first, then the event stream from the start of the run log.
 * A run that is over (by the manifest, or once its events close it) also loads `findings.json`, which
 * then replaces what the events built; the decisions and the previous run's findings load beside. What
 * fails to load is kept in the state as a plain message for the UI.
 */

/** What the store needs from the server; `./api` in the report, a stand-in in tests. */
export interface ReportApi {
  readonly fetchManifest: typeof api.fetchManifest;
  readonly fetchRunFile: typeof api.fetchRunFile;
  readonly fetchPreviousFindings: typeof api.fetchPreviousFindings;
  readonly subscribe: typeof api.subscribe;
}

export interface ReportStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ReportState;
  /** Starts loading, once; `subscribe` calls it. */
  start(): void;
  /** Stops the stream and the loads in flight. */
  stop(): void;
  /** Takes the project's decisions as the server answered a decision (`POST /api/decisions`). */
  applyDecisions(decisions: DecisionsFile['decisions']): void;
}

const NO_DECISIONS: DecisionsFile = { version: 1, decisions: {} };
const DECISIONS_VERSION = 1;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createReportStore(server: ReportApi = api): ReportStore {
  let state = initialState();
  const listeners = new Set<() => void>();
  let controller: AbortController | null = null;
  let closeStream: (() => void) | null = null;
  let isFindingsRequested = false;

  const update = (change: (current: ReportState) => ReportState) => {
    const next = change(state);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const failed = (source: ReportErrorSource, signal: AbortSignal) => (error: unknown) => {
    if (!signal.aborted) update((current) => withError(current, { source, message: messageOf(error) }));
  };

  /** Once per store: a failed run may have no findings file, which is no error. */
  const loadFindings = (signal: AbortSignal) => {
    if (isFindingsRequested) return;
    isFindingsRequested = true;
    server.fetchRunFile('findings.json', signal).then(
      (file) => update((current) => withFindingsFile(current, file)),
      (error: unknown) => {
        if (!api.isNotFound(error)) failed('findings', signal)(error);
      },
    );
  };

  const loadBeside = (signal: AbortSignal, previousRunId: string | null) => {
    server.fetchRunFile('decisions.json', signal).then(
      (decisions) => update((current) => withDecisions(current, decisions)),
      (error: unknown) => {
        if (api.isNotFound(error)) update((current) => withDecisions(current, NO_DECISIONS));
        else failed('decisions', signal)(error);
      },
    );
    if (previousRunId === null) return;
    server
      .fetchPreviousFindings(signal)
      .then((previous) => update((current) => withPrevious(current, previous)), failed('previous', signal));
  };

  const follow = (signal: AbortSignal) => {
    const onError = (message: string) =>
      update((current) => withError(current, { source: 'events', message }));
    // A dropped stream that opens again is followed again: it no longer says it is reconnecting.
    const onOpen = () => update((current) => withoutError(current, 'events', api.STREAM_RECONNECTING));
    const onEvent = (event: RunEvent) => {
      const wasClosed = isRunClosed(state);
      let next: ReportState;
      try {
        next = reduce(state, event);
      } catch (error) {
        // An event of a known type without its payload: say so, and keep following the run.
        onError(`The run event ${event.seq} (${event.type}) could not be read: ${messageOf(error)}`);
        return;
      }
      update(() => next);
      if (!wasClosed && isRunClosed(state)) loadFindings(signal);
    };
    closeStream = server.subscribe(onEvent, onError, state.lastSeq, onOpen);
  };

  const begin = async (signal: AbortSignal) => {
    let manifest: RunManifest;
    try {
      manifest = await server.fetchManifest(signal);
    } catch (error) {
      if (signal.aborted) return;
      // No manifest: the server has no run to show yet.
      if (api.isNotFound(error)) {
        const missing = { source: 'manifest', message: messageOf(error), isNotFound: true } as const;
        update((current) => withError(current, missing));
        return;
      }
      failed('manifest', signal)(error);
      return;
    }
    if (signal.aborted) return;
    update((current) => withManifest(current, manifest));
    follow(signal);
    if (manifest.status !== 'running') loadFindings(signal);
    loadBeside(signal, manifest.previousRunId);
  };

  const start = () => {
    if (controller !== null) return;
    controller = new AbortController();
    void begin(controller.signal);
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      start();
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    start,
    stop() {
      controller?.abort();
      controller = null;
      closeStream?.();
      closeStream = null;
      // A load stopped half way is asked for again on the next start.
      isFindingsRequested = state.findingsSource === 'file';
    },
    applyDecisions(decisions) {
      update((current) => withDecisions(current, { version: DECISIONS_VERSION, decisions }));
    },
  };
}

/** The page's one store; it starts with the first component that reads it, and lives as long as the page. */
const reportStore = createReportStore();

export function useReport(): ReportState {
  return useSyncExternalStore(reportStore.subscribe, reportStore.getSnapshot, reportStore.getSnapshot);
}

/** The page's store takes the decisions the server answered a decision with; every view shows them. */
export function applyDecisions(decisions: DecisionsFile['decisions']): void {
  reportStore.applyDecisions(decisions);
}
