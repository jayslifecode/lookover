import type { RunEventBody } from '../run/events.js';
import { appRelativePath, isSameApp, routeKey } from '../util/url.js';
import { isDestructiveLink } from './links.js';
import { matchRoute, routePatternFromPath } from './next-routes.js';
import type { RouteInfo } from './types.js';

/** Why `offer` leaves a URL out. A redirect to a captured screen is only found out by visiting. */
type SkipReason = Exclude<
  Extract<RunEventBody, { type: 'screen.skipped' }>['reason'],
  'redirected-duplicate'
>;

/** A screen waiting to be visited. */
export interface QueuedScreen {
  url: URL;
  route: string;
  /** The normalised URL of the screen the link was found on; `null` for a seed. */
  from: string | null;
}

/** The part of the crawl options the queue enforces. */
export interface FrontierLimits {
  /** Known routes (Next.js patterns) that label the screens. */
  readonly routes: readonly RouteInfo[];
  /** Screens captured at most, failed navigations included. */
  readonly maxScreens: number;
  /** Instances of one route pattern captured at most (`/orgs/1`, `/orgs/2`, ...). */
  readonly maxPerRoute: number;
}

/** What `Frontier.next` found. */
export interface NextScreen {
  /** The screen to visit; `undefined` when the queue is empty. */
  item: QueuedScreen | undefined;
  /** Queued screens passed over on the way because a redirect had already captured them. */
  duplicates: readonly QueuedScreen[];
}

/**
 * The breadth-first queue and the crawl's bounds. Every screen taken from the queue becomes one
 * captured screen, so the budget counts those plus the ones still queued, except for a visit that
 * turns out to land on a screen captured before (see `markCaptured`).
 */
export class Frontier {
  private readonly queue: QueuedScreen[] = [];
  private readonly seen = new Set<string>();
  /** Route keys of the screens captured, by the URL they landed on. */
  private readonly captured = new Set<string>();
  private readonly perRoute = new Map<string, number>();
  private taken = 0;

  constructor(
    private readonly base: URL,
    private readonly opts: FrontierLimits,
  ) {}

  /** Queues `url`, or returns why it is skipped; `null` also when it was seen before (nothing to report). */
  offer(url: URL, from: string | null): SkipReason | null {
    const isInApp = isSameApp(url, this.base);
    // A route key never collides with a full href: one starts with `/`, the other with a scheme.
    const key = isInApp ? routeKey(url) : url.href;
    if (this.seen.has(key)) {
      return null;
    }
    this.seen.add(key);
    if (!isInApp) {
      return 'not-same-app';
    }
    if (isDestructiveLink(url, this.base)) {
      return 'destructive-link';
    }
    const route = routeOf(url, this.base, this.opts.routes);
    const instances = this.perRoute.get(route) ?? 0;
    if (instances >= this.opts.maxPerRoute) {
      return 'route-cap';
    }
    if (this.taken + this.queue.length >= this.opts.maxScreens) {
      return 'max-screens';
    }
    this.perRoute.set(route, instances + 1);
    this.queue.push({ url, route, from });
    return null;
  }

  /**
   * Records that the page landed on `url` and that a screen is captured for it, whichever URL was
   * requested. Returns `false` when a screen for it was captured before: that visit gives no screen,
   * so it gives its place in the budget back. `url` is also seen from now on, so a link to it later
   * is ignored like any URL seen before.
   */
  markCaptured(url: URL): boolean {
    const key = routeKey(url);
    this.seen.add(key);
    if (this.captured.has(key)) {
      this.taken -= 1;
      return false;
    }
    this.captured.add(key);
    return true;
  }

  /**
   * The next screen to visit. A queued screen whose URL a redirect has captured since it was queued
   * is not visited again; those come back as `duplicates`, so the caller can report them.
   */
  next(): NextScreen {
    let duplicates: readonly QueuedScreen[] = [];
    for (let item = this.queue.shift(); item !== undefined; item = this.queue.shift()) {
      if (!this.captured.has(routeKey(item.url))) {
        this.taken += 1;
        return { item, duplicates };
      }
      duplicates = [...duplicates, item];
    }
    return { item: undefined, duplicates };
  }
}

/**
 * The route that serves `url`: a known route, else the pattern of its path. Both are matched on the
 * path below the base path, so an app served under a `basePath` (`/app/organisations/1`) is labelled
 * `/organisations/[id]`, as its routes are written. `url` must be in the app (`isSameApp`).
 */
export function routeOf(url: URL, base: URL, routes: readonly RouteInfo[]): string {
  const path = appRelativePath(url, base);
  return matchRoute(path, routes)?.pattern ?? routePatternFromPath(path);
}
