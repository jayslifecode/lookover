import type { Screen } from '@jayslifecode/lookover-core';
import type { StateGallery as StateGalleryFile } from '@jayslifecode/lookover-lenses';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { API_PATHS } from '../node/api';
import { formatRoute } from '../src/data/route';
import { findingsOnScreen } from '../src/data/selectors';
import { DOT_SIZE, fixFirstOrder, pinFace, pinName } from '../src/screens/pins';
import { fixtureEvidenceText } from './fixture';
import { REDUCED_MOTION, stubMatchMedia } from './media';
import {
  DASHBOARD,
  galleryRows,
  LOGIN,
  loadScreenshot,
  NATURAL_WIDTH,
  ORGANISATIONS,
  pinButtons,
  pinNames,
  placementsOn,
  queryScreenshot,
  SHOWN_WIDTH,
  STATE,
  scoreOf,
  screenshot,
  show,
  stepFindingsOn,
  stubEvidenceFetch,
  stubImageSizes,
} from './screens-helpers';

/* The Screens view over the fixture run; the stubs and helpers are in screens-helpers.tsx. */

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

test('the popover closes when focus leaves it for its own pin, on Escape on the pin, and on a press on the pin', () => {
  render(show(ORGANISATIONS));
  loadScreenshot();
  const pin = pinButtons()[0] as HTMLElement;
  const open = () => {
    fireEvent.click(pin);
    return screen.getByRole('listbox');
  };

  // Shift+Tab from the listbox lands on the pin, which comes before it.
  fireEvent.focusOut(open(), { relatedTarget: pin });
  expect(screen.queryByRole('listbox')).toBeNull();

  open();
  fireEvent.keyDown(pin, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(pin.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(pin);

  // Safari and Firefox do not focus a clicked button: the listbox loses focus to nothing, then the click
  // comes. The press closes the popover, and the click does not open it again.
  const listbox = open();
  fireEvent.pointerDown(pin);
  fireEvent.focusOut(listbox, { relatedTarget: null });
  fireEvent.click(pin, { detail: 1 });
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.pointerDown(pin);
  fireEvent.click(pin, { detail: 1 });
  expect(screen.getByRole('listbox')).toBeDefined();
});

test('Space on the active option selects it', () => {
  render(show(ORGANISATIONS));
  loadScreenshot();
  const [cluster] = placementsOn(ORGANISATIONS);
  fireEvent.click(pinButtons()[0] as HTMLElement);
  const listbox = screen.getByRole('listbox');

  fireEvent.keyDown(listbox, { key: 'ArrowDown' });
  fireEvent.keyDown(listbox, { key: ' ' });

  const second = cluster?.members[1]?.finding.id ?? null;
  expect(window.location.hash).toBe(
    formatRoute({ view: 'screens', screenId: ORGANISATIONS, findingId: second }),
  );
  expect(screen.queryByRole('listbox')).toBeNull();
});

test('a screenshot that cannot be loaded says so, and every finding on the screen is listed as a link', () => {
  render(show(DASHBOARD));
  const hrefs = fixFirstOrder(findingsOnScreen(STATE, DASHBOARD)).map((finding) =>
    formatRoute({ view: 'screens', screenId: DASHBOARD, findingId: finding.id }),
  );
  const listed = () =>
    within(screen.getByRole('region', { name: 'Findings on this screen' }))
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
  // Until the screenshot is measured there is nothing to pin on, so the step finding is listed too.
  expect(hrefs).toHaveLength(2);
  expect(listed()).toEqual(hrefs);

  act(() => {
    fireEvent.error(screenshot());
  });

  expect(queryScreenshot()).toBeNull();
  expect(screen.getByText('The screenshot could not be loaded.')).toBeDefined();
  expect(pinNames).toThrow();
  expect(listed()).toEqual(hrefs);
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
  expect(queryScreenshot()).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('net::ERR_CONNECTION_REFUSED');
});

test('a gallery entry that is not well formed is left out, and a crop that is not evidence is not shown', async () => {
  const path = 'evidence/gallery-4a17c4d0a2-8523815058704b90.json';
  const file = JSON.parse(fixtureEvidenceText(path)) as StateGalleryFile;
  const [brand, home, organisations] = file.entries;
  const malformed = {
    ...home,
    componentName: 7,
    skipped: { not: 'text' },
    crops: { rest: null, hover: home?.crops.hover, focus: 'evidence/x.png', active: { path: 42 } },
  };
  const gallery = {
    ...file,
    entries: [brand, malformed, 'not an entry', { role: 'link' }, organisations],
    focusOrder: [file.focusOrder[0], null, { index: 'two', tag: 'a' }],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(JSON.stringify(gallery), { headers: { 'content-type': 'application/json' } }),
    ),
  );
  render(show(DASHBOARD));

  const rows = await galleryRows(3);

  expect(
    within(rows[1] as HTMLElement)
      .getAllByRole('img')
      .map((image) => image.getAttribute('alt')),
  ).toEqual(['Dashboard (link) on hover']);
  expect(rows[1]?.textContent).not.toContain('Not put in every state');
  expect(rows[2]?.textContent).toContain('Organisations');
  expect(within(screen.getByRole('list', { name: 'Focus order' })).getAllByRole('listitem')).toHaveLength(1);
});

test('the screen strip brings the screen shown into view when it changes', () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    value: scrollIntoView,
    configurable: true,
    writable: true,
  });
  try {
    const { rerender } = render(show(DASHBOARD));
    rerender(show(ORGANISATIONS));

    const list = screen.getByRole('navigation', { name: 'Screens' });
    const current = within(list).getByRole('link', { current: 'page' });
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(current);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest' });
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});
