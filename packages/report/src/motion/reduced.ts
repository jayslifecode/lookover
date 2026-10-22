import { useSyncExternalStore } from 'react';

/*
 * The user's motion and transparency preferences, read from the media queries each time (never cached,
 * so a change in the system settings applies at once). Without `matchMedia` (old browsers, jsdom)
 * nothing is reduced.
 */

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const REDUCED_TRANSPARENCY = '(prefers-reduced-transparency: reduce)';

function mediaQuery(query: string): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
}

/** Whether `query` matches now; `false` when the browser cannot tell. */
export function matchesMedia(query: string): boolean {
  return mediaQuery(query)?.matches ?? false;
}

/** Calls `onChange` whenever `query` starts or stops matching; returns the unsubscribe. */
export function subscribeMedia(query: string, onChange: () => void): () => void {
  const list = mediaQuery(query);
  if (list === null) return () => undefined;
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

export function prefersReducedMotion(): boolean {
  return matchesMedia(REDUCED_MOTION);
}

export function prefersReducedTransparency(): boolean {
  return matchesMedia(REDUCED_TRANSPARENCY);
}

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => subscribeMedia(query, onChange),
    () => matchesMedia(query),
    () => false,
  );
}

/** `prefersReducedMotion()`, re-rendering when the preference changes. */
export function useReducedMotion(): boolean {
  return useMedia(REDUCED_MOTION);
}

/** `prefersReducedTransparency()`, re-rendering when the preference changes. */
export function useReducedTransparency(): boolean {
  return useMedia(REDUCED_TRANSPARENCY);
}
