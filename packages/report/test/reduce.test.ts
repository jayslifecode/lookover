// @vitest-environment node
import type { RunEvent } from '@jayslifecode/lookover-core';
import { expect, test } from 'vitest';
import type { RunManifest } from '../node/api';
import { initialState, type ReportState, reduce, withFindingsFile, withManifest } from '../src/data/reduce';
import { eventOf, eventsOf, fixtureEvents, fixtureFindings, stepFinding, timeOf } from './fixture';

const EVENTS = fixtureEvents();
const BASE_URL = 'http://localhost:3123';

function replay(events: readonly RunEvent[], from: ReportState = initialState()): ReportState {
  return events.reduce(reduce, from);
}

const started = eventOf({ type: 'run.started', baseUrl: BASE_URL, interaction: 'full', viewports: [] }, 1);

test('a candidate, then its judged event, moves the finding to judged with its status', () => {
  const candidate = stepFinding({ id: 'f1', status: 'candidate' });
  const withCandidate = replay([started, eventOf({ type: 'finding.candidate', finding: candidate }, 2)]);
  expect([...withCandidate.candidates.keys()]).toEqual(['f1']);
  expect(withCandidate.judged.size).toBe(0);

  const confirmed = { ...candidate, status: 'confirmed' as const };
  const judged = reduce(withCandidate, eventOf({ type: 'finding.judged', finding: confirmed }, 3));

  expect(judged.candidates.size).toBe(0);
  expect(judged.judged.get('f1')?.status).toBe('confirmed');
  expect(judged.lastSeq).toBe(3);
  // Pure: the state it started from is untouched.
  expect([...withCandidate.candidates.keys()]).toEqual(['f1']);
  expect(withCandidate.judged.size).toBe(0);
  expect(withCandidate.lastSeq).toBe(2);
  // A candidate sent again for a finding already judged does not bring it back.
  const resent = reduce(judged, eventOf({ type: 'finding.candidate', finding: candidate }, 4));
  expect(resent.candidates.size).toBe(0);
});

test('a candidate seen again replaces the one held, by id', () => {
  const first = stepFinding({ id: 'f1', status: 'candidate', title: 'First sight' });
  const merged = { ...first, title: 'Merged with a later screen' };
  const state = replay([
    started,
    eventOf({ type: 'finding.candidate', finding: first }, 2),
    eventOf({ type: 'finding.candidate', finding: merged }, 3),
  ]);
  expect([...state.candidates.values()].map((finding) => finding.title)).toEqual([
    'Merged with a later screen',
  ]);
});

test('run.failed closes the run with its error, and judged events after it are ignored', () => {
  const f1 = stepFinding({ id: 'f1', status: 'candidate' });
  const f2 = stepFinding({ id: 'f2', status: 'candidate' });
  const error = { code: 'E_AUTH_FAILED', message: 'The session was lost and could not log in again' };
  const state = replay([
    started,
    eventOf({ type: 'finding.candidate', finding: f1 }, 2),
    eventOf({ type: 'finding.candidate', finding: f2 }, 3),
    eventOf({ type: 'finding.judged', finding: { ...f1, status: 'confirmed' } }, 4),
    eventOf({ type: 'run.failed', error }, 5),
    // A judge batch that finished after the crawl failed.
    eventOf({ type: 'finding.judged', finding: { ...f2, status: 'confirmed' } }, 6),
  ]);
  expect(state.run).toMatchObject({
    status: 'failed',
    baseUrl: BASE_URL,
    startedAt: timeOf(1),
    finishedAt: timeOf(5),
    error,
  });
  expect([...state.judged.keys()]).toEqual(['f1']);
  expect([...state.candidates.keys()]).toEqual(['f2']);
  expect(state.lastSeq).toBe(6);
});

test('the screens are in the same order whatever order their events arrive in', () => {
  const captured = eventsOf(EVENTS, 'screen.captured');
  const forward = replay(captured);
  const backward = replay([...captured].reverse());
  const twice = replay([...captured, ...captured]);

  expect(forward.screens.map((screen) => screen.id)).toEqual(['4a17c4d0a2', '57682dba9d', '38a8049145']);
  expect(backward.screens).toEqual(forward.screens);
  expect(twice.screens).toEqual(forward.screens);
});

