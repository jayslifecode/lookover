import type { Finding, Screen } from '@jayslifecode/lookover-core';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { API_PATHS, EVIDENCE_PATH_PREFIX } from '../node/api';
import { initialState, type ReportState, reduce, withFindingsFile } from '../src/data/reduce';
import { formatRoute } from '../src/data/route';
import { findingsOnScreen } from '../src/data/selectors';
import { DOT_SIZE, type PinPlacement, pinFace, pinName, placePins } from '../src/screens/pins';
import { ScreensView } from '../src/screens/screens-view';
import { fixtureEvents, fixtureEvidenceText, fixtureFindings } from './fixture';
import { REDUCED_MOTION, stubMatchMedia } from './media';

/*
 * The Screens view over the fixture run (3 screens of the bench: the dashboard, the login page and the
 * organisations list). jsdom loads no image and lays nothing out, so the screenshot's sizes are stubbed:
 * 1440 px wide as captured, shown 720 px wide. `fetch` answers the evidence files from the fixture.
 */

const STATE: ReportState = withFindingsFile(
  fixtureEvents().reduce(reduce, initialState()),
  fixtureFindings(),
);
const DASHBOARD = '4a17c4d0a2';
const LOGIN = '57682dba9d';
const ORGANISATIONS = '38a8049145';
const NATURAL_WIDTH = 1440;
const NATURAL_HEIGHT = 1800;
const SHOWN_WIDTH = 720;
const PIN_NAME = /^\d+\. /;

function stubImageSizes(): void {
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(NATURAL_WIDTH);
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(NATURAL_HEIGHT);
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
    return this instanceof HTMLImageElement ? SHOWN_WIDTH : 0;
  });
}

