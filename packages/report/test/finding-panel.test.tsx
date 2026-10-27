import type { EvidenceItem, Finding } from '@jayslifecode/lookover-core';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { API_PATHS } from '../node/api';
import { Toaster } from '../src/components/ui/sonner';
import { DECISION_TIMEOUT_MS, REPLAY_TIMEOUT_MS } from '../src/data/api';
import type { ReportState } from '../src/data/reduce';
import { withFindingsFile } from '../src/data/reduce';
import { FindingPanel } from '../src/findings/finding-panel';
import { findingsFile, stepFinding } from './fixture';
import {
  factOf,
  fixtureFinding,
  fixtureStep,
  INTENDED,
  KEYBOARD,
  panelFor,
  type Server,
  stubClipboard,
  stubDialog,
  stubServer,
  unstubDialog,
} from './panel-helpers';
import { STATE } from './screens-helpers';

/* The finding panel over the fixture run, with the report server stood in for by `stubServer`. */

const KEYBOARD_TITLE = 'Control cannot be reached with the keyboard';
let server: Server;

beforeEach(() => {
  server = stubServer();
  stubDialog();
});

afterEach(() => {
  cleanup();
  unstubDialog();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPanel(findingId: string | null, report: ReportState = STATE) {
  return render(
    <>
      <FindingPanel report={report} findingId={findingId} />
      <Toaster />
    </>,
  );
}

/** The fixture run with `extra` findings added to its lists. */
function withExtra(lists: { findings?: Finding[]; rejected?: Finding[] }): ReportState {
  const file = findingsFile({
    findings: [...STATE.judged.values()].filter((finding) => finding.status === 'confirmed'),
    intended: [fixtureFinding(INTENDED)],
  });
  return withFindingsFile(STATE, {
    ...file,
    findings: [...file.findings, ...(lists.findings ?? [])],
    rejected: lists.rejected ?? [],
  });
}

function crop(label: string, id: string): EvidenceItem {
  return { kind: 'crop', label, ref: { id, path: `evidence/${id}.png`, bytes: 1, kind: 'png' } };
}

test('a step finding: its severity and lens, title, why it matters, the facts, how it was reproduced and judged, and what was expected', async () => {
  renderPanel(KEYBOARD);
  const panel = panelFor(KEYBOARD_TITLE);
  const finding = fixtureStep(KEYBOARD);

  expect(within(panel).getByText('High · interaction')).toBeDefined();
  expect(within(panel).getByRole('heading', { name: KEYBOARD_TITLE })).toBeDefined();
  expect(within(panel).getByText(finding.whyItMatters)).toBeDefined();
  const reference = within(panel).getByRole('link', { name: 'WCAG 2.2 · 2.1.1 Keyboard' });
  expect(reference.getAttribute('href')).toBe('https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html');
  expect(reference.getAttribute('target')).toBe('_blank');
  expect(reference.getAttribute('rel')).toBe('noreferrer');
  expect(factOf(panel, 'Rule')).toContain('interaction.keyboard-unreachable');
  expect(factOf(panel, 'Element')).toBe('button "Organisations 12"[data-testid="stat-organisations"]');
  expect(factOf(panel, 'Component')).toBe('<StatCard>');
  expect(factOf(panel, 'Signature')).toBe(finding.target?.signature);
  expect(factOf(panel, 'Viewport')).toBe('desktop · 1440×900');
  // The measured facts come from the finding's measurements file.
  await vi.waitFor(() => expect(factOf(panel, 'Measured')).toContain('focusable: false'));
  expect(
    within(panel)
      .getAllByText(/^(selector|role|tag|focusable): /)
      .map((line) => line.textContent),
  ).toEqual(['selector: [data-testid="stat-organisations"]', 'role: button', 'tag: div', 'focusable: false']);
  expect(server.fetch).toHaveBeenCalledWith(
    `${API_PATHS.evidence}measurements-54daa05e1eaf4778.json`,
    expect.anything(),
  );

  expect(within(panel).getByText('Reproduced 3 of 3 · chromium 156.0.8078.4 · 1440×900')).toBeDefined();
  expect(within(panel).getByText('Confirmed by reproduction; the judge model was not used')).toBeDefined();
  expect(factOf(panel, 'Observed')).toBe('cannot receive keyboard focus');
  expect(factOf(panel, 'Expected')).toBe(finding.expected);
  expect(
    within(panel)
      .getAllByRole('button')
      .map((button) => button.textContent),
  ).toEqual(['Copy fix prompt', 'Replay', 'Mark intended']);
  // A finding with no crop or screenshot has no evidence strip.
  expect(within(panel).queryByRole('list', { name: 'Evidence' })).toBeNull();
});

test("a model's verdict names the model, its attribution and its note; a crop opens enlarged in a dialog", () => {
  const step = fixtureStep(KEYBOARD);
  const judged: Finding = {
    ...step,
    id: 'model-judged',
    title: 'Judged by the model',
    evidence: [...step.evidence, crop('At rest', '102580572b2d2bd5'), crop('With focus', '1656ae6a8c22b375')],
    judgement: step.judgement && {
      ...step.judgement,
      decidedBy: 'model',
      model: 'claude-sonnet-5-5',
      note: 'The stat card is a div with a click handler and no tabindex.',
    },
  };
  renderPanel(judged.id, withExtra({ findings: [judged] }));
  const panel = panelFor('Judged by the model');

  expect(within(panel).getByText('Judged by claude-sonnet-5-5')).toBeDefined();
  expect(within(panel).getByText('Attributed to a product defect.')).toBeDefined();
  expect(
    within(panel).getByText('The stat card is a div with a click handler and no tabindex.'),
  ).toBeDefined();

  const strip = within(panel).getByRole('list', { name: 'Evidence' });
  // The thumbnails are decorative: each button is named after its picture.
  expect([...strip.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual([
    `${API_PATHS.evidence}102580572b2d2bd5.png`,
    `${API_PATHS.evidence}1656ae6a8c22b375.png`,
  ]);
  const dialog = document.querySelector('dialog');
  expect(dialog?.open).toBe(false);

  fireEvent.click(within(strip).getByRole('button', { name: 'Enlarge With focus' }));

  expect(dialog?.open).toBe(true);
  const enlarged = within(dialog as HTMLElement).getByRole('img', { name: 'With focus' });
  expect(enlarged.getAttribute('src')).toBe(`${API_PATHS.evidence}1656ae6a8c22b375.png`);
  fireEvent.click(within(dialog as HTMLElement).getByRole('button', { name: 'Close' }));
  expect(dialog?.open).toBe(false);
});

test('Copy fix prompt writes the prompt to the clipboard and says so in a glass toast', async () => {
  const clipboard = stubClipboard(async () => undefined);
  renderPanel(KEYBOARD);

  fireEvent.click(within(panelFor(KEYBOARD_TITLE)).getByRole('button', { name: 'Copy fix prompt' }));

  expect(clipboard.writeText).toHaveBeenCalledWith(fixtureStep(KEYBOARD).fixPrompt);
  const toast = await screen.findByText('Fix prompt copied');
  expect(toast.closest('[data-glass]')).not.toBeNull();
  expect(screen.queryByLabelText('Fix prompt')).toBeNull();
});

test('a copy the browser refuses says so, and shows the prompt to select by hand', async () => {
  stubClipboard(async () => {
    throw new DOMException('Write permission denied', 'NotAllowedError');
  });
  renderPanel(KEYBOARD);

  fireEvent.click(within(panelFor(KEYBOARD_TITLE)).getByRole('button', { name: 'Copy fix prompt' }));

  expect(await screen.findByText('Could not copy; select the prompt below')).toBeDefined();
  expect(within(panelFor(KEYBOARD_TITLE)).getByLabelText('Fix prompt').textContent).toBe(
    fixtureStep(KEYBOARD).fixPrompt,
  );
});

test('Mark intended posts the decision with its note and shows the finding as intended at once; Undo takes it back', async () => {
  renderPanel(KEYBOARD);
  const panel = panelFor(KEYBOARD_TITLE);

  fireEvent.change(within(panel).getByLabelText('Note (optional)'), {
    target: { value: 'The card links to the same page as the menu' },
  });
  fireEvent.click(within(panel).getByRole('button', { name: 'Mark intended' }));

  // Before the server has answered.
  expect(within(panel).getByText('Marked intended')).toBeDefined();
  expect(within(panel).getByText('The card links to the same page as the menu')).toBeDefined();
  expect(within(panel).queryByRole('button', { name: 'Copy fix prompt' })).toBeNull();
  const [mark] = server.posts(API_PATHS.decisions);
  expect(mark?.body).toEqual({
    findingId: KEYBOARD,
    status: 'intended',
    note: 'The card links to the same page as the menu',
  });
  const decision = {
    status: 'intended',
    at: '2026-10-22T12:00:00.000Z',
    note: 'The card links to the same page as the menu',
  };
  await act(async () => mark?.answer(200, { decisions: { [KEYBOARD]: decision } }));
  expect(within(panel).getByText('Marked intended')).toBeDefined();

  fireEvent.click(within(panel).getByRole('button', { name: 'Undo' }));

  expect(within(panel).getByRole('button', { name: 'Copy fix prompt' })).toBeDefined();
  const [, undo] = server.posts(API_PATHS.decisions);
  expect(undo?.body).toEqual({ findingId: KEYBOARD, status: null });
  await act(async () => undo?.answer(200, { decisions: {} }));
  expect(within(panel).queryByText('Marked intended')).toBeNull();
});

test('a decision the server refuses is taken back, and a toast says why', async () => {
  renderPanel(KEYBOARD);
  const panel = panelFor(KEYBOARD_TITLE);

  fireEvent.click(within(panel).getByRole('button', { name: 'Mark intended' }));
  expect(within(panel).getByText('Marked intended')).toBeDefined();
  const [mark] = server.posts(API_PATHS.decisions);
  expect(mark?.body).toEqual({ findingId: KEYBOARD, status: 'intended' });
  await act(async () => mark?.answer(500, { error: 'The decisions file could not be written' }));

  expect(
    await screen.findByText('Could not mark the finding intended: The decisions file could not be written'),
  ).toBeDefined();
  expect(within(panel).queryByText('Marked intended')).toBeNull();
  expect(within(panel).getByRole('button', { name: 'Mark intended' })).toBeDefined();
});

test("Replay posts, shows Replaying… while it runs, then the result; a busy server's word and a failure are shown", async () => {
  renderPanel(KEYBOARD);
  const panel = panelFor(KEYBOARD_TITLE);
  const replay = () => within(panel).getByRole('button', { name: /^Replay/ }) as HTMLButtonElement;

  fireEvent.click(replay());

  expect(replay().textContent).toBe('Replaying…');
  expect(replay().disabled).toBe(true);
  const [first] = server.posts(API_PATHS.replay);
  expect(first?.body).toEqual({ findingId: KEYBOARD });
  await act(async () => first?.answer(200, { attempts: [], reproduced: 1, of: 1 }));
  expect(await within(panel).findByText('Reproduced 1 of 1')).toBeDefined();
  expect(replay().textContent).toBe('Replay');
  expect(replay().disabled).toBe(false);

  // A 409 says why in the server's own words: another replay runs, or the run has not finished.
  fireEvent.click(replay());
  await act(async () =>
    server.posts(API_PATHS.replay)[1]?.answer(409, { error: 'Replay is available when the run finishes' }),
  );
  expect(await within(panel).findByText('Replay is available when the run finishes')).toBeDefined();

  fireEvent.click(replay());
  await act(async () =>
    server.posts(API_PATHS.replay)[2]?.answer(500, { error: 'The browser could not start' }),
  );
  expect(await within(panel).findByText('The replay failed: The browser could not start')).toBeDefined();
});

test('a rejected finding shows its attribution and note instead of the actions', () => {
  const step = fixtureStep(KEYBOARD);
  const rejected: Finding = {
    ...step,
    id: 'rejected-timing',
    title: 'Rejected for timing',
    status: 'rejected',
    judgement: step.judgement && {
      ...step.judgement,
      reproduced: 1,
      attribution: 'timing',
      note: 'It reproduced in 1 of 3 attempts.',
    },
  };
  renderPanel(rejected.id, withExtra({ rejected: [rejected] }));
  const panel = panelFor('Rejected for timing');

  expect(within(panel).getByText('Reproduced 1 of 3 · chromium 156.0.8078.4 · 1440×900')).toBeDefined();
  expect(within(panel).getByText('Rejected by reproduction; the judge model was not used')).toBeDefined();
  expect(within(panel).getByText('Attributed to timing: it did not reproduce every time.')).toBeDefined();
  expect(within(panel).getByText('It reproduced in 1 of 3 attempts.')).toBeDefined();
  expect(within(panel).getByText('Rejected: not listed with the findings')).toBeDefined();
  expect(within(panel).queryByRole('button')).toBeNull();
});

test('an intended finding shows its note and an Undo instead of the actions', () => {
  renderPanel(INTENDED);
  const panel = panelFor(KEYBOARD_TITLE);

  expect(within(panel).getByText('Marked intended')).toBeDefined();
  expect(
    within(panel).getByText('Kept on purpose: the intended finding of the report fixture.'),
  ).toBeDefined();
  expect(
    within(panel)
      .getAllByRole('button')
      .map((button) => button.textContent),
  ).toEqual(['Undo']);
});

test("with nothing selected the panel shows the run's summary, never nothing", () => {
  const { rerender } = renderPanel(null);
  const summary = screen.getByRole('complementary', { name: 'Run summary' });

  expect(factOf(summary, 'Screens')).toBe('3');
  expect(factOf(summary, 'Confirmed')).toBe('3 high · 24 medium');
  expect(factOf(summary, 'Intended')).toBe('1');
  expect(factOf(summary, 'Rejected')).toBe('0');
  expect(factOf(summary, 'Worth a look')).toBe('0');
  expect(
    within(summary).getByText(
      'The judge model was not used (no API key): reproduction alone confirmed the findings.',
    ),
  ).toBeDefined();

  const totals = {
    model: 'claude-sonnet-5-5',
    calls: 12,
    cacheHits: 2,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    estimatedUsd: 0.0421,
    unavailable: null,
  };
  rerender(<FindingPanel report={{ ...STATE, totals }} findingId="no-such-finding" />);
  const withCost = screen.getByRole('complementary', { name: 'Run summary' });
  expect(within(withCost).getByText('Judged by claude-sonnet-5-5 · 12 calls · $0.04')).toBeDefined();
  expect(within(withCost).getByText('This run has no finding no-such-finding.')).toBeDefined();

  // A model that failed partway keeps what it cost.
  rerender(
    <FindingPanel report={{ ...STATE, totals: { ...totals, unavailable: 'api-error' } }} findingId={null} />,
  );
  expect(
    screen.getByText(
      'Judged by claude-sonnet-5-5 · 12 calls · $0.04 · the model failed partway; reproduction alone decided the rest',
    ),
  ).toBeDefined();
});

test('from xl the panel is a fixed box under the top bar, and its body is what scrolls', () => {
  renderPanel(KEYBOARD);
  const panel = panelFor(KEYBOARD_TITLE);

  expect(panel.className.split(' ')).toEqual(
    expect.arrayContaining(['xl:sticky', 'xl:top-[84px]', 'xl:h-[calc(100vh-100px)]', 'overflow-hidden']),
  );
  const body = panel.querySelector<HTMLElement>('[data-panel-body]');
  expect(body?.className).toContain('overflow-y-auto');
  expect(body?.contains(within(panel).getByRole('heading', { name: KEYBOARD_TITLE }))).toBe(true);
  expect(within(panel).getByRole('button', { name: 'Copy fix prompt' }).closest('[data-panel-body]')).toBe(
    body,
  );
});

test('a worth-a-look entry is labelled as one, can be copied and replayed, and cannot be marked intended', () => {
  const entry = {
    ...stepFinding({ id: 'worth-1', title: 'Hover changes nothing', status: 'candidate', severity: 'low' }),
    judgement: null,
  };
  const report = withFindingsFile(STATE, { ...findingsFile({}), worthALook: [entry] });
  renderPanel(entry.id, report);
  const panel = panelFor('Hover changes nothing');

  expect(within(panel).getByText('worth a look', { exact: true })).toBeDefined();
  expect(within(panel).getByText('Low · interaction · worth a look')).toBeDefined();
  expect(
    within(panel).getByText(
      'A lower-confidence observation: measured, but not reproduced or judged, so not a finding.',
    ),
  ).toBeDefined();
  expect(
    within(panel)
      .getAllByRole('button')
      .map((button) => button.textContent),
  ).toEqual(['Copy fix prompt', 'Replay']);
  expect(within(panel).queryByLabelText('Note (optional)')).toBeNull();
});

test('a request the server never answers is given up on: the replay says so in the panel, the decision in a toast', async () => {
  renderPanel(KEYBOARD);
  const panel = panelFor(KEYBOARD_TITLE);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    fireEvent.click(within(panel).getByRole('button', { name: 'Replay' }));
    await act(async () => vi.advanceTimersByTimeAsync(REPLAY_TIMEOUT_MS));
    expect(
      within(panel).getByText('The replay failed: The report server did not answer within 120 s'),
    ).toBeDefined();
    expect((within(panel).getByRole('button', { name: 'Replay' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(within(panel).getByRole('button', { name: 'Mark intended' }));
    expect(within(panel).getByText('Marked intended')).toBeDefined();
    // The toast is added on a timer of sonner's own, just after the request is given up on.
    await act(async () => vi.advanceTimersByTimeAsync(DECISION_TIMEOUT_MS + 1));
    expect(
      screen.getByText('Could not mark the finding intended: The report server did not answer within 15 s'),
    ).toBeDefined();
    expect(within(panel).getByRole('button', { name: 'Mark intended' })).toBeDefined();
  } finally {
    vi.useRealTimers();
  }
});