test("screen.inspected folds each screen's skips into the run's tally, once per screen", () => {
  const inspected = (screenId: string, skipped: { reason: string; count: number }[], seq: number) =>
    eventOf(
      {
        type: 'screen.inspected',
        screenId,
        durationMs: 10,
        candidates: 0,
        worthALook: 0,
        skipped,
        error: null,
      },
      seq,
    );
  const first = inspected('a', [{ reason: 'off-screen', count: 2 }], 2);
  const state = replay([
    started,
    first,
    inspected(
      'b',
      [
        { reason: 'text-colour-uncertain', count: 3 },
        { reason: 'off-screen', count: 2 },
      ],
      3,
    ),
    // The same inspection again (a resumed stream) is not counted twice.
    first,
  ]);
  expect(state.skipped).toEqual([
    { reason: 'off-screen', count: 4 },
    { reason: 'text-colour-uncertain', count: 3 },
  ]);
  expect(state.inspections.get('b')?.skipped).toHaveLength(2);
});

test("the fixture's log reduces to the run's findings, counts and judge totals", () => {
  const file = fixtureFindings();
  const state = replay(EVENTS);

  expect(state.run).toMatchObject({
    status: 'finished',
    baseUrl: BASE_URL,
    durationMs: 15504,
    error: null,
    counts: { screens: 3, confirmed: 27, rejected: 0, intended: 1, worthALook: 0 },
  });
  expect(state.screens).toHaveLength(3);
  expect(state.candidates.size).toBe(0);
  const confirmed = [...state.judged.values()].filter((finding) => finding.status === 'confirmed');
  expect(confirmed.map((finding) => finding.id).sort()).toEqual(file.findings.map((f) => f.id).sort());
  expect(state.judged.get('e9839cc1b237')?.status).toBe('intended');
  expect(state.totals).toEqual(file.judge);
  expect(state.skipped).toEqual(file.skipped);
  expect(state.lastSeq).toBe(95);
});

test('a findings file is authoritative: it replaces what the events built, and later finding events are ignored', () => {
  const file = fixtureFindings();
  const early = replay(EVENTS.slice(0, 25));
  expect(early.candidates.size).toBeGreaterThan(0);

  const fromFile = withFindingsFile(early, file);
  const later = replay(EVENTS.slice(25), fromFile);

  const fileIds = [...file.findings, ...file.rejected, ...file.intended].map((finding) => finding.id);
  expect(later.findingsSource).toBe('file');
  expect(later.candidates.size).toBe(0);
  expect([...later.judged.keys()]).toEqual(fileIds);
  expect(later.worthALook).toEqual(file.worthALook);
  expect(later.totals).toEqual(file.judge);
  // Screens and the run's state still come from the events.
  expect(later.screens).toHaveLength(3);
  expect(later.run.status).toBe('finished');
});

test("the manifest's status holds until the events close the run", () => {
  const manifest: RunManifest = {
    runId: 'test-run',
    baseUrl: BASE_URL,
    startedAt: timeOf(1),
    status: 'finished',
    previousRunId: null,
    lookoverVersion: '0.0.0',
  };
  const loaded = withManifest(initialState(), manifest);
  expect(loaded.manifest).toBe(manifest);
  expect(loaded.run).toMatchObject({ status: 'finished', baseUrl: BASE_URL, startedAt: timeOf(1) });

  const failed = replay([started, eventOf({ type: 'run.failed', error: { code: 'E', message: 'm' } }, 2)]);
  expect(withManifest(failed, { ...manifest, status: 'running' }).run.status).toBe('failed');
});

test('an unknown event leaves the state as it was; a known one the report does not show only moves lastSeq', () => {
  const state = replay(EVENTS.slice(0, 3));
  const unknown = { type: 'run.paused', seq: 50, at: timeOf(50), runId: 'test-run' } as unknown as RunEvent;
  expect(reduce(state, unknown)).toBe(state);

  const observed = reduce(
    state,
    eventOf({ type: 'host.observed', host: 'api.example', kind: 'app-call' }, 51),
  );
  expect(observed.lastSeq).toBe(51);
  expect(observed.screens).toBe(state.screens);
  expect(observed.judged).toBe(state.judged);
});
