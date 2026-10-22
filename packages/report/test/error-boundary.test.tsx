import type { Finding } from '@jayslifecode/lookover-core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { API_PATHS, type RunManifest } from '../node/api';
import { withFindingsFile } from '../src/data/reduce';
import { FindingPanel } from '../src/findings/finding-panel';
import { ErrorBoundary } from '../src/shell/error-boundary';
import { findingsFile, fixtureFindings, stepFinding } from './fixture';
import { KEYBOARD, stubServer } from './panel-helpers';
import { STATE } from './screens-helpers';

/*
 * A part of the page that throws while rendering is replaced by a solid notice with the first line of
 * its error and a Reload button; the rest of the page stays. React reports the error it caught on the
 * console, which these tests silence.
 */

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

function Thrower({ message }: { readonly message: string }): never {
  throw new Error(message);
}

test('a child that throws: a notice with the first line of the error and Reload, and the page around it stays', () => {
  const reload = vi.fn();
  render(
    <>
      <p>The top bar</p>
      <ErrorBoundary label="Screens view" onReload={reload}>
        <Thrower
          message={'Cannot read the screen 4a17c4d0a2\n    at render (/home/someone/secret/view.tsx:12)'}
        />
      </ErrorBoundary>
    </>,
  );

  const notice = screen.getByRole('alert');
  expect(notice.textContent).toContain('The Screens view could not be shown');
  expect(notice.textContent).toContain('Cannot read the screen 4a17c4d0a2');
  expect(notice.textContent).not.toContain('secret');
  expect(screen.getByText('The top bar')).toBeDefined();
  expect(consoleError).toHaveBeenCalled();

  fireEvent.click(within(notice).getByRole('button', { name: 'Reload' }));
  expect(reload).toHaveBeenCalledTimes(1);
});

test('a new reset key tries its children again', () => {
  const { rerender } = render(
    <ErrorBoundary label="finding" resetKey="a">
      <Thrower message="Broken" />
    </ErrorBoundary>,
  );
  expect(screen.getByRole('alert')).toBeDefined();

  rerender(
    <ErrorBoundary label="finding" resetKey="b">
      <p>Fine again</p>
    </ErrorBoundary>,
  );
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('Fine again')).toBeDefined();
});

test('a finding the panel cannot show leaves the panel in place with the notice inside it', () => {
  stubServer();
  const broken = { ...stepFinding({ id: 'broken', title: 'A broken finding' }), evidence: null };
  const report = withFindingsFile(STATE, findingsFile({ findings: [broken as unknown as Finding] }));
  const { rerender } = render(<FindingPanel report={report} findingId="broken" />);

  const panel = screen.getByRole('complementary');
  expect(within(panel).getByRole('alert').textContent).toContain('The finding could not be shown');

  // Another finding is shown again.
  rerender(<FindingPanel report={STATE} findingId={KEYBOARD} />);
  expect(screen.queryByRole('alert')).toBeNull();
});

const RUN: RunManifest = {
  runId: 'test-run',
  baseUrl: 'http://localhost:3123',
  startedAt: '2026-10-22T10:00:00.000Z',
  status: 'finished',
  previousRunId: null,
  lookoverVersion: '0.0.0',
};

test('a view that throws on the page is replaced by the notice; the top bar and the view switcher stay', async () => {
  // A findings file whose finding names no rule: the Findings view cannot group it.
  const [first] = fixtureFindings().findings;
  const noRule = { ...first, rule: null } as unknown as Finding;
  stubServer({
    [API_PATHS.run]: RUN,
    [`${API_PATHS.files}findings.json`]: { ...fixtureFindings(), findings: [noRule] },
    [`${API_PATHS.files}decisions.json`]: { version: 1, decisions: {} },
  });
  vi.stubGlobal('EventSource', undefined);
  window.history.replaceState(null, '', '/#/findings');
  const { App } = await import('../src/app');
  render(<App />);

  const notice = await screen.findByRole('alert');
  expect(notice.textContent).toContain('The Findings view could not be shown');
  expect(screen.getByRole('tablist', { name: 'Report views' })).toBeDefined();
  expect(screen.getByRole('banner')).toBeDefined();
});
