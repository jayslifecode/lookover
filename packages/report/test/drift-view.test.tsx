import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import type { RunManifest } from '../node/api';
import {
  initialState,
  type ReportState,
  reduce,
  withDecisions,
  withError,
  withFindingsFile,
  withManifest,
  withPrevious,
} from '../src/data/reduce';
import { formatRoute } from '../src/data/route';
import { confirmedFindings, drift } from '../src/data/selectors';
import { DriftView } from '../src/drift/drift-view';
import { eventOf, findingsFile, fixtureEvents, fixturePreviousFindings, stepFinding } from './fixture';
import { INTENDED, KEYBOARD } from './panel-helpers';
import { STATE } from './screens-helpers';

/*
 * The Drift view over the fixture run (`fixtures/run/findings.json`) against the previous run
 * (`fixtures/previous-findings.json`): 3 findings then, 27 confirmed and 1 intended now.
 */

const PREVIOUS = fixturePreviousFindings();
const EVENTS = fixtureEvents();
const HELD = 'Fixed and removed are known when the run finishes.';
const REQUEST_FAILED = 'fc8addc0486b';
const RUN: RunManifest = {
  runId: '20261022-212802-kwtz',
  baseUrl: 'http://localhost:3123',
  startedAt: '2026-10-22T12:28:02.000Z',
  status: 'finished',
  previousRunId: PREVIOUS.runId,
  lookoverVersion: '0.0.0',
};

afterEach(() => {
  cleanup();
});

function compared(previous = PREVIOUS, manifest: Partial<RunManifest> = {}): ReportState {
  return withPrevious(withManifest(STATE, { ...RUN, ...manifest }), previous);
}

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

function hrefs(root: HTMLElement): (string | null)[] {
  return within(root)
    .queryAllByRole('link')
    .map((link) => link.getAttribute('href'));
}

test('New, Fixed and Still there, from this run against the previous one, each a link to the finding', () => {
  render(<DriftView report={compared()} />);

  expect(screen.getByRole('heading', { level: 1, name: 'Drift' })).toBeDefined();
  expect(screen.getByText(`Since the run ${PREVIOUS.runId}: 25 new · 0 fixed · 2 still there`)).toBeDefined();
  const added = hrefs(region('New'));
  expect(added).toHaveLength(25);
  expect(added).not.toContain(formatRoute({ view: 'findings', findingId: KEYBOARD }));
  expect(hrefs(region('Still there')).toSorted()).toEqual(
    [REQUEST_FAILED, KEYBOARD].map((id) => formatRoute({ view: 'findings', findingId: id })).toSorted(),
  );
  expect(within(region('Fixed')).getByText('Nothing was fixed since the last run.')).toBeDefined();
  // The most severe first.
  const [first] = within(region('New')).getAllByRole('link');
  expect(first?.textContent).toMatch(/^High/);
});

test('a finding marked intended since the last run is listed under Intended, never as fixed', () => {
  render(<DriftView report={compared()} />);

  expect(hrefs(region('Intended'))).toEqual([formatRoute({ view: 'findings', findingId: INTENDED })]);
  expect(hrefs(region('Fixed'))).toEqual([]);
});

test('a finding of the last run that is gone now is fixed; one this run does not hold is not a link', () => {
  const gone = stepFinding({ id: 'gone', title: 'An old problem', severity: 'medium' });
  render(<DriftView report={compared({ ...PREVIOUS, findings: [...PREVIOUS.findings, gone] })} />);

  const fixed = region('Fixed');
  expect(within(fixed).getByText('An old problem')).toBeDefined();
  expect(within(fixed).getByText('not in this run')).toBeDefined();
  expect(hrefs(fixed)).toEqual([]);
  expect(screen.getByText(`Since the run ${PREVIOUS.runId}: 25 new · 1 fixed · 2 still there`)).toBeDefined();
});

