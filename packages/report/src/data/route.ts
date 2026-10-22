import { useMemo, useSyncExternalStore } from 'react';

/*
 * The report's routes, in the URL's hash so the static build needs no server routing:
 *
 *   #/screens/<screenId>   one screen (`#/screens` alone: the first captured screen)
 *   #/findings             the fix-first findings
 *   #/drift                what changed since the previous run
 *
 * each with `?f=<findingId>` for the selected finding. `navigate` adds a history entry, so back and
 * forward walk the routes; a hash typed into the address bar is followed too.
 */

export type RouteView = 'screens' | 'findings' | 'drift';

export type Route =
  | { readonly view: 'screens'; readonly screenId: string | null; readonly findingId: string | null }
  | { readonly view: 'findings' | 'drift'; readonly findingId: string | null };

export const ROUTE_VIEWS: readonly RouteView[] = ['screens', 'findings', 'drift'];
const FINDING_PARAM = 'f';

function nonEmpty(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape (`%E0%A4%A`): the hash was not written by the report.
    return null;
  }
}

/** The route `hash` names, or `null` when it names none (empty, unknown or malformed). */
export function parseRoute(hash: string): Route | null {
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  const queryAt = text.indexOf('?');
  const path = queryAt === -1 ? text : text.slice(0, queryAt);
  const query = queryAt === -1 ? '' : text.slice(queryAt + 1);
  if (!path.startsWith('/')) return null;
  const segments = path.slice(1).split('/').map(decodeSegment);
  if (segments.some((segment) => segment === null)) return null;
  const findingId = nonEmpty(new URLSearchParams(query).get(FINDING_PARAM));
  const [view, screenId, ...rest] = segments as string[];
  if (rest.length > 0) return null;
  if (view === 'screens') return { view, screenId: nonEmpty(screenId), findingId };
  if ((view === 'findings' || view === 'drift') && screenId === undefined) return { view, findingId };
  return null;
}

/** The hash for `route`, starting with `#`; `parseRoute` reads it back as the same route. */
export function formatRoute(route: Route): string {
  const segments =
    route.view === 'screens' && route.screenId !== null ? [route.view, route.screenId] : [route.view];
  const path = `#/${segments.map(encodeURIComponent).join('/')}`;
  return route.findingId === null ? path : `${path}?${FINDING_PARAM}=${encodeURIComponent(route.findingId)}`;
}

/** Where the report opens: the first captured screen once one is known, else the findings. */
export function defaultRoute(firstScreenId: string | null): Route {
  return viewRoute(firstScreenId === null ? 'findings' : 'screens', firstScreenId);
}

/** The route a view's tab goes to, with nothing selected. */
export function viewRoute(view: RouteView, firstScreenId: string | null): Route {
  if (view === 'screens') return { view, screenId: firstScreenId, findingId: null };
  return { view, findingId: null };
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  window.addEventListener('hashchange', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
    window.removeEventListener('hashchange', listener);
  };
}

function currentHash(): string {
  return window.location.hash;
}

/** Shows `route`, adding a history entry; nothing happens when it is the route already shown. */
export function navigate(route: Route): void {
  const hash = formatRoute(route);
  if (hash === currentHash()) return;
  window.history.pushState(null, '', hash);
  // pushState fires no event: tell the routes at once, so a tab selects in the same frame.
  for (const listener of listeners) listener();
}

/** The route in the URL now, or `null` when it names none (the caller falls back to `defaultRoute`). */
export function useRoute(): Route | null {
  const hash = useSyncExternalStore(subscribe, currentHash, () => '');
  return useMemo(() => parseRoute(hash), [hash]);
}
