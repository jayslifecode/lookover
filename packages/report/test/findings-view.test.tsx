import type { Finding, Severity } from '@jayslifecode/lookover-core';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { API_PATHS, type RunManifest } from '../node/api';
import { initialState, type ReportState, withDecisions, withFindingsFile } from '../src/data/reduce';
import { formatRoute } from '../src/data/route';
import { confirmedFindings, fixFirst, groups } from '../src/data/selectors';
import { useReport } from '../src/data/store';
import { FindingsView } from '../src/findings/findings-view';
import { findingsFile, fixtureFindings, occurrenceFinding, stepFinding } from './fixture';
import { fixtureFinding, INTENDED, KEYBOARD, panelFor, stubServer } from './panel-helpers';
import { STATE } from './screens-helpers';

/* The Findings view over the fixture run: fix-first groups, the filters, the search and worth a look. */

const WORTH_A_LOOK_KEY = 'lookover.worthALook';
const PERF_BOUND_MS = 200;

beforeEach(() => {
  stubServer();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function show(report: ReportState = STATE, findingId: string | null = null) {
  return <FindingsView report={report} findingId={findingId} />;
}

/** The group buttons, in the order shown. */
function groupButtons(): HTMLElement[] {
  const list = screen.queryByRole('list', { name: 'Fix first' });
  if (list === null) return [];
  return within(list)
    .getAllByRole('button')
    .filter((button) => button.hasAttribute('aria-expanded'));
}

function pressed(group: string, name: string): HTMLElement {
  return within(screen.getByRole('group', { name: group })).getByRole('button', { name });
}

test('the confirmed findings in fix-first groups, each with its severity, title, what it is about and the screens it is on', () => {
  render(show());

  expect(screen.getByRole('heading', { level: 1, name: 'Findings' })).toBeDefined();
  const expected = fixFirst(groups(confirmedFindings(STATE)));
  expect(expected).toHaveLength(5);
  const buttons = groupButtons();
  expect(buttons).toHaveLength(expected.length);
  buttons.forEach((button, index) => {
    const group = expected[index];
    expect(button.textContent).toContain(group?.lead.title);
    expect(button.textContent).toContain(`${group?.label} · 1 screen`);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });
  expect(buttons[0]?.textContent).toMatch(/^High/);
  expect(buttons.at(-1)?.textContent).toMatch(/^Medium.*12 findings$/);
});

test('a group expands to its findings, each a link to the finding with its element and route', () => {
  render(show());
  const keyboard = groupButtons().find((button) => button.textContent?.includes('keyboard'));
  if (keyboard === undefined) throw new Error('No keyboard group');

  fireEvent.click(keyboard);

  expect(keyboard.getAttribute('aria-expanded')).toBe('true');
  const members = document.getElementById(keyboard.getAttribute('aria-controls') ?? '');
  const links = within(members as HTMLElement).getAllByRole('link');
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    formatRoute({ view: 'findings', findingId: KEYBOARD }),
  ]);
  expect(links[0]?.textContent).toBe('button "Organisations 12"/');

  fireEvent.click(keyboard);
  expect(keyboard.getAttribute('aria-expanded')).toBe('false');
});

test('the selected finding is shown in the panel beside the list, its group open and its link marked', () => {
  render(show(STATE, KEYBOARD));

  const panel = panelFor('Control cannot be reached with the keyboard');
  expect(within(panel).getByRole('button', { name: 'Copy fix prompt' })).toBeDefined();
  const link = screen.getByRole('link', { current: true });
  expect(link.getAttribute('href')).toBe(formatRoute({ view: 'findings', findingId: KEYBOARD }));

  // With nothing selected, the panel shows the run's summary.
  cleanup();
  render(show());
  expect(screen.getByRole('complementary', { name: 'Run summary' })).toBeDefined();
});

test('the count line: confirmed, intended and rejected, with why the rejected are not shown', async () => {
  render(show());

  expect(screen.getByText('27 confirmed · 1 intended · 0 rejected by the judge')).toBeDefined();
  fireEvent.focus(screen.getByRole('button', { name: 'Why rejected findings are not shown' }));
  expect(await screen.findByText(/^Rejected by the judge: measured but not reproduced/)).toBeDefined();
});

