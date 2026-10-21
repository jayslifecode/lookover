import type { RunEventBody } from '../run/events.js';
import { isSameApp, routeKey } from '../util/url.js';
import { isDestructiveLink } from './links.js';
import { matchRoute, routePatternFromPath } from './next-routes.js';
import type { RouteInfo } from './types.js';

type SkipReason = Extract<RunEventBody, { type: 'screen.skipped' }>['reason'];

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

/**
 * The breadth-first queue and the crawl's bounds. Every screen taken from the queue becomes one
 * captured screen, so the budget counts those plus the ones still queued.
 */
export class Frontier {
  private readonly queue: QueuedScreen[] = [];
  private readonly seen = new Set<string>();
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
    const route = routeOf(url, this.opts.routes);
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

  next(): QueuedScreen | undefined {
    const next = this.queue.shift();
    if (next !== undefined) {
      this.taken += 1;
    }
    return next;
  }
}

function routeOf(url: URL, routes: readonly RouteInfo[]): string {
  return matchRoute(url.pathname, routes)?.pattern ?? routePatternFromPath(url.pathname);
}
