import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { prefersReducedMotion, subscribeMedia } from '@/motion/reduced';

/*
 * The report's theme: the system's (`prefers-color-scheme`) until the user picks one, then the user's,
 * kept in localStorage. The theme is the `data-theme` attribute on <html>, which `tokens.css` reads. The
 * store lives at module level, so every `useTheme()` sees the same theme, and loading this module sets
 * the attribute before the first render.
 */

export type Theme = 'dark' | 'light';
export type ThemeSource = 'system' | 'user';

export interface ThemeState {
  readonly theme: Theme;
  readonly source: ThemeSource;
}

/** The pointer event that asked for the switch: the reveal grows from it. */
export interface RevealEvent {
  readonly clientX: number;
  readonly clientY: number;
  /** The click count; `0` for a click made with the keyboard, which reveals from the control instead. */
  readonly detail?: number;
  readonly currentTarget?: EventTarget | null;
}

export interface UseTheme extends ThemeState {
  set(theme: Theme, event?: RevealEvent): void;
}

export const THEME_STORAGE_KEY = 'lookover.theme';
const COLOR_SCHEME_DARK = '(prefers-color-scheme: dark)';
/** The palette shown when the browser cannot say which the system prefers. */
const FALLBACK_THEME: Theme = 'dark';
const REVEAL_DURATION_MS = 620;
const REVEAL_EASING = 'cubic-bezier(.2,.8,.2,1)';
const REVEAL_PSEUDO_ELEMENT = '::view-transition-new(root)';

const listeners = new Set<() => void>();
let state: ThemeState = initialState();
let stopFollowingSystem: (() => void) | null = null;
applyToDocument(state.theme);

function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light';
}

function systemTheme(): Theme {
  if (typeof window.matchMedia !== 'function') return FALLBACK_THEME;
  return window.matchMedia(COLOR_SCHEME_DARK).matches ? 'dark' : 'light';
}

function readStoredTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : null;
  } catch {
    // Storage is blocked (a private window, a sandbox, a site-data policy): follow the system.
    return null;
  }
}

function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage is blocked or full: the choice still holds until the page is reloaded.
  }
}

function initialState(): ThemeState {
  const stored = readStoredTheme();
  return stored === null ? { theme: systemTheme(), source: 'system' } : { theme: stored, source: 'user' };
}

function applyToDocument(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

function commit(next: ThemeState): void {
  state = next;
  applyToDocument(next.theme);
  for (const listener of listeners) listener();
}

function onSystemChange(): void {
  if (state.source === 'system') commit({ theme: systemTheme(), source: 'system' });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  stopFollowingSystem ??= subscribeMedia(COLOR_SCHEME_DARK, onSystemChange);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stopFollowingSystem?.();
    stopFollowingSystem = null;
  };
}

function snapshot(): ThemeState {
  return state;
}

/** Where the reveal starts: the pointer, or the middle of the control when the keyboard clicked it. */
function revealOrigin(event: RevealEvent): { x: number; y: number } {
  const isKeyboardClick = event.detail === 0 || (event.clientX === 0 && event.clientY === 0);
  const control = event.currentTarget;
  if (isKeyboardClick && control instanceof Element) {
    const box = control.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }
  return { x: event.clientX, y: event.clientY };
}

/** The motion study's `toggleMode`: the new theme is revealed in a circle growing from `event`. */
function revealTheme(next: ThemeState, event: RevealEvent): void {
  const { x, y } = revealOrigin(event);
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const transition = document.startViewTransition(() => flushSync(() => commit(next)));
  transition.ready
    .then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: REVEAL_DURATION_MS, easing: REVEAL_EASING, pseudoElement: REVEAL_PSEUDO_ELEMENT },
      );
    })
    .catch(() => {
      // The browser skipped the transition (the tab was hidden, another one started); the theme is
      // already switched by the update callback, only the reveal is lost.
    });
}

function setTheme(theme: Theme, event?: RevealEvent): void {
  storeTheme(theme);
  const next: ThemeState = { theme, source: 'user' };
  const canReveal =
    event !== undefined && typeof document.startViewTransition === 'function' && !prefersReducedMotion();
  if (!canReveal) {
    commit(next);
    return;
  }
  revealTheme(next, event);
}

/** The current theme, where it came from, and `set` to choose one (remembered across reloads). */
export function useTheme(): UseTheme {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { ...current, set: setTheme };
}