test('the filters narrow the groups: by severity, by lens and by status', () => {
  render(show());

  fireEvent.click(pressed('Severity', 'Medium'));
  expect(pressed('Severity', 'Medium').getAttribute('aria-pressed')).toBe('true');
  expect(groupButtons().map((button) => button.textContent)).toEqual([
    expect.stringMatching(/^Medium/),
    expect.stringMatching(/^Medium/),
  ]);
  fireEvent.click(pressed('Severity', 'High'));
  expect(groupButtons()).toHaveLength(5);
  fireEvent.click(pressed('Severity', 'Medium'));
  expect(groupButtons().every((button) => button.textContent?.startsWith('High'))).toBe(true);
  expect(groupButtons()).toHaveLength(3);
  fireEvent.click(pressed('Severity', 'High'));

  fireEvent.click(pressed('Lens', 'Observers'));
  expect(groupButtons().map((button) => button.textContent)).toEqual([
    expect.stringContaining('A request the page made failed on the server'),
  ]);
  fireEvent.click(pressed('Lens', 'Observers'));
  fireEvent.click(pressed('Lens', 'Interaction'));
  expect(groupButtons()).toHaveLength(4);
  fireEvent.click(pressed('Lens', 'Interaction'));

  fireEvent.click(pressed('Status', 'Intended'));
  expect(pressed('Status', 'Intended').getAttribute('aria-pressed')).toBe('true');
  expect(pressed('Status', 'Confirmed').getAttribute('aria-pressed')).toBe('false');
  const [intended] = groupButtons();
  expect(groupButtons()).toHaveLength(1);
  fireEvent.click(intended as HTMLElement);
  expect(screen.getByRole('link', { name: /Latest registration 2025-04-08/ }).getAttribute('href')).toBe(
    formatRoute({ view: 'findings', findingId: INTENDED }),
  );
});

test('a finding the user marks intended moves from Confirmed to Intended', () => {
  const decided = withDecisions(STATE, {
    version: 1,
    decisions: {
      [INTENDED]: { status: 'intended', at: '2026-10-22T12:28:02.508Z', note: null },
      [KEYBOARD]: { status: 'intended', at: '2026-10-22T13:00:00.000Z', note: 'On purpose' },
    },
  });
  render(show(decided));

  expect(screen.getByText('26 confirmed · 2 intended · 0 rejected by the judge')).toBeDefined();
  expect(groupButtons().some((button) => button.textContent?.includes('keyboard'))).toBe(false);
  fireEvent.click(pressed('Status', 'Intended'));
  const [group] = groupButtons();
  expect(group?.textContent).toMatch(/keyboard.*2 findings$/);
});

test('the search matches the title, the route and the selector', () => {
  render(show());
  const search = screen.getByRole('searchbox', { name: 'Search findings' });

  fireEvent.change(search, { target: { value: 'juniper' } });
  expect(groupButtons().map((button) => button.textContent)).toEqual([
    expect.stringMatching(/1 finding$/),
    expect.stringMatching(/1 finding$/),
  ]);

  fireEvent.change(search, { target: { value: 'SCROLLS SIDEWAYS' } });
  expect(groupButtons().map((button) => button.textContent)).toEqual([
    expect.stringContaining('The page scrolls sideways at this screen size'),
  ]);

  fireEvent.change(search, { target: { value: '/organisations' } });
  expect(groupButtons()).toHaveLength(3);

  fireEvent.change(search, { target: { value: 'nothing like this' } });
  expect(groupButtons()).toEqual([]);
  expect(screen.getByText('No finding matches these filters.')).toBeDefined();
});

test('the worth-a-look switch lists the lower-confidence entries in a section of their own, and is remembered', () => {
  const worth = [
    stepFinding({ id: 'w1', title: 'Hover changes nothing', status: 'candidate', severity: 'low' }),
    occurrenceFinding({ id: 'w2', title: 'A console warning', status: 'candidate', screens: ['4a17c4d0a2'] }),
  ];
  const report = withFindingsFile(STATE, {
    ...findingsFile({
      findings: confirmedFindings(STATE),
      intended: [fixtureFinding(INTENDED)],
    }),
    worthALook: worth,
  });
  render(show(report));
  const toggle = screen.getByRole('switch', { name: 'Worth a look' });
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(screen.queryByRole('region', { name: 'Worth a look' })).toBeNull();

  fireEvent.click(toggle);

  const section = screen.getByRole('region', { name: 'Worth a look' });
  const links = within(section).getAllByRole('link');
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    formatRoute({ view: 'findings', findingId: 'w1' }),
    formatRoute({ view: 'findings', findingId: 'w2' }),
  ]);
  expect(links.map((link) => link.textContent)).toEqual([
    expect.stringContaining('Hover changes nothing'),
    expect.stringContaining('A console warning'),
  ]);
  // Never mixed with the findings.
  expect(
    within(screen.getByRole('list', { name: 'Fix first' })).queryByText('Hover changes nothing'),
  ).toBeNull();
  expect(window.localStorage.getItem(WORTH_A_LOOK_KEY)).toBe('true');

  cleanup();
  render(show(report));
  expect(screen.getByRole('switch', { name: 'Worth a look' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('region', { name: 'Worth a look' })).toBeDefined();
});

