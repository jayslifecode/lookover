import type { RunEvent } from '@jayslifecode/lookover-core';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { API_PATHS, type RunManifest } from '../node/api';
import { initialState, type ReportState, reduce, withManifest } from '../src/data/reduce';
import { FindingsView } from '../src/findings/findings-view';
import { ScreenList } from '../src/screens/screen-list';
import { LiveIndicator, liveStatusOf } from '../src/shell/live-indicator';
import { FakeEventSource } from './event-source';
import { eventOf, fixtureEvents } from './fixture';
import { stubServer } from './panel-helpers';
import {
  DASHBOARD,
  LOGIN,
  loadScreenshot,
  ORGANISATIONS,
  pinNames,
  show,
  stubEvidenceFetch,
  stubImageSizes,
} from './screens-helpers';

/*
 * The live states, from the fixture run's own event sequence folded through `reduce` one event at a time:
 * the screen list fills, each screen is `inspecting…` until it is inspected, candidates are
 * `reproducing…` (never findings) until they are judged, and the indicator follows the phases. Then the
 * whole page over a stream: a dropped stream says it is reconnecting, a failed run shows its error.
 *
 * The fixture's log: run.started (1), the dashboard captured (18), three candidates (19–21), inspected
 * (22), one judged (23); the login page captured (26) and inspected (27); the organisations captured
 * (29), one judged (30), 25 candidates (31–55), inspected (56), 26 judged (69–94), run.finished (95).
 */

