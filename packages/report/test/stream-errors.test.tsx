import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { API_PATHS, type RunManifest } from '../node/api';
import { LiveIndicator } from '../src/shell/live-indicator';
import { FakeEventSource } from './event-source';
import { fixtureEvents } from './fixture';
import { stubServer } from './panel-helpers';

/*
 * What the event stream says beyond reconnecting is shown, not kept quiet: a message that is not an
 * event, or a stream the server closed for good, is a solid notice under the top bar; and a run the page
 * no longer follows stops pulsing as if it were live.
 */

const [RUN_STARTED] = fixtureEvents();
const RUNNING: RunManifest = {
  runId: '20261022-212802-kwtz',
  baseUrl: 'http://localhost:3123',
  startedAt: '2026-10-22T12:28:02.000Z',
  status: 'running',
  previousRunId: null,
  lookoverVersion: '0.0.0',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

function isPulsing(): boolean {
  return document.querySelector('header .animate-ping') !== null;
}

test('a stream error other than reconnecting is a notice under the top bar; a closed stream stops the pulse', async () => {
  vi.stubGlobal('EventSource', FakeEventSource);
  stubServer({
    [API_PATHS.run]: RUNNING,
    [`${API_PATHS.files}decisions.json`]: { version: 1, decisions: {} },
  });
  window.history.replaceState(null, '', '/#/findings');
  const { App } = await import('../src/app');
  render(<App />);
  await waitFor(() => expect(FakeEventSource.latest).not.toBeNull());
  const source = FakeEventSource.latest as FakeEventSource;
  act(() => {
    source.open();
    source.send(RUN_STARTED);
  });
  expect(isPulsing()).toBe(true);
  const main = screen.getByRole('main');

  act(() => source.send('not json'));
  const notice = within(main).getByText('The event stream sent a message that is not a run event');
  expect(notice.closest('[role="status"]')).not.toBeNull();
  expect(main.firstElementChild?.contains(notice)).toBe(true);
  expect(isPulsing()).toBe(true);

  act(() => {
    source.readyState = FakeEventSource.CLOSED;
    source.onerror?.();
  });
  expect(within(main).getByText(/closed by the report server; reload the page/)).toBeDefined();
  expect(isPulsing()).toBe(false);
  // Still where the run was: the page just no longer follows it live.
  expect(document.querySelector('header[data-glass] output')?.textContent).toBe('Run status: Mapping');
});

test('the indicator pulses only while the page follows a run that is going', () => {
  const { container, rerender } = render(<LiveIndicator status="judging" />);
  expect(container.querySelector('.animate-ping')).not.toBeNull();

  rerender(<LiveIndicator status="judging" isFollowing={false} />);
  expect(container.querySelector('.animate-ping')).toBeNull();
});