test('a switch whose storage is blocked still works for the page', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('Blocked', 'SecurityError');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Blocked', 'SecurityError');
  });
  render(show());
  const toggle = screen.getByRole('switch', { name: 'Worth a look' });

  fireEvent.click(toggle);

  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(screen.getByText('Nothing was set aside as worth a look.')).toBeDefined();
});

const RUN: RunManifest = {
  runId: 'test-run',
  baseUrl: 'http://localhost:3123',
  startedAt: '2026-10-22T10:00:00.000Z',
  status: 'finished',
  previousRunId: null,
  lookoverVersion: '0.0.0',
};
const KEPT = { status: 'intended', at: '2026-10-22T12:28:02.508Z', note: null } as const;

/** The Findings view over the page's own store, which loads the run from the stubbed server. */
function Live({ findingId }: { readonly findingId: string | null }) {
  const report = useReport();
  if (report.findingsSource !== 'file' || report.decisions === null) return <p>Loading the run</p>;
  return (
    <>
      <p data-testid="decided">{Object.keys(report.decisions.decisions).join(' ')}</p>
      <FindingsView report={report} findingId={findingId} />
    </>
  );
}

test("a mark the server accepts goes into the page's store, and the finding moves to Intended", async () => {
  const server = stubServer({
    [API_PATHS.run]: RUN,
    [`${API_PATHS.files}findings.json`]: fixtureFindings(),
    [`${API_PATHS.files}decisions.json`]: { version: 1, decisions: { [INTENDED]: KEPT } },
  });
  render(<Live findingId={KEYBOARD} />);
  expect(await screen.findByText('27 confirmed · 1 intended · 0 rejected by the judge')).toBeDefined();

  fireEvent.click(
    within(panelFor('Control cannot be reached with the keyboard')).getByRole('button', {
      name: 'Mark intended',
    }),
  );
  const [mark] = server.posts(API_PATHS.decisions);
  const decision = { status: 'intended', at: '2026-10-22T13:00:00.000Z', note: null };
  await act(async () => mark?.answer(200, { decisions: { [INTENDED]: KEPT, [KEYBOARD]: decision } }));

  expect(await screen.findByText('26 confirmed · 2 intended · 0 rejected by the judge')).toBeDefined();
  expect(screen.getByTestId('decided').textContent?.split(' ')).toEqual([INTENDED, KEYBOARD]);
  fireEvent.click(pressed('Status', 'Intended'));
  const [group] = groupButtons();
  expect(group?.textContent).toMatch(/keyboard.*2 findings$/);
});

/** One hundred step findings over four signatures, each signature with its own severity. */
function hundredFindings(): Finding[] {
  const severities: readonly Severity[] = ['low', 'high', 'medium', 'blocker'];
  return Array.from({ length: 100 }, (_, index) =>
    stepFinding({
      id: `bulk-${index}`,
      signature: `sig-${index % 4}`,
      severity: severities[index % 4] ?? 'low',
      // Each signature's 25 findings spread over ten screens.
      screenId: `screen-${Math.floor(index / 4) % 10}`,
    }),
  );
}

test('a hundred findings over four signatures make four groups, fix-first, rendered within the time budget', () => {
  const report = withFindingsFile(initialState(), findingsFile({ findings: hundredFindings() }));

  const started = performance.now();
  render(show(report));
  const elapsed = performance.now() - started;

  console.info(`The Findings view rendered 100 findings in ${elapsed.toFixed(1)} ms`);
  const buttons = groupButtons();
  expect(buttons.map((button) => button.textContent?.match(/sig-\d/)?.[0])).toEqual([
    'sig-3',
    'sig-1',
    'sig-2',
    'sig-0',
  ]);
  expect(buttons.every((button) => button.textContent?.endsWith('25 findings'))).toBe(true);
  expect(buttons[0]?.textContent).toContain('sig-3 · 10 screens');
  if (process.env.LOOKOVER_PERF === '1') expect(elapsed).toBeLessThan(PERF_BOUND_MS);
});