const EVENTS = fixtureEvents();
const RUNNING: RunManifest = {
  runId: '20261022-212802-kwtz',
  baseUrl: 'http://localhost:3123',
  startedAt: '2026-10-22T12:28:02.000Z',
  status: 'running',
  previousRunId: null,
  lookoverVersion: '0.0.0',
};
const FAILURE = {
  code: 'E_AUTH_FAILED',
  message: 'Lost the session at http://localhost:3123/organisations: it still lands on the login page',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

/** The run as the report holds it once the events up to `seq` have arrived. */
function upTo(seq: number): ReportState {
  return EVENTS.filter((event) => event.seq <= seq).reduce(reduce, withManifest(initialState(), RUNNING));
}

function failedAfter(seq: number): ReportState {
  return reduce(upTo(seq), eventOf({ type: 'run.failed', error: FAILURE }, seq + 1));
}

function screenLinks(): HTMLElement[] {
  return within(screen.getByRole('navigation', { name: 'Screens' })).queryAllByRole('link');
}

function inspecting(): (string | null)[] {
  return screenLinks()
    .filter((link) => link.textContent?.includes('inspecting…'))
    .map((link) => link.getAttribute('href'));
}

const linkTo = (screenId: string) => `#/screens/${screenId}`;

test('the screen list fills as screens are captured, and each is inspecting… until it is inspected', () => {
  const { rerender } = render(<ScreenList report={upTo(17)} currentId={null} />);
  expect(screenLinks()).toEqual([]);

  rerender(<ScreenList report={upTo(18)} currentId={null} />);
  expect(screenLinks()).toHaveLength(1);
  expect(inspecting()).toEqual([linkTo(DASHBOARD)]);

  rerender(<ScreenList report={upTo(22)} currentId={null} />);
  expect(inspecting()).toEqual([]);

  rerender(<ScreenList report={upTo(26)} currentId={null} />);
  expect(inspecting()).toEqual([linkTo(LOGIN)]);

  rerender(<ScreenList report={upTo(29)} currentId={null} />);
  expect(screenLinks()).toHaveLength(3);
  expect(inspecting()).toEqual([linkTo(ORGANISATIONS)]);

  rerender(<ScreenList report={upTo(56)} currentId={null} />);
  expect(inspecting()).toEqual([]);

  // A run that failed before a screen was inspected is not inspecting it any more.
  rerender(<ScreenList report={failedAfter(18)} currentId={null} />);
  expect(inspecting()).toEqual([]);
});

function reproducingTitles(root: HTMLElement): string[] {
  const section = within(root).queryByRole('list', { name: 'Being reproduced' });
  if (section === null) return [];
  return within(section)
    .getAllByRole('listitem')
    .map((item) => item.textContent ?? '');
}

test('candidates are reproducing… under their own heading, never findings, until they are judged', () => {
  const { rerender } = render(<FindingsView report={upTo(21)} findingId={null} />);
  const page = document.body;

  expect(reproducingTitles(page)).toHaveLength(3);
  expect(reproducingTitles(page).every((text) => text.includes('reproducing…'))).toBe(true);
  expect(screen.queryByRole('list', { name: 'Fix first' })).toBeNull();
  expect(screen.getByText('No finding has been confirmed yet.')).toBeDefined();
  // Not links: a candidate is not a finding to open.
  expect(within(screen.getByRole('list', { name: 'Being reproduced' })).queryAllByRole('link')).toEqual([]);

  // e9839cc1b237 was decided intended (23), da77d007d373 confirmed (30).
  rerender(<FindingsView report={upTo(30)} findingId={null} />);
  expect(reproducingTitles(page)).toEqual([expect.stringContaining('A request the page made failed')]);
  expect(within(screen.getByRole('list', { name: 'Fix first' })).getAllByRole('button')).toHaveLength(1);
  expect(screen.getByText('1 confirmed · 1 intended · 0 rejected by the judge')).toBeDefined();

  rerender(<FindingsView report={upTo(94)} findingId={null} />);
  expect(screen.queryByRole('list', { name: 'Being reproduced' })).toBeNull();
  expect(screen.getByText('27 confirmed · 1 intended · 0 rejected by the judge')).toBeDefined();
});

test("a screen's scorecard lists its candidates as reproducing…, and none once the run is over", () => {
  stubImageSizes();
  stubEvidenceFetch();
  const { rerender } = render(show(DASHBOARD, null, upTo(21)));
  const card = () => screen.getByRole('region', { name: 'Scorecard' });

  expect(reproducingTitles(card())).toHaveLength(3);
  expect(within(card()).getByText('High', { selector: 'dt' }).nextElementSibling?.textContent).toBe('0');
  loadScreenshot();
  expect(pinNames()).toEqual([]);

  rerender(show(DASHBOARD, null, failedAfter(21)));
  expect(reproducingTitles(card())).toEqual([]);
});

test('the indicator: mapping, inspecting from the first screen, judging from the first candidate, then done or failed', () => {
  const phases = [
    [withManifest(initialState(), RUNNING), 'Mapping'],
    [upTo(1), 'Mapping'],
    [upTo(17), 'Mapping'],
    [upTo(18), 'Inspecting'],
    [upTo(19), 'Judging'],
    [upTo(29), 'Judging'],
    [upTo(95), 'Done'],
    [failedAfter(30), 'Failed'],
  ] as const;
  for (const [state, label] of phases) {
    const { container, unmount } = render(<LiveIndicator status={liveStatusOf(state)} />);
    expect(screen.getByRole('status').textContent).toBe(`Run status: ${label}`);
    // Only a run still going pulses.
    const isPulsing = container.querySelector('.animate-ping') !== null;
    expect(isPulsing).toBe(label !== 'Done' && label !== 'Failed');
    unmount();
  }
});

/** The fixture run up to `seq` as a `--no-judge` run: its judge.unavailable says the judge is off. */
function judgeOffUpTo(seq: number): ReportState {
  const turnedOff = (event: RunEvent): RunEvent =>
    event.type === 'judge.unavailable'
      ? { ...event, reason: 'disabled', message: 'The judge was turned off with --no-judge' }
      : event;
  return EVENTS.filter((event) => event.seq <= seq)
    .map(turnedOff)
    .reduce(reduce, withManifest(initialState(), RUNNING));
}

test('with the judge turned off, candidates are listed as such, never reproducing…, and the run is never Judging', () => {
  const { rerender } = render(<FindingsView report={judgeOffUpTo(21)} findingId={null} />);

  const candidates = screen.getByRole('list', { name: 'Candidates (judge off)' });
  expect(within(candidates).getAllByRole('listitem')).toHaveLength(3);
  expect(candidates.textContent).not.toContain('reproducing…');
  expect(screen.queryByRole('list', { name: 'Being reproduced' })).toBeNull();
  expect(liveStatusOf(judgeOffUpTo(21))).toBe('inspecting');
  expect(liveStatusOf(judgeOffUpTo(56))).toBe('inspecting');

  // Nothing will judge them: they stay listed once the run is over.
  const finished = reduce(
    judgeOffUpTo(56),
    eventOf(
      {
        type: 'run.finished',
        screens: 3,
        durationMs: 1000,
        confirmed: 0,
        rejected: 0,
        intended: 1,
        worthALook: 0,
        judge: null,
      },
      57,
    ),
  );
  rerender(<FindingsView report={finished} findingId={null} />);
  expect(screen.getByRole('list', { name: 'Candidates (judge off)' })).toBeDefined();
  expect(liveStatusOf(finished)).toBe('done');
});

function send(source: FakeEventSource, events: readonly RunEvent[]): void {
  act(() => {
    for (const event of events) source.send(event);
  });
}

/** The live indicator: an `<output>`, which takes no name from its content. */
function indicator(): HTMLElement {
  const found = screen
    .getAllByRole('status')
    .find((element) => element.textContent?.startsWith('Run status'));
  if (found === undefined) throw new Error('No live indicator');
  return found;
}

/** The whole page over the stream: one test, as the page's store lives as long as the module. */
describe('the page over the event stream', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
    stubServer({
      [API_PATHS.run]: RUNNING,
      [`${API_PATHS.files}decisions.json`]: { version: 1, decisions: {} },
    });
  });

  test("reconnecting… while the stream is dropped, the phases, and a failed run's error at the top", async () => {
    window.history.replaceState(null, '', '/#/findings');
    const { App } = await import('../src/app');
    render(<App />);
    await waitFor(() => expect(FakeEventSource.latest).not.toBeNull());
    const source = FakeEventSource.latest as FakeEventSource;
    act(() => source.open());
    const status = indicator;

    send(
      source,
      EVENTS.filter((event) => event.seq <= 1),
    );
    expect(status().textContent).toContain('Mapping');

    act(() => source.drop());
    expect(within(status()).getByText('reconnecting…')).toBeDefined();
    expect(status().textContent).toBe('Run status: Mapping reconnecting…');
    act(() => source.open());
    expect(within(status()).queryByText('reconnecting…')).toBeNull();

    send(
      source,
      EVENTS.filter((event) => event.seq > 1 && event.seq <= 30),
    );
    expect(status().textContent).toContain('Judging');

    send(source, [eventOf({ type: 'run.failed', error: FAILURE }, 31)]);
    expect(status().textContent).toContain('Failed');
    const main = screen.getByRole('main');
    const notice = within(main).getByRole('alert');
    expect(main.firstElementChild).toBe(notice);
    expect(notice.textContent).toContain('The run failed');
    expect(notice.textContent).toContain(FAILURE.message);
    expect(notice.textContent).toContain('E_AUTH_FAILED');
    expect(within(notice).getByText(/Check the login settings and credentials in/)).toBeDefined();
    // What the run reached before it failed is still there to read.
    expect(screen.getByText('1 confirmed · 1 intended · 0 rejected by the judge')).toBeDefined();
  });
});
