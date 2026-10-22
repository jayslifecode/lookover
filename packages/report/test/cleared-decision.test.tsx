import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { API_PATHS } from '../node/api';
import { withDecisions } from '../src/data/reduce';
import { confirmedFindings, intendedFindings, isDecisionCleared } from '../src/data/selectors';
import { FindingPanel } from '../src/findings/finding-panel';
import { FindingsView } from '../src/findings/findings-view';
import { fixtureFinding, INTENDED, type Server, stubServer } from './panel-helpers';
import { STATE } from './screens-helpers';

/*
 * A finding the findings file lists as intended whose decision is taken back (Undo) is not a finding
 * again until the next run judges it: it stays under Intended, marked as cleared, rather than vanishing
 * from every list.
 */

const CLEARED_MARK = 'decision cleared; judged on the next run';
const TITLE = 'Control cannot be reached with the keyboard';
/** The fixture run once the project's decisions are loaded with the intended finding's taken back. */
const CLEARED = withDecisions(STATE, { version: 1, decisions: {} });
let server: Server;

beforeEach(() => {
  server = stubServer();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('a cleared decision keeps the finding among the intended ones, and never makes it confirmed', () => {
  const finding = fixtureFinding(INTENDED);

  expect(isDecisionCleared(CLEARED, finding)).toBe(true);
  expect(isDecisionCleared(STATE, finding)).toBe(false);
  expect(intendedFindings(CLEARED).map(({ id }) => id)).toEqual([INTENDED]);
  expect(confirmedFindings(CLEARED).map(({ id }) => id)).not.toContain(INTENDED);
});

test('the Findings view lists it under Intended, marked as cleared', () => {
  render(<FindingsView report={CLEARED} findingId={null} />);
  expect(screen.getByText('27 confirmed · 1 intended · 0 rejected by the judge')).toBeDefined();

  fireEvent.click(
    within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: 'Intended' }),
  );
  const [group] = within(screen.getByRole('list', { name: 'Fix first' })).getAllByRole('button');
  fireEvent.click(group as HTMLElement);

  expect(screen.getByRole('link', { name: new RegExp(CLEARED_MARK) })).toBeDefined();
});

test('the panel says the decision was cleared and offers to mark it intended again', () => {
  render(<FindingPanel report={CLEARED} findingId={INTENDED} />);
  const panel = screen.getByRole('complementary', { name: TITLE });

  expect(within(panel).getByText('Decision cleared; judged on the next run.')).toBeDefined();
  expect(within(panel).getByRole('button', { name: 'Mark intended' })).toBeDefined();
  expect(within(panel).queryByText('Marked intended')).toBeNull();
});

test('Undo on an intended finding of the file leaves it shown as cleared, not gone', async () => {
  render(<FindingPanel report={STATE} findingId={INTENDED} />);
  const panel = screen.getByRole('complementary', { name: TITLE });

  fireEvent.click(within(panel).getByRole('button', { name: 'Undo' }));
  const [undo] = server.posts(API_PATHS.decisions);
  expect(undo?.body).toEqual({ findingId: INTENDED, status: null });
  await act(async () => undo?.answer(200, { decisions: {} }));

  expect(within(panel).getByText('Decision cleared; judged on the next run.')).toBeDefined();
});
