import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { reduce, withFindingsFile } from '../src/data/reduce';
import { FindingsView } from '../src/findings/findings-view';
import { eventOf, findingsFile, occurrenceFinding, stepFinding } from './fixture';
import { stubServer } from './panel-helpers';
import { LOGIN, STATE, show, stubEvidenceFetch, stubImageSizes } from './screens-helpers';

/* What the report says where there is nothing to show: each state says what to do next. */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

/** The fixture run as if nothing had been confirmed: two worth-a-look entries and one rejected finding. */
const NOTHING_CONFIRMED = withFindingsFile(
  STATE,
  findingsFile({
    worthALook: [
      stepFinding({ id: 'w1', title: 'Hover changes nothing', status: 'candidate', severity: 'low' }),
      occurrenceFinding({ id: 'w2', title: 'A console warning', status: 'candidate', screens: [LOGIN] }),
    ],
    rejected: [stepFinding({ id: 'r1', status: 'rejected' })],
  }),
);

test('a finished run with nothing confirmed: the run in numbers, a sentence, and the Worth a look switch pointed out', () => {
  stubServer();
  render(<FindingsView report={NOTHING_CONFIRMED} findingId={null} />);

  const card = screen.getByRole('region', { name: 'Run scorecard' });
  const value = (term: string) =>
    within(card).getByText(term, { selector: 'dt' }).nextElementSibling?.textContent;
  expect(value('High')).toBe('0');
  expect(value('Worth a look')).toBe('2');
  expect(value('Rejected')).toBe('1');
  expect(screen.getByText(/Nothing was confirmed in this run/)).toBeDefined();
  expect(screen.queryByRole('region', { name: 'Worth a look' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Show the 2 worth-a-look entries' }));

  expect(screen.getByRole('switch', { name: 'Worth a look' }).getAttribute('aria-checked')).toBe('true');
  expect(within(screen.getByRole('region', { name: 'Worth a look' })).getAllByRole('link')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: /^Show the 2/ })).toBeNull();
});

test('a finished run with the judge turned off says so and how to turn it on, and lists its candidates', () => {
  stubServer();
  const unjudged = withFindingsFile(STATE, {
    ...findingsFile({ findings: [stepFinding({ id: 'c1', title: 'A candidate', status: 'candidate' })] }),
    judge: null,
  });
  const off = eventOf(
    { type: 'judge.unavailable', reason: 'disabled', message: 'The judge was turned off with --no-judge' },
    STATE.lastSeq + 1,
  );
  render(<FindingsView report={reduce(unjudged, off)} findingId={null} />);

  expect(screen.getByText(/^The judge was turned off for this run/)).toBeDefined();
  expect(screen.getByText(/without --no-judge to reproduce and judge the candidates/)).toBeDefined();
  expect(screen.queryByText(/reproduced every time/)).toBeNull();
  const candidates = screen.getByRole('list', { name: 'Candidates (judge off)' });
  expect(
    within(candidates)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual([expect.stringContaining('A candidate')]);
});

test('a screen with no confirmed finding says so under its screenshot', () => {
  stubImageSizes();
  stubEvidenceFetch();
  render(show(LOGIN));

  expect(screen.getByText('Nothing confirmed on this screen')).toBeDefined();
});

test('filters that match nothing say so, with a button that clears them', () => {
  stubServer();
  render(<FindingsView report={STATE} findingId={null} />);
  const search = screen.getByRole('searchbox', { name: 'Search findings' });
  fireEvent.click(
    within(screen.getByRole('group', { name: 'Severity' })).getByRole('button', { name: 'Low' }),
  );
  fireEvent.change(search, { target: { value: 'nothing like this' } });

  expect(screen.getByText('No findings match these filters')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

  expect((search as HTMLInputElement).value).toBe('');
  expect(
    within(screen.getByRole('group', { name: 'Severity' }))
      .getByRole('button', { name: 'Low' })
      .getAttribute('aria-pressed'),
  ).toBe('false');
  expect(within(screen.getByRole('list', { name: 'Fix first' })).getAllByRole('button')).toHaveLength(5);
});

test('with no run yet, the page says how to make one', async () => {
  stubServer();
  const { App } = await import('../src/app');
  render(<App />);

  const empty = await screen.findByText(/^No run yet\./);
  expect(within(empty).getByText('lookover run', { selector: 'code' })).toBeDefined();
  expect(screen.queryByRole('alert')).toBeNull();
});