test("the screens by route: added and removed, from the routes the last run's findings name, and said so", () => {
  const elsewhere = stepFinding({ id: 'elsewhere', title: 'On a page gone since' });
  const removed = { ...elsewhere, trace: { ...elsewhere.trace, route: '/settings' } };
  render(<DriftView report={compared({ ...PREVIOUS, rejected: [removed] })} />);

  const routes = region('Screens by route');
  expect(within(within(routes).getByRole('list', { name: 'Added' })).getAllByRole('listitem')).toHaveLength(
    2,
  );
  expect(within(routes).getByRole('list', { name: 'Added' }).textContent).toBe('/login/organisations');
  expect(within(routes).getByRole('list', { name: 'Removed' }).textContent).toBe('/settings');
  expect(within(routes).getByText(/the routes the previous run's findings name/)).toBeDefined();
});

test('a first run says there is nothing to compare it with, and how to get a comparison', () => {
  render(<DriftView report={withManifest(STATE, { ...RUN, previousRunId: null })} />);

  expect(screen.getByText(/This is the first run, so there is nothing to compare it with yet/)).toBeDefined();
  expect(screen.getByText('lookover run', { selector: 'code' })).toBeDefined();
  expect(screen.queryByRole('region', { name: 'New' })).toBeNull();
});

test('while the previous run loads it says so; one that cannot be loaded says why', () => {
  const loading = withManifest(STATE, RUN);
  const { rerender } = render(<DriftView report={loading} />);
  expect(screen.getByText("Loading the previous run's findings…")).toBeDefined();

  rerender(
    <DriftView
      report={withError(loading, { source: 'previous', message: 'The report server answered 500' })}
    />,
  );
  expect(screen.getByRole('alert').textContent).toContain('The report server answered 500');
});

test('while the run is still going, the comparison says it is of what is confirmed so far', () => {
  const report = compared();
  render(<DriftView report={{ ...report, run: { ...report.run, status: 'running' } }} />);

  expect(screen.getByText('The run is still going: this compares what is confirmed so far.')).toBeDefined();
});

/** The fixture run as it stands once its events up to `seq` are in, against the previous run. */
function liveAt(seq: number): ReportState {
  const running = withManifest(initialState(), { ...RUN, status: 'running' });
  const state = EVENTS.filter((event) => event.seq <= seq).reduce(reduce, running);
  return withPrevious(state, PREVIOUS);
}

test('while the run is going, Fixed and Removed are held; New and Still there come from what is judged so far', () => {
  // seq 21: the dashboard's three candidates (the previous run's three findings) are still being reproduced.
  const early = liveAt(21);
  expect(drift(early)?.fixed).toBeNull();
  expect(drift(early)?.removedRoutes).toBeNull();
  const { rerender } = render(<DriftView report={early} />);
  expect(within(region('Fixed')).getByText(HELD)).toBeDefined();
  expect(hrefs(region('Fixed'))).toEqual([]);
  expect(within(region('Screens by route')).queryByRole('list', { name: 'Removed' })).toBeNull();
  expect(within(region('Screens by route')).getByText(HELD)).toBeDefined();
  expect(screen.getByText(`Since the run ${PREVIOUS.runId}, so far: 0 new · 0 still there`)).toBeDefined();

  // seq 30: the keyboard finding is confirmed again, the intended one decided: still nothing is fixed.
  rerender(<DriftView report={liveAt(30)} />);
  expect(hrefs(region('Still there'))).toEqual([formatRoute({ view: 'findings', findingId: KEYBOARD })]);
  expect(hrefs(region('Intended'))).toEqual([formatRoute({ view: 'findings', findingId: INTENDED })]);
  expect(within(region('Fixed')).getByText(HELD)).toBeDefined();
});

test('once the run is over, what is still a candidate or decided intended is never fixed', () => {
  // A run that failed while the dashboard's three were still candidates.
  const failed = reduce(
    liveAt(21),
    eventOf({ type: 'run.failed', error: { code: 'E_RUN_FAILED', message: 'Stopped' } }, 22),
  );
  expect(drift(failed)?.fixed).toEqual([]);

  // A finished run that never met the intended finding again: the decisions still say it is intended.
  const unmet = withFindingsFile(STATE, findingsFile({ findings: confirmedFindings(STATE) }));
  const decided = withDecisions(unmet, {
    version: 1,
    decisions: { [INTENDED]: { status: 'intended', at: '2026-10-22T12:28:02.508Z', note: null } },
  });
  expect(drift(withPrevious(decided, PREVIOUS))?.fixed).toEqual([]);
  expect(drift(withPrevious(unmet, PREVIOUS))?.fixed?.map(({ id }) => id)).toEqual([INTENDED]);
});
