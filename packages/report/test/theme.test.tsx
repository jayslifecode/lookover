import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { COLOR_SCHEME_DARK, REDUCED_MOTION, stubMatchMedia } from './media';

const STORAGE_KEY = 'lookover.theme';
const REVEAL_PSEUDO = '::view-transition-new(root)';

/** A fresh copy of the theme modules, as after a page load: the theme store lives at module level. */
async function loadTheme() {
  vi.resetModules();
  const [{ ThemeToggle }, { useTheme }] = await Promise.all([
    import('../src/theme/theme-toggle'),
    import('../src/theme/use-theme'),
  ]);
  function Probe() {
    const { theme, source } = useTheme();
    return <output data-testid="theme">{`${theme}/${source}`}</output>;
  }
  render(
    <>
      <ThemeToggle />
      <Probe />
    </>,
  );
}

const shown = () => screen.getByTestId('theme').textContent;
const rootTheme = () => document.documentElement.dataset.theme;

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('the dark palette is the default when the system prefers dark, and a user choice persists', async () => {
  const media = stubMatchMedia({ [COLOR_SCHEME_DARK]: true });
  await loadTheme();
  expect(rootTheme()).toBe('dark');
  expect(shown()).toBe('dark/system');

  fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
  expect(rootTheme()).toBe('light');
  expect(shown()).toBe('light/user');
  expect(localStorage.getItem(STORAGE_KEY)).toBe('light');

  // The user's choice wins over the system from now on.
  act(() => {
    media.set(COLOR_SCHEME_DARK, false);
    media.set(COLOR_SCHEME_DARK, true);
  });
  expect(rootTheme()).toBe('light');

  // After a reload the stored choice is read back.
  cleanup();
  delete document.documentElement.dataset.theme;
  await loadTheme();
  expect(rootTheme()).toBe('light');
  expect(shown()).toBe('light/user');
  expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeDefined();
});

test('the page has no theme until the theme module sets the one the system prefers', async () => {
  // jsdom's own URL is the global one here: the path is built from Node's.
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
  stubMatchMedia({ [COLOR_SCHEME_DARK]: false });

  // Without the attribute, tokens.css paints the system's palette until this module runs.
  expect(html).toContain('<html lang="en">');
  expect(html).not.toContain('data-theme');
  expect(rootTheme()).toBeUndefined();
  await loadTheme();
  expect(rootTheme()).toBe('light');
});

test('follows the system while the user has not chosen', async () => {
  const media = stubMatchMedia({ [COLOR_SCHEME_DARK]: false });
  await loadTheme();
  expect(shown()).toBe('light/system');

  act(() => media.set(COLOR_SCHEME_DARK, true));
  expect(rootTheme()).toBe('dark');
  expect(shown()).toBe('dark/system');
});

test('storage that refuses to be read or written leaves the theme working', async () => {
  stubMatchMedia({ [COLOR_SCHEME_DARK]: true });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('SecurityError');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('QuotaExceededError');
  });
  await loadTheme();
  expect(shown()).toBe('dark/system');

  fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
  expect(rootTheme()).toBe('light');
  expect(shown()).toBe('light/user');
});

/** jsdom has neither View Transitions nor `Element.animate`: stand-ins that record their calls. */
function stubViewTransition() {
  const animate = vi.fn();
  const startViewTransition = vi.fn((update: () => void) => {
    update();
    return { ready: Promise.resolve(), finished: Promise.resolve(), updateCallbackDone: Promise.resolve() };
  });
  Object.assign(document.documentElement, { animate });
  Object.assign(document, { startViewTransition });
  vi.stubGlobal('innerWidth', 1000);
  vi.stubGlobal('innerHeight', 800);
  return { animate, startViewTransition };
}

const revealFrom = (x: number, y: number, radius: number) => [
  { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
  expect.objectContaining({ pseudoElement: REVEAL_PSEUDO }),
];

afterEach(() => {
  Reflect.deleteProperty(document, 'startViewTransition');
  Reflect.deleteProperty(document.documentElement, 'animate');
});

test('switching from the pointer reveals the new theme in a circle from the pointer', async () => {
  stubMatchMedia({ [COLOR_SCHEME_DARK]: true });
  const { animate, startViewTransition } = stubViewTransition();
  await loadTheme();

  fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }), {
    clientX: 100,
    clientY: 200,
    detail: 1,
  });
  await act(async () => {});

  expect(startViewTransition).toHaveBeenCalledTimes(1);
  expect(rootTheme()).toBe('light');
  expect(animate).toHaveBeenCalledWith(...revealFrom(100, 200, Math.hypot(900, 600)));
});

test('a click made with the keyboard reveals the new theme from the middle of the button', async () => {
  stubMatchMedia({ [COLOR_SCHEME_DARK]: true });
  const { animate } = stubViewTransition();
  await loadTheme();
  const toggle = screen.getByRole('button', { name: 'Switch to light theme' });
  vi.spyOn(toggle, 'getBoundingClientRect').mockReturnValue({
    left: 900,
    top: 20,
    width: 80,
    height: 36,
  } as DOMRect);

  fireEvent.click(toggle, { detail: 0 });
  await act(async () => {});

  expect(animate).toHaveBeenCalledWith(...revealFrom(940, 38, Math.hypot(940, 762)));
});

test('under reduced motion the theme switches at once, without a transition', async () => {
  stubMatchMedia({ [COLOR_SCHEME_DARK]: true, [REDUCED_MOTION]: true });
  const { startViewTransition } = stubViewTransition();
  await loadTheme();

  fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }), {
    clientX: 10,
    clientY: 10,
    detail: 1,
  });

  expect(startViewTransition).not.toHaveBeenCalled();
  expect(rootTheme()).toBe('light');
});
