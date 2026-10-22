import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FindingPanel } from '../src/findings/finding-panel';
import type { GalleryBody as GalleryBodyComponent } from '../src/screens/gallery-body';
import type { Pin as PinComponent } from '../src/screens/pin';
import type { ScreenshotImage as ScreenshotImageComponent } from '../src/screens/screenshot-image';
import { stubMatchMedia } from './media';
import { KEYBOARD } from './panel-helpers';
import {
  DASHBOARD,
  loadScreenshot,
  ORGANISATIONS,
  placementsOn,
  STATE,
  show,
  stubEvidenceFetch,
  stubImageSizes,
} from './screens-helpers';

/*
 * What choosing a finding costs: in the Screens view a `?f=` change re-renders the pin ring that marks
 * it and nothing heavy — not the screenshot, not the pins' placement, not the state gallery. Probes
 * count the renders of the gallery's body, the screenshot image and each pin, and the placement runs.
 * On a phone, where the panel is in the page's flow, a choice scrolls the panel into view.
 */

const counts = vi.hoisted(() => ({
  gallery: 0,
  image: 0,
  placements: 0,
  pins: new Map<string, number>(),
}));

vi.mock('../src/screens/gallery-body', async (importOriginal) => {
  const actual = await importOriginal<{ GalleryBody: typeof GalleryBodyComponent }>();
  return {
    ...actual,
    GalleryBody: (props: Parameters<typeof GalleryBodyComponent>[0]) => {
      counts.gallery += 1;
      return <actual.GalleryBody {...props} />;
    },
  };
});

vi.mock('../src/screens/screenshot-image', async (importOriginal) => {
  const actual = await importOriginal<{ ScreenshotImage: typeof ScreenshotImageComponent }>();
  return {
    ...actual,
    ScreenshotImage: (props: Parameters<typeof ScreenshotImageComponent>[0]) => {
      counts.image += 1;
      return <actual.ScreenshotImage {...props} />;
    },
  };
});

vi.mock('../src/screens/pin', async (importOriginal) => {
  const actual = await importOriginal<{ Pin: typeof PinComponent }>();
  return {
    ...actual,
    Pin: (props: Parameters<typeof PinComponent>[0]) => {
      const id = props.placement.finding.id;
      counts.pins.set(id, (counts.pins.get(id) ?? 0) + 1);
      return <actual.Pin {...props} />;
    },
  };
});

vi.mock('../src/screens/pins', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/screens/pins')>();
  return {
    ...actual,
    placePins: (...args: Parameters<typeof actual.placePins>) => {
      counts.placements += 1;
      return actual.placePins(...args);
    },
  };
});

function snapshot() {
  return { ...counts, pins: new Map(counts.pins) };
}

/** The pins that rendered since `before`, by their first finding's id. */
function pinsRenderedSince(before: ReturnType<typeof snapshot>): string[] {
  return [...counts.pins].filter(([id, count]) => count > (before.pins.get(id) ?? 0)).map(([id]) => id);
}

beforeEach(() => {
  stubImageSizes();
  stubEvidenceFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

/** The organisations screen, loaded: its screenshot measured and its gallery in. */
async function organisations(findingId: string | null = null) {
  const view = render(show(ORGANISATIONS, findingId));
  loadScreenshot();
  await screen.findByRole('list', { name: 'Controls in each state' });
  return view;
}

test('choosing a finding re-renders only the pin that marks it: not the screenshot, the placement or the gallery', async () => {
  const placements = placementsOn(ORGANISATIONS);
  const [first, second] = placements;
  const chosen = first?.members[1]?.finding;
  const next = second?.members[0]?.finding;
  if (first === undefined || second === undefined || chosen === undefined || next === undefined) {
    throw new Error('The organisations screen has too few clusters');
  }
  const { rerender } = await organisations();
  const before = snapshot();

  rerender(show(ORGANISATIONS, chosen.id));

  expect(counts.gallery - before.gallery).toBe(0);
  expect(counts.image - before.image).toBe(0);
  expect(counts.placements - before.placements).toBe(0);
  expect(pinsRenderedSince(before)).toEqual([first.finding.id]);

  const moved = snapshot();
  rerender(show(ORGANISATIONS, next.id));
  expect(pinsRenderedSince(moved).toSorted()).toEqual([first.finding.id, second.finding.id].toSorted());
  expect(counts.gallery - moved.gallery).toBe(0);
});

test('a new state with the same findings on the screen keeps the placement; another screen renders once', async () => {
  const { rerender } = await organisations();
  const before = snapshot();

  // The run moved on (another event): the state is new, the screen's findings are the same ones.
  rerender(show(ORGANISATIONS, null, { ...STATE, lastSeq: STATE.lastSeq + 1 }));
  expect(counts.placements - before.placements).toBe(0);
  expect(counts.gallery - before.gallery).toBe(0);
  expect(pinsRenderedSince(before)).toEqual([]);

  const moved = snapshot();
  rerender(show(DASHBOARD));
  expect(counts.gallery - moved.gallery).toBe(1);
  expect(counts.image - moved.image).toBe(1);
  // Its gallery loads, and renders with it.
  await screen.findByRole('button', { name: 'Show all 12 controls' });
});

function stubScrollIntoView() {
  const scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  return scrollIntoView;
}

test('on a phone a choice scrolls the panel into view; from xl, where it is a fixed box beside, it does not', () => {
  const scrollIntoView = stubScrollIntoView();
  stubMatchMedia({ '(min-width: 80rem)': false });
  const { rerender, unmount } = render(<FindingPanel report={STATE} findingId={null} />);
  expect(scrollIntoView).not.toHaveBeenCalled();

  rerender(<FindingPanel report={STATE} findingId={KEYBOARD} />);
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
  const [target] = scrollIntoView.mock.contexts as Element[];
  expect(target?.closest('[data-finding-panel]')).not.toBeNull();
  unmount();

  scrollIntoView.mockClear();
  stubMatchMedia({ '(min-width: 80rem)': true });
  const desk = render(<FindingPanel report={STATE} findingId={null} />);
  desk.rerender(<FindingPanel report={STATE} findingId={KEYBOARD} />);
  expect(scrollIntoView).not.toHaveBeenCalled();
});
