import { vi } from 'vitest';

/*
 * jsdom has no `matchMedia`. This stands in for it: every query answers from `initial` (unknown queries
 * do not match), and `set` flips a query and tells its listeners, as a browser does when the user
 * changes a system preference.
 */

export const COLOR_SCHEME_DARK = '(prefers-color-scheme: dark)';
export const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
export const REDUCED_TRANSPARENCY = '(prefers-reduced-transparency: reduce)';

export interface MediaStub {
  set(query: string, matches: boolean): void;
}

type ChangeListener = (event: MediaQueryListEvent) => void;

export function stubMatchMedia(initial: Readonly<Record<string, boolean>> = {}): MediaStub {
  const state = new Map(Object.entries(initial));
  const listeners = new Map<string, Set<ChangeListener>>();
  const listenersOf = (query: string): Set<ChangeListener> => {
    const known = listeners.get(query) ?? new Set<ChangeListener>();
    listeners.set(query, known);
    return known;
  };
  const matchMedia = (query: string): MediaQueryList =>
    ({
      media: query,
      get matches() {
        return state.get(query) ?? false;
      },
      onchange: null,
      addEventListener: (_type: string, listener: ChangeListener) => listenersOf(query).add(listener),
      removeEventListener: (_type: string, listener: ChangeListener) => listenersOf(query).delete(listener),
      addListener: (listener: ChangeListener) => listenersOf(query).add(listener),
      removeListener: (listener: ChangeListener) => listenersOf(query).delete(listener),
      dispatchEvent: () => true,
    }) as unknown as MediaQueryList;
  vi.stubGlobal('matchMedia', matchMedia);
  return {
    set(query, matches) {
      state.set(query, matches);
      for (const listener of listenersOf(query)) {
        listener({ matches, media: query } as MediaQueryListEvent);
      }
    },
  };
}
