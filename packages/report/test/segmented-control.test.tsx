import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SegmentedControl, type SegmentedItem } from '../src/shell/segmented-control';
import { REDUCED_MOTION, stubMatchMedia } from './media';

/*
 * jsdom lays nothing out, so the tabs' layout is stubbed: tab `i` sits at `5 + 100 i` and is 96 wide
 * inside a bar 310 wide (5 px of padding each side), as `offsetLeft` and `offsetWidth` report it.
 */

type View = 'screens' | 'findings' | 'drift';
const ITEMS: readonly SegmentedItem<View>[] = [
  { value: 'screens', label: 'Screens' },
  { value: 'findings', label: 'Findings' },
  { value: 'drift', label: 'Drift' },
];
const BAR_WIDTH = 310;
const TAB_PITCH = 100;
const TAB_WIDTH = 96;
const PADDING = 5;
const FRAME_MS = 1000 / 60;

const tabLeft = (index: number) => PADDING + index * TAB_PITCH;
/** The pill's clip-path when it rests on tab `index`. */
const clipOn = (index: number) =>
  `inset(0 ${(BAR_WIDTH - tabLeft(index) - TAB_WIDTH).toFixed(2)}px 0 ${tabLeft(index).toFixed(2)}px round 999px)`;

function tabIndexOf(element: Element): number {
  if (element.getAttribute('role') !== 'tab' || element.parentElement === null) return -1;
  return [...element.parentElement.querySelectorAll('[role="tab"]')].indexOf(element);
}

function stubLayout(): void {
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
    const index = tabIndexOf(this);
    return index === -1 ? 0 : tabLeft(index);
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute('role') === 'tablist') return BAR_WIDTH;
    return tabIndexOf(this) === -1 ? 0 : TAB_WIDTH;
  });
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
    return this.getAttribute('role') === 'tablist' ? BAR_WIDTH : 0;
  });
}

/** `requestAnimationFrame` that runs only when told to, at 60 frames a second. */
function stubFrames() {
  let now = 0;
  let next = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback) => {
    const handle = next++;
    callbacks.set(handle, callback);
    return handle;
  });
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => callbacks.delete(handle));
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  return {
    request,
    /** Runs frames until nothing asks for another one, or `limit` frames. Returns how many ran. */
    run(limit = 240): number {
      let ran = 0;
      while (callbacks.size > 0 && ran < limit) {
        now += FRAME_MS;
        const due = [...callbacks.values()];
        callbacks.clear();
        for (const callback of due) callback(now);
        ran += 1;
      }
      return ran;
    },
  };
}

function Views({ onChange }: { onChange?: (value: View) => void }) {
  const [value, setValue] = useState<View>('screens');
  return (
    <SegmentedControl
      items={ITEMS}
      value={value}
      label="Report views"
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
    />
  );
}

const tab = (name: string) => screen.getByRole('tab', { name });
const selected = () => screen.getAllByRole('tab').filter((element) => element.ariaSelected === 'true');
const pillOf = (tablist: HTMLElement) => tablist.querySelector<HTMLElement>('[data-pill]');