/** `fetch` answering `/api/evidence/<path>` from the fixture run's evidence, else 404. */
function stubEvidenceFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith(API_PATHS.evidence)) return new Response('{}', { status: 404 });
    const path = `${EVIDENCE_PATH_PREFIX}${decodeURIComponent(url.slice(API_PATHS.evidence.length))}`;
    return new Response(fixtureEvidenceText(path), { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function show(screenId: string | null, findingId: string | null = null, report: ReportState = STATE) {
  return <ScreensView report={report} screenId={screenId} findingId={findingId} />;
}

/** Fires the screenshot's `load`, as the browser does once it has the image. */
function loadScreenshot(): void {
  const image = screen.getByRole('img', { name: /^Screenshot of / });
  act(() => {
    fireEvent.load(image);
  });
}

function pinNames(): (string | null)[] {
  const pins = within(screen.getByRole('list', { name: 'Pinned findings' })).queryAllByRole('button', {
    name: PIN_NAME,
  });
  return pins.map((pin) => pin.getAttribute('aria-label'));
}

/** The pins the view should draw for `screenId` at the stubbed sizes. */
function placementsOn(screenId: string): PinPlacement[] {
  const shown = { width: SHOWN_WIDTH, height: (NATURAL_HEIGHT * SHOWN_WIDTH) / NATURAL_WIDTH };
  return placePins(findingsOnScreen(STATE, screenId), NATURAL_WIDTH, SHOWN_WIDTH, shown);
}

function pinButtons(): HTMLElement[] {
  return within(screen.getByRole('list', { name: 'Pinned findings' })).getAllByRole('button');
}

function stepFindingsOn(screenId: string): Finding[] {
  return findingsOnScreen(STATE, screenId).filter((finding) => finding.shape === 'step');
}

/** The state gallery's rows, once it has loaded `count` of them. */
async function galleryRows(count: number): Promise<HTMLElement[]> {
  return vi.waitFor(() => {
    const rows = [...screen.getByRole('list', { name: 'Controls in each state' }).children] as HTMLElement[];
    expect(rows).toHaveLength(count);
    return rows;
  });
}

/** The value next to `term` in the scorecard. */
function scoreOf(term: string): string | null {
  const card = screen.getByRole('region', { name: 'Scorecard' });
  return within(card).getByText(term, { selector: 'dt' }).nextElementSibling?.textContent ?? null;
}

beforeEach(() => {
  stubImageSizes();
  stubEvidenceFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

test('the first captured screen: one pin per confirmed step finding, named by its number and title', () => {
  render(show(null));
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Dashboard');
  // No pin before the screenshot has loaded: there is nothing to measure it by.
  expect(pinNames()).toEqual([]);

  loadScreenshot();

  const steps = stepFindingsOn(DASHBOARD);
  expect(steps).toHaveLength(1);
  expect(pinNames()).toEqual(['1. Control cannot be reached with the keyboard']);
  // The screen's occurrence finding has no place on the screenshot: it is listed instead.
  const unpinned = screen.getByRole('region', { name: 'Also on this screen' });
  expect(within(unpinned).getByRole('link', { name: /A request the page made failed/ })).toBeDefined();
});

test("the organisations screen's 24 dense pins are drawn as cluster pins, each on its first finding's corner", () => {
  render(show(ORGANISATIONS));
  loadScreenshot();

  const placements = placementsOn(ORGANISATIONS);
  // Every finding is drawn once, in one pin or one cluster, keeping its fix-first number.
  const numbers = placements.flatMap(({ members }) => members.map(({ number }) => number));
  expect(numbers.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
  // The icons sit 20 px apart (10 px shown), so they cluster.
  expect(placements.every(({ members }) => members.length > 1)).toBe(true);
  const pins = pinButtons();
  expect(pins.map((pin) => pin.getAttribute('aria-label'))).toEqual(placements.map(pinName));
  expect(pins[0]?.getAttribute('aria-label')).toMatch(
    /^\d+ findings near Tap target is smaller than 24 by 24 pixels$/,
  );
  // The dot shows the cluster's count.
  expect(pins.map((pin) => pin.firstElementChild?.textContent)).toEqual(placements.map(pinFace));
  // Each sits on its first finding's top-right corner, halved: the screenshot is shown at half its width.
  expect(pins.map((pin) => [pin.style.left, pin.style.top])).toEqual(
    placements.map(
      ({
        finding: {
          target: { box },
        },
      }) => [
        `${((box.x + box.width) * SHOWN_WIDTH) / NATURAL_WIDTH - DOT_SIZE / 2}px`,
        `${(box.y * SHOWN_WIDTH) / NATURAL_WIDTH - DOT_SIZE / 2}px`,
      ],
    ),
  );
  const unpinned = screen.getByRole('region', { name: 'Also on this screen' });
  expect(within(unpinned).getByRole('link', { name: /The page scrolls sideways/ })).toBeDefined();
});

test("the route's finding marks its pin, or the cluster holding it; clicking a pin selects its finding", () => {
  const [step] = stepFindingsOn(DASHBOARD);
  if (step === undefined) throw new Error('The dashboard has no step finding');
  const { rerender } = render(show(DASHBOARD, step.id));
  loadScreenshot();

  const [pin] = pinButtons();
  expect(pin?.getAttribute('aria-current')).toBe('true');
  fireEvent.click(pin as HTMLElement);
  expect(window.location.hash).toBe(
    formatRoute({ view: 'screens', screenId: DASHBOARD, findingId: step.id }),
  );

  const placements = placementsOn(ORGANISATIONS);
  const chosen = placements[1]?.members[1]?.finding;
  if (chosen === undefined) throw new Error('The organisations screen has too few clusters');
  rerender(show(ORGANISATIONS, chosen.id));
  loadScreenshot();
  expect(pinButtons().map((button) => button.getAttribute('aria-current'))).toEqual(
    placements.map((_, index) => (index === 1 ? 'true' : null)),
  );
});

test('a cluster pin opens a listbox of its findings: arrows move, Enter selects, Escape and outside clicks close', () => {
  render(show(ORGANISATIONS));
  loadScreenshot();
  const placements = placementsOn(ORGANISATIONS);
  const cluster = placements[0];
  if (cluster === undefined) throw new Error('The organisations screen has no pin');
  const pin = pinButtons()[0] as HTMLElement;
  expect(pin.getAttribute('aria-haspopup')).toBe('listbox');
  expect(pin.getAttribute('aria-expanded')).toBe('false');

  fireEvent.click(pin);

  const listbox = screen.getByRole('listbox', { name: `Findings near ${cluster.finding.title}` });
  expect(pin.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(listbox);
  const options = within(listbox).getAllByRole('option');
  expect(options.map((option) => option.textContent)).toEqual(
    cluster.members.map(({ finding, number }) => `${number}. ${finding.title}Medium`),
  );
  expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
  fireEvent.keyDown(listbox, { key: 'ArrowDown' });
  expect(listbox.getAttribute('aria-activedescendant')).toBe(options[1]?.id);
  expect(options[1]?.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(listbox, { key: 'ArrowUp' });
  fireEvent.keyDown(listbox, { key: 'ArrowUp' });
  // The arrows wrap.
  expect(listbox.getAttribute('aria-activedescendant')).toBe(options.at(-1)?.id);
  fireEvent.keyDown(listbox, { key: 'Home' });
  fireEvent.keyDown(listbox, { key: 'ArrowDown' });

  fireEvent.keyDown(listbox, { key: 'Enter' });

  const second = cluster.members[1]?.finding.id ?? null;
  expect(window.location.hash).toBe(
    formatRoute({ view: 'screens', screenId: ORGANISATIONS, findingId: second }),
  );
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(document.activeElement).toBe(pin);

  fireEvent.click(pin);
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(document.activeElement).toBe(pin);

  fireEvent.click(pin);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('listbox')).toBeNull();
});

test('pressing a pin springs its dot with a transform-only animation, and not under reduced motion', () => {
  const animate = vi.fn(() => ({ cancel: () => undefined }) as unknown as Animation);
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    value: animate,
    configurable: true,
    writable: true,
  });
  try {
    const media = stubMatchMedia({ [REDUCED_MOTION]: false });
    render(show(DASHBOARD));
    loadScreenshot();
    const [pin] = within(screen.getByRole('list', { name: 'Pinned findings' })).getAllByRole('button');

    fireEvent.click(pin as HTMLElement);
    expect(animate).toHaveBeenCalledTimes(1);
    const [keyframes] = animate.mock.calls[0] as unknown as [Keyframe[]];
    expect(
      keyframes.flatMap((frame) => Object.keys(frame)).every((key) => ['transform', 'offset'].includes(key)),
    ).toBe(true);

    media.set(REDUCED_MOTION, true);
    fireEvent.click(pin as HTMLElement);
    expect(animate).toHaveBeenCalledTimes(1);
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  }
});

test("the state gallery: a row per control with its crops in each state, then the screen's focus order", async () => {
  const fetchMock = stubEvidenceFetch();
  const { rerender } = render(show(DASHBOARD));

  // The first 8 of the dashboard's 12 controls, until asked for all.
  const controls = await galleryRows(8);
  const [brand] = controls;
  expect(
    within(brand as HTMLElement)
      .getAllByRole('img')
      .map((image) => image.getAttribute('alt')),
  ).toEqual([
    'Lookover Bench (link) at rest',
    'Lookover Bench (link) on hover',
    'Lookover Bench (link) with focus',
    'Lookover Bench (link) when pressed',
  ]);
  expect(brand?.textContent).toContain('LinkComponent');
  // A control without crops shows what its states changed instead.
  const uncropped = controls.find((row) => within(row).queryAllByRole('img').length === 0);
  expect(uncropped?.textContent).toMatch(/^link.*hover.*focus.*active/);
  const focusOrder = screen.getByRole('list', { name: 'Focus order' });
  expect(within(focusOrder).getAllByRole('listitem')).toHaveLength(10);

  // Fetched once per screen: coming back to it asks for nothing new.
  rerender(show(LOGIN));
  await screen.findByRole('button', { name: 'Show all 9 controls' });
  rerender(show(DASHBOARD));
  await screen.findByRole('button', { name: 'Show all 12 controls' });
  const galleries = fetchMock.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.includes('gallery-'));
  expect(galleries).toEqual([
    `${API_PATHS.evidence}gallery-${DASHBOARD}-8523815058704b90.json`,
    `${API_PATHS.evidence}gallery-${LOGIN}-fa83022d34d86ed0.json`,
  ]);
});

test('a long gallery shows its first 8 controls and 12 focus stops, and all of them when asked', async () => {
  render(show(ORGANISATIONS));
  await galleryRows(8);
  const focusOrder = () => within(screen.getByRole('list', { name: 'Focus order' })).getAllByRole('listitem');
  expect(focusOrder()).toHaveLength(12);

  const controls = screen.getByRole('button', { name: 'Show all 43 controls' });
  expect(controls.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(controls);
  await galleryRows(43);
  expect(controls.getAttribute('aria-expanded')).toBe('true');
  expect(controls.textContent).toBe('Show fewer controls');
  fireEvent.click(controls);
  await galleryRows(8);

  const stops = screen.getByRole('button', { name: 'Show all 43 stops' });
  fireEvent.click(stops);
  expect(focusOrder()).toHaveLength(43);
  expect(stops.getAttribute('aria-expanded')).toBe('true');
});

test('a screen whose inspection wrote no gallery says so', () => {
  const inspections = new Map(
    [...STATE.inspections].map(([id, inspection]) => [id, { ...inspection, gallery: null }]),
  );
  render(show(DASHBOARD, null, { ...STATE, inspections }));

  expect(screen.getByText('No gallery for this screen')).toBeDefined();
});

test("the scorecard counts the screen's confirmed findings by severity, what was set aside and why", async () => {
  render(show(DASHBOARD));

  expect(scoreOf('High')).toBe('2');
  expect(scoreOf('Medium')).toBe('0');
  expect(scoreOf('Low')).toBe('0');
  expect(scoreOf('Worth a look')).toBe('0');
  expect(scoreOf('Reproduced 3/3')).toBe('2');
  expect(scoreOf('Rejected')).toBe('0');
  const card = screen.getByRole('region', { name: 'Scorecard' });
  expect(within(card).getByRole('list', { name: 'Skipped' }).textContent).toContain(
    'text-colour-uncertain:descendant',
  );

  fireEvent.focus(within(card).getByRole('button', { name: 'Why rejected findings are not shown' }));
  expect(
    await screen.findByText(
      'Rejected by the judge: measured but not reproduced three times or attributed to the explorer, so not shown',
    ),
  ).toBeDefined();
});

test('the screen list links every screen with its counts, and marks the one shown', () => {
  render(show(ORGANISATIONS));

  const list = screen.getByRole('navigation', { name: 'Screens' });
  const links = within(list).getAllByRole('link');
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    `#/screens/${DASHBOARD}`,
    `#/screens/${LOGIN}`,
    `#/screens/${ORGANISATIONS}`,
  ]);
  expect(links.map((link) => link.getAttribute('aria-current'))).toEqual([null, null, 'page']);
  expect(links[0]?.textContent).toContain('2 high');
  expect(links[1]?.textContent).toContain('No findings');
  expect(links[2]?.textContent).toContain('1 high');
  expect(links[2]?.textContent).toContain('24 medium');
});

test('a screen whose navigation failed is marked in the list and shows why instead of a screenshot', () => {
  const [template] = STATE.screens;
  if (template === undefined) throw new Error('The fixture run has no screen');
  const failed: Screen = {
    ...template,
    id: 'failed0001',
    url: 'http://localhost:3123/broken',
    route: '/broken',
    title: '(navigation failed: net::ERR_CONNECTION_REFUSED)',
    status: 'navigation-failed',
    error: 'net::ERR_CONNECTION_REFUSED',
    screenshot: null,
    capturedAt: '9999-01-01T00:00:00.000Z',
  };
  render(show(failed.id, null, { ...STATE, screens: [...STATE.screens, failed] }));

  const link = within(screen.getByRole('navigation', { name: 'Screens' })).getByRole('link', {
    name: /\/broken/,
  });
  expect(link.textContent).toContain('Navigation failed');
  expect(screen.queryByRole('img', { name: /^Screenshot of / })).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('net::ERR_CONNECTION_REFUSED');
});
