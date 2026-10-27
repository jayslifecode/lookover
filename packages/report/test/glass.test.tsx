import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GlassBudgetError, MAX_GLASS_LAYERS, watchGlassBudget } from '../src/glass/budget';
import { Glass } from '../src/glass/glass';
import { REDUCED_MOTION, REDUCED_TRANSPARENCY, stubMatchMedia } from './media';

/** `CSS.supports` as a browser answers it: `blur` for the frosted base, `lens` for `url(#lens)`. */
function stubCssSupports({ blur, lens }: { blur: boolean; lens: boolean }): void {
  vi.stubGlobal('CSS', {
    supports: (property: string, value: string) =>
      property.endsWith('backdrop-filter') && (value.startsWith('url(') ? lens : blur),
  });
}

/** MutationObserver callbacks run as microtasks. */
const observersRan = () => act(async () => {});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('Glass renders solid under reduced transparency', () => {
  const media = stubMatchMedia({ [REDUCED_TRANSPARENCY]: false });
  stubCssSupports({ blur: true, lens: true });
  render(
    <Glass lens data-testid="panel">
      Finding
    </Glass>,
  );
  const panel = screen.getByTestId('panel');
  expect(panel.dataset.glass).toBe('lens');
  expect(panel.querySelector('[data-glass-spot]')).not.toBeNull();
  // The refracting band along the top edge: a layer of its own, hidden from assistive technology.
  expect(panel.querySelector('[data-glass-band]')?.getAttribute('aria-hidden')).toBe('true');

  act(() => media.set(REDUCED_TRANSPARENCY, true));

  expect(panel.dataset.glass).toBe('solid');
  expect(panel.className).toContain('glass-solid');
  expect(panel.className).not.toContain('glass-lens');
  expect(panel.querySelector('[data-glass-spot]')).toBeNull();
  expect(panel.querySelector('[data-glass-band]')).toBeNull();
  expect(panel.textContent).toBe('Finding');
});

test('Glass renders solid under reduced motion and without backdrop-filter support', () => {
  stubMatchMedia({ [REDUCED_MOTION]: true });
  stubCssSupports({ blur: true, lens: true });
  render(<Glass data-testid="moving">a</Glass>);
  expect(screen.getByTestId('moving').dataset.glass).toBe('solid');
  cleanup();

  stubMatchMedia({});
  stubCssSupports({ blur: false, lens: false });
  render(<Glass data-testid="old-browser">b</Glass>);
  expect(screen.getByTestId('old-browser').dataset.glass).toBe('solid');
});

test('the lens is used only when asked for and the browser can apply it', () => {
  stubMatchMedia({});
  stubCssSupports({ blur: true, lens: false });
  render(
    <>
      <Glass lens data-testid="asked">
        a
      </Glass>
      <Glass as="header" data-testid="plain">
        b
      </Glass>
    </>,
  );
  expect(screen.getByTestId('asked').dataset.glass).toBe('frosted');
  expect(screen.getByTestId('plain').dataset.glass).toBe('frosted');
  expect(document.querySelectorAll('[data-glass-band]')).toHaveLength(0);
  expect(screen.getByTestId('plain').tagName).toBe('HEADER');
});

test('the highlight follows the pointer with one transform per frame', () => {
  stubMatchMedia({});
  stubCssSupports({ blur: true, lens: false });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  render(<Glass data-testid="bar">a</Glass>);
  const bar = screen.getByTestId('bar');
  const spot = bar.querySelector<HTMLElement>('[data-glass-spot]');

  fireEvent.pointerMove(bar, { clientX: 300, clientY: 200 });
  fireEvent.pointerMove(bar, { clientX: 310, clientY: 220 });
  expect(frames).toHaveLength(1);
  act(() => frames[0]?.(16));

  // The spot is 260 by 180 and centred on the pointer (jsdom lays the bar out at 0,0).
  expect(spot?.style.transform).toMatch(/^translate3d\(180px,\s*130px,\s*0(px)?\)$/);
});

const SURFACES = ['top bar', 'pins', 'panel', 'one too many'];

/** The first `count` of SURFACES, side by side. */
function surfaces(count: number) {
  return (
    <div>
      {SURFACES.slice(0, count).map((name) => (
        <Glass key={name} aria-label={name} />
      ))}
    </div>
  );
}

/** Collects what is thrown outside the test's own stack (the MutationObserver's callback). */
function captureWindowErrors(): { errors: unknown[]; stop: () => void } {
  const errors: unknown[] = [];
  const onError = (event: ErrorEvent) => {
    errors.push(event.error);
    event.preventDefault();
  };
  window.addEventListener('error', onError);
  return { errors, stop: () => window.removeEventListener('error', onError) };
}

test('more than three glass layers throws in development', async () => {
  stubMatchMedia({});
  stubCssSupports({ blur: true, lens: true });
  const captured = captureWindowErrors();
  const stopWatching = watchGlassBudget(document.body);
  try {
    render(surfaces(MAX_GLASS_LAYERS));
    await observersRan();
    expect(captured.errors).toEqual([]);

    cleanup();
    render(surfaces(MAX_GLASS_LAYERS + 1));
    await observersRan();
    expect(captured.errors).toHaveLength(1);
    expect(captured.errors[0]).toBeInstanceOf(GlassBudgetError);
    expect(String(captured.errors[0])).toMatch(/4 glass surfaces/);
    expect(String(captured.errors[0])).toContain('(the top bar, the finding panel and the toast)');
  } finally {
    stopWatching();
    captured.stop();
  }
});

test('a production build does not watch the glass budget', async () => {
  stubMatchMedia({});
  stubCssSupports({ blur: true, lens: true });
  vi.stubEnv('DEV', false);
  const captured = captureWindowErrors();
  const stopWatching = watchGlassBudget(document.body);
  try {
    render(surfaces(MAX_GLASS_LAYERS + 1));
    await observersRan();
    expect(captured.errors).toEqual([]);
  } finally {
    stopWatching();
    captured.stop();
    vi.unstubAllEnvs();
  }
});