beforeEach(() => {
  stubLayout();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('the views are a tablist of tabs, with only the selected one in the tab order', () => {
  stubMatchMedia({});
  stubFrames();
  render(<Views />);
  const tablist = screen.getByRole('tablist', { name: 'Report views' });
  expect(screen.getAllByRole('tab').map((element) => element.textContent)).toEqual([
    'Screens',
    'Findings',
    'Drift',
  ]);
  expect(selected()).toEqual([tab('Screens')]);
  expect(screen.getAllByRole('tab').map((element) => element.tabIndex)).toEqual([0, -1, -1]);
  expect(tablist.dataset.glass).toBeUndefined();
  expect(pillOf(tablist)?.getAttribute('aria-hidden')).toBe('true');
});

test('one click selects at once', () => {
  stubMatchMedia({});
  stubFrames();
  const onChange = vi.fn();
  render(<Views onChange={onChange} />);

  fireEvent.click(tab('Findings'));

  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith('findings');
  expect(selected()).toEqual([tab('Findings')]);
  expect(tab('Screens').getAttribute('aria-selected')).toBe('false');
  expect(tab('Findings').tabIndex).toBe(0);
});

test('the arrow keys, Home and End move the selection and the focus', () => {
  stubMatchMedia({});
  stubFrames();
  render(<Views />);
  tab('Screens').focus();

  fireEvent.keyDown(tab('Screens'), { key: 'ArrowRight' });
  expect(selected()).toEqual([tab('Findings')]);
  expect(document.activeElement).toBe(tab('Findings'));

  fireEvent.keyDown(tab('Findings'), { key: 'End' });
  expect(selected()).toEqual([tab('Drift')]);
  fireEvent.keyDown(tab('Drift'), { key: 'ArrowRight' });
  expect(selected()).toEqual([tab('Screens')]);
  fireEvent.keyDown(tab('Screens'), { key: 'ArrowLeft' });
  expect(selected()).toEqual([tab('Drift')]);
  fireEvent.keyDown(tab('Drift'), { key: 'Home' });
  expect(selected()).toEqual([tab('Screens')]);
  expect(document.activeElement).toBe(tab('Screens'));

  fireEvent.keyDown(tab('Screens'), { key: 'a' });
  expect(selected()).toEqual([tab('Screens')]);
});

test('the pill travels to the new tab on a spring, lifted with a shadow, and lands on its layout box', () => {
  stubMatchMedia({});
  const frames = stubFrames();
  render(<Views />);
  const pill = pillOf(screen.getByRole('tablist')) as HTMLElement;
  expect(pill.style.clipPath).toBe(clipOn(0));
  expect(pill.style.width).toBe(`${BAR_WIDTH}px`);

  fireEvent.click(tab('Drift'));
  expect(frames.request).toHaveBeenCalled();
  frames.run(6);
  expect(pill.style.clipPath).not.toBe(clipOn(0));
  expect(pill.style.filter).toContain('drop-shadow');
  expect(pill.style.transform).toMatch(/^scale\(1\.0[1-4]\d*,/u);

  const ran = frames.run();
  expect(ran).toBeLessThan(240);
  expect(pill.style.clipPath).toBe(clipOn(2));
  expect(pill.style.filter).toBe('');
  expect(pill.style.transform).toBe('scale(1.0000, 1.0000)');
});

test('the resting pill leans toward the pointer, by 6 px at most', () => {
  stubMatchMedia({});
  const frames = stubFrames();
  render(<Views />);
  const tablist = screen.getByRole('tablist');
  const pill = pillOf(tablist) as HTMLElement;

  fireEvent.pointerMove(tablist, { clientX: 300 });
  frames.run();

  expect(pill.style.clipPath).toBe(`inset(0 ${(BAR_WIDTH - 107).toFixed(2)}px 0 11.00px round 999px)`);
  fireEvent.pointerLeave(tablist);
  frames.run();
  expect(pill.style.clipPath).toBe(clipOn(0));
});

test('a drag starts after 5 px, captures the pointer, and the release snaps to the nearest tab', () => {
  stubMatchMedia({});
  const frames = stubFrames();
  const onChange = vi.fn();
  render(<Views onChange={onChange} />);
  const tablist = screen.getByRole('tablist');
  const capture = vi.fn();
  tablist.setPointerCapture = capture;
  tab('Screens').focus();

  fireEvent.pointerDown(tablist, { clientX: 53, pointerId: 7, isPrimary: true });
  fireEvent.pointerMove(tablist, { clientX: 56, pointerId: 7 });
  expect(capture).not.toHaveBeenCalled();
  fireEvent.pointerMove(tablist, { clientX: 240, pointerId: 7 });
  expect(capture).toHaveBeenCalledWith(7);
  frames.run(60);
  fireEvent.pointerUp(tablist, { clientX: 240, pointerId: 7 });
  // The click the release produces does not select the tab under the pointer as well.
  fireEvent.click(tab('Findings'));

  expect(onChange.mock.calls).toEqual([['drift']]);
  expect(selected()).toEqual([tab('Drift')]);
  expect(document.activeElement).toBe(tab('Drift'));
  frames.run();
  expect(pillOf(tablist)?.style.clipPath).toBe(clipOn(2));
});

test('a press released off the bar ends: the loop stops, and a later move does not drag the pill', () => {
  stubMatchMedia({});
  const frames = stubFrames();
  render(<Views />);
  const tablist = screen.getByRole('tablist');
  const pill = pillOf(tablist) as HTMLElement;
  const capture = vi.fn();
  tablist.setPointerCapture = capture;

  // A right click does not press the pill: its release goes to the context menu.
  fireEvent.pointerDown(tab('Screens'), { clientX: 53, pointerId: 3, button: 2, isPrimary: true });
  expect(frames.request).not.toHaveBeenCalled();

  // Two presses with no release between them (the first one's release was never heard).
  fireEvent.pointerDown(tab('Screens'), { clientX: 53, pointerId: 7, isPrimary: true });
  fireEvent.pointerDown(tab('Screens'), { clientX: 53, pointerId: 8, isPrimary: true });
  fireEvent.pointerMove(tablist, { clientX: 55, pointerId: 8 });
  // The pointer left the bar downward and was released over the page.
  fireEvent.pointerUp(document.body, { clientX: 55, pointerId: 8 });

  expect(frames.run()).toBeLessThan(240);
  expect(pill.style.transform).toBe('scale(1.0000, 1.0000)');
  fireEvent.pointerMove(tablist, { clientX: 240, pointerId: 8 });
  frames.run();
  expect(capture).not.toHaveBeenCalled();
  // Only the resting pill's lean toward the pointer, 6 px at most: nothing drags it.
  expect(pill.style.clipPath).toBe(`inset(0 ${(BAR_WIDTH - 107).toFixed(2)}px 0 11.00px round 999px)`);
  expect(selected()).toEqual([tab('Screens')]);
});

test('a selection made elsewhere (the route changed) moves the pill without motion', () => {
  stubMatchMedia({});
  const frames = stubFrames();
  const props = { items: ITEMS, label: 'Report views', onChange: vi.fn() };
  const { rerender } = render(<SegmentedControl {...props} value="findings" />);
  const pill = pillOf(screen.getByRole('tablist')) as HTMLElement;
  expect(pill.style.clipPath).toBe(clipOn(1));

  rerender(<SegmentedControl {...props} value="screens" />);

  expect(frames.request).not.toHaveBeenCalled();
  expect(pill.style.clipPath).toBe(clipOn(0));
  expect(selected()).toEqual([tab('Screens')]);
  expect(props.onChange).not.toHaveBeenCalled();
});

test('under reduced motion the pill jumps: no animation frame is asked for, the clip-path is set once', () => {
  stubMatchMedia({ [REDUCED_MOTION]: true });
  const frames = stubFrames();
  render(<Views />);
  const tablist = screen.getByRole('tablist');
  const pill = pillOf(tablist) as HTMLElement;
  tablist.setPointerCapture = vi.fn();

  fireEvent.click(tab('Findings'));
  expect(pill.style.clipPath).toBe(clipOn(1));
  fireEvent.keyDown(tab('Findings'), { key: 'ArrowRight' });
  expect(pill.style.clipPath).toBe(clipOn(2));
  fireEvent.pointerMove(tablist, { clientX: 20 });
  fireEvent.pointerDown(tablist, { clientX: 20, pointerId: 1, isPrimary: true });
  fireEvent.pointerMove(tablist, { clientX: 120, pointerId: 1 });
  fireEvent.pointerUp(tablist, { clientX: 120, pointerId: 1 });

  expect(frames.request).not.toHaveBeenCalled();
  expect(tablist.setPointerCapture).not.toHaveBeenCalled();
  expect(pill.style.filter).toBe('');
  expect(pill.style.clipPath).toBe(clipOn(2));
  act(() => undefined);
  expect(selected()).toEqual([tab('Drift')]);
});
