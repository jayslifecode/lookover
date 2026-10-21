import { describe, expect, test } from 'vitest';
import { Frontier, routeOf } from '../src/map/frontier.js';
import type { RouteInfo } from '../src/map/types.js';

const BASE = new URL('http://localhost:3000/app');
const LIMITS = { routes: [], maxScreens: 10, maxPerRoute: 2 } as const;

function urlAt(path: string): URL {
  return new URL(`http://localhost:3000${path}`);
}

/** The crawler's call when the page it asked `requested` for landed on `landed`. */
function landOn(frontier: Frontier, landed: string, requested: string = landed): boolean {
  return frontier.markCaptured(urlAt(landed), urlAt(requested));
}

function hrefsOf(items: readonly { url: URL }[]): string[] {
  return items.map((item) => item.url.href);
}

describe('routeOf', () => {
  const routes: RouteInfo[] = [{ pattern: '/organisations/[id]', source: 'filesystem' }];

  test('labels a URL by the path below the base path, so a basePath app matches its own routes', () => {
    expect(routeOf(urlAt('/app/organisations/1'), BASE, routes)).toBe('/organisations/[id]');
  });

  test('falls back to the pattern of the path below the base path', () => {
    expect(routeOf(urlAt('/app/orders/12'), BASE, [])).toBe('/orders/[param]');
    expect(routeOf(urlAt('/app'), BASE, [])).toBe('/');
  });

  test('does not change a route when the base path is the root', () => {
    const rootBase = new URL('http://localhost:3000/');

    expect(routeOf(urlAt('/organisations/1'), rootBase, routes)).toBe('/organisations/[id]');
  });
});

describe('Frontier', () => {
  test('queues a URL under the route of its path below the base path', () => {
    const frontier = new Frontier(BASE, {
      ...LIMITS,
      routes: [{ pattern: '/organisations/[id]', source: 'filesystem' }],
    });

    frontier.offer(urlAt('/app/organisations/1'), null);

    expect(frontier.next().item).toMatchObject({ route: '/organisations/[id]' });
  });

  describe('markCaptured', () => {
    test('is true the first time a URL is captured and false after that', () => {
      const frontier = new Frontier(BASE, LIMITS);

      expect(landOn(frontier, '/app/home')).toBe(true);
      expect(landOn(frontier, '/app/home')).toBe(false);
      expect(landOn(frontier, '/app/home?tab=2')).toBe(true);
    });

    test('makes a later link to the captured URL a URL seen before, which is ignored', () => {
      const frontier = new Frontier(BASE, LIMITS);
      landOn(frontier, '/app/home');

      expect(frontier.offer(urlAt('/app/home'), null)).toBeNull();

      expect(frontier.next()).toEqual({ item: undefined, duplicates: [] });
    });

    test('gives back its place in the budget when the URL was captured before', () => {
      const frontier = new Frontier(BASE, { ...LIMITS, maxScreens: 2 });
      landOn(frontier, '/app/home');
      frontier.offer(urlAt('/app/a'), null);
      frontier.offer(urlAt('/app/b'), null);
      expect(frontier.offer(urlAt('/app/c'), null)).toBe('max-screens');
      expect(frontier.next().item?.url.href).toBe(urlAt('/app/a').href);

      // `/app/a` redirected to a screen that was already captured: it yields no screen.
      expect(landOn(frontier, '/app/home')).toBe(false);

      expect(frontier.offer(urlAt('/app/d'), null)).toBeNull();
    });
  });

  describe('markCaptured and the route cap', () => {
    test('counts a screen against the route it landed on when a redirect changed the route', () => {
      const frontier = new Frontier(BASE, { ...LIMITS, maxPerRoute: 2 });
      frontier.offer(urlAt('/app/a'), null);
      frontier.offer(urlAt('/app/b'), null);
      frontier.offer(urlAt('/app/c'), null);

      expect(landOn(frontier, '/app/login?next=a', '/app/a')).toBe(true);
      expect(landOn(frontier, '/app/login?next=b', '/app/b')).toBe(true);
      expect(landOn(frontier, '/app/login?next=c', '/app/c')).toBe(false);
    });

    test('leaves a URL that was not captured for the cap, not for a link seen before', () => {
      const frontier = new Frontier(BASE, { ...LIMITS, maxPerRoute: 1 });
      landOn(frontier, '/app/login?next=a', '/app/a');

      expect(landOn(frontier, '/app/login?next=b', '/app/b')).toBe(false);

      expect(frontier.offer(urlAt('/app/login?next=b'), null)).toBe('route-cap');
    });

    test('does not count a screen again when the redirect kept its route', () => {
      const frontier = new Frontier(BASE, { ...LIMITS, maxPerRoute: 1 });
      frontier.offer(urlAt('/app/orgs/1'), null);

      expect(landOn(frontier, '/app/orgs/2', '/app/orgs/1')).toBe(true);
    });

    test('gives back its place in the budget when the landed route is full', () => {
      const frontier = new Frontier(BASE, { ...LIMITS, maxScreens: 3, maxPerRoute: 1 });
      landOn(frontier, '/app/login?next=a', '/app/a');
      frontier.offer(urlAt('/app/b'), null);
      frontier.offer(urlAt('/app/c'), null);
      frontier.offer(urlAt('/app/d'), null);
      expect(frontier.offer(urlAt('/app/e'), null)).toBe('max-screens');
      expect(frontier.next().item?.url.href).toBe(urlAt('/app/b').href);

      // `/app/b` redirected to the login route, which is full: it yields no screen.
      expect(landOn(frontier, '/app/login?next=b', '/app/b')).toBe(false);

      expect(frontier.offer(urlAt('/app/f'), null)).toBeNull();
    });
  });

  describe('next', () => {
    test('returns the queued screens in order, and no item when the queue is empty', () => {
      const frontier = new Frontier(BASE, LIMITS);
      frontier.offer(urlAt('/app/a'), null);
      frontier.offer(urlAt('/app/b'), null);

      expect(frontier.next().item?.url.href).toBe(urlAt('/app/a').href);
      expect(frontier.next().item?.url.href).toBe(urlAt('/app/b').href);
      expect(frontier.next()).toEqual({ item: undefined, duplicates: [] });
    });

    test('passes over queued screens a redirect already captured, and returns them as duplicates', () => {
      const frontier = new Frontier(BASE, LIMITS);
      frontier.offer(urlAt('/app/a'), null);
      frontier.offer(urlAt('/app/home'), null);
      frontier.offer(urlAt('/app/home?tab=2'), null);
      frontier.offer(urlAt('/app/b'), null);
      landOn(frontier, '/app/home');
      landOn(frontier, '/app/home?tab=2');

      const first = frontier.next();
      const second = frontier.next();

      expect(hrefsOf(first.duplicates)).toEqual([]);
      expect(first.item?.url.href).toBe(urlAt('/app/a').href);
      expect(hrefsOf(second.duplicates)).toEqual([urlAt('/app/home').href, urlAt('/app/home?tab=2').href]);
      expect(second.item?.url.href).toBe(urlAt('/app/b').href);
    });

    test('returns the duplicates even when nothing is left to visit', () => {
      const frontier = new Frontier(BASE, LIMITS);
      frontier.offer(urlAt('/app/home'), null);
      landOn(frontier, '/app/home');

      const { item, duplicates } = frontier.next();

      expect(item).toBeUndefined();
      expect(hrefsOf(duplicates)).toEqual([urlAt('/app/home').href]);
    });
  });
});
