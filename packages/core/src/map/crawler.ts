import type { Page } from 'playwright';
import type { BrowserSession, InstrumentedPage } from '../browser/session.js';
import { LookoverError } from '../errors.js';
import type { RunContext } from '../run/run-context.js';
import { shortId } from '../util/hash.js';
import { isSameApp, normaliseUrl, resolveSeed, routeKey } from '../util/url.js';
import { extractElements, MAX_ELEMENTS_PER_SCREEN } from './elements.js';
import { extractForms } from './forms.js';
import { Frontier, type QueuedScreen, routeOf } from './frontier.js';
import { describeError, navigate, settleOnBlankPage, type Timing } from './navigation.js';
import { collectTokens } from './tokens.js';
import type { ElementRef, FormInfo, RouteInfo, Screen, TokenSample, Viewport } from './types.js';

export interface CrawlOptions {
  /** The app's root: only URLs on its origin and under its path are crawled. */
  baseUrl: string;
  /** Where the crawl starts, app-relative (see `resolveSeed`). Hrefs that cannot be navigated are ignored. */
  seeds: string[];
  /** Known routes (Next.js patterns) that label the screens. */
  routes: RouteInfo[];
  /** Screens captured at most, failed navigations included. */
  maxScreens: number;
  /** Instances of one route pattern captured at most (`/orgs/1`, `/orgs/2`, ...). */
  maxPerRoute: number;
  viewport: Viewport;
  /** How long to wait for the network to go quiet after `load`. Default 800. */
  settleMs?: number;
  /** Default 15000. */
  navigationTimeoutMs?: number;
  /** Detects a lost session and logs in again. Without it, a redirect to the login page is captured as is. */
  auth?: {
    isLoginUrl: (url: URL) => boolean;
    /** Logs in again inside the session's browser context. */
    recover: () => Promise<void>;
  };
  /** Called once with the crawl page, right after it is opened and before any navigation. */
  onPage?: (ipage: InstrumentedPage) => void;
  /**
   * Inspects a captured screen on the page it was captured from, after `screen.captured` and before its
   * links are offered. Failed navigations and redirected duplicates are not inspected. What it throws
   * ends the crawl.
   */
  inspect?: (screen: Screen, ipage: InstrumentedPage) => Promise<void>;
}

type CrawlAuth = NonNullable<CrawlOptions['auth']>;
type ScreenContent = Pick<
  Screen,
  'title' | 'status' | 'error' | 'screenshot' | 'elements' | 'forms' | 'tokens' | 'links'
>;

/** Everything read from a loaded page, in the order it is read. */
interface PageCapture {
  title: string;
  png: Buffer;
  elements: ElementRef[];
  total: number;
  forms: FormInfo[];
  tokens: TokenSample[];
  hrefs: string[];
}

/** Where a screen is recorded: the URL the page landed on, and whether it was sent there. */
interface Placement extends QueuedScreen {
  redirectedFrom: string | null;
}

type LoadResult =
  | { kind: 'captured'; landed: URL; capture: PageCapture }
  /** The page landed on a screen captured before. */
  | { kind: 'duplicate'; landed: URL }
  | { kind: 'failed'; reason: string };

const DEFAULT_SETTLE_MS = 800;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 15_000;
const SCREEN_ID_LENGTH = 10;

/**
 * Walks the app breadth first from `opts.seeds` with one page of `session`, capturing each screen
 * into the App Map: title, full-page screenshot (into `ctx.evidence`), elements, forms, rendered
 * tokens and same-app links. Returns the screens in capture order.
 *
 * Bounds: a URL is visited once per route key; links off the app, destructive links, route
 * patterns already queued `maxPerRoute` times and links past the `maxScreens` budget are skipped,
 * each logged once as `screen.skipped`, checked in that order. A URL seen before is ignored.
 *
 * A page that redirects inside the app is recorded once, under the URL it landed on (`url`, `route`
 * and `id` are the landed ones, `redirectedFrom` the URL asked for), and counts toward `maxPerRoute`
 * for the route it landed on. Landing on a screen captured before, or on a route that is already
 * full, records nothing and logs `screen.skipped` as `redirected-duplicate`, which a queued URL that
 * a redirect captured first gets too. A redirect off the app fails the screen.
 *
 * Logs `screen.discovered` before each visit and `screen.captured` after it, then
 * `screen.truncated` when the screen had more controls than the extractor keeps; a captured screen is
 * then handed to `opts.inspect`, on the page still showing it, before its links are offered. A
 * navigation that fails is still a screen in the map, with status `navigation-failed`, the reason as its `error`, a
 * title of `(navigation failed: <reason>)` and nothing in it, so later stages see dead links; the
 * crawl goes on. With `opts.auth`, landing on the login page
 * from elsewhere logs `auth.lost`, logs in again and retries once; landing there again throws
 * `E_AUTH_FAILED`. Errors from the run log, the evidence store and the auth hook propagate, and so
 * does any `LookoverError`. A page that is closed or has crashed ends the crawl with `E_RUN_FAILED`
 * instead of failing every screen still queued.
 */
export async function crawl(session: BrowserSession, ctx: RunContext, opts: CrawlOptions): Promise<Screen[]> {
  const ipage = await session.newPage();
  try {
    opts.onPage?.(ipage);
    // The session's viewport may differ; each screen must be captured at the one it records.
    await ipage.page.setViewportSize({ width: opts.viewport.width, height: opts.viewport.height });
    return await new Crawler(ctx, ipage, opts).run();
  } finally {
    await ipage.close();
  }
}

class Crawler {
  private readonly base: URL;
  private readonly frontier: Frontier;
  private readonly timing: Timing;
  private hasCrashed = false;

  constructor(
    private readonly ctx: RunContext,
    private readonly ipage: InstrumentedPage,
    private readonly opts: CrawlOptions,
  ) {
    this.base = new URL(opts.baseUrl);
    this.frontier = new Frontier(this.base, opts);
    this.timing = {
      settleMs: opts.settleMs ?? DEFAULT_SETTLE_MS,
      navigationTimeoutMs: opts.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
    };
    ipage.page.once('crash', () => {
      this.hasCrashed = true;
    });
  }

  async run(): Promise<Screen[]> {
    await this.offer(
      this.opts.seeds.flatMap((seed) => resolveSeed(seed, this.base) ?? []),
      null,
    );
    let screens: Screen[] = [];
    for (let next = await this.takeNext(); next !== undefined; next = await this.takeNext()) {
      const screen = await this.visit(next);
      screens = screen === undefined ? screens : [...screens, screen];
    }
    return screens;
  }

  /** The next screen to visit, after reporting the queued ones a redirect has already captured. */
  private async takeNext(): Promise<QueuedScreen | undefined> {
    const { item, duplicates } = this.frontier.next();
    for (const duplicate of duplicates) {
      await this.skipRedirected(duplicate.url, duplicate.url);
    }
    return item;
  }

  private async skipRedirected(requested: URL, landed: URL): Promise<void> {
    await this.ctx.log.append({
      type: 'screen.skipped',
      url: requested.href,
      reason: 'redirected-duplicate',
      landed: landed.href,
    });
  }

  /** The screen captured at `item`, or `undefined` when the page landed on one captured before. */
  private async visit(item: QueuedScreen): Promise<Screen | undefined> {
    await this.ctx.log.append({ type: 'screen.discovered', url: item.url.href, from: item.from });
    const loaded = await this.load(item.url);
    if (loaded.kind === 'failed') {
      const screen = this.screenOf({ ...item, redirectedFrom: null }, failedContent(loaded.reason));
      await this.ctx.log.append({ type: 'screen.captured', screen });
      return screen;
    }
    if (loaded.kind === 'duplicate') {
      await this.skipRedirected(item.url, loaded.landed);
      return undefined;
    }

    const { capture } = loaded;
    const links = normaliseLinks(capture.hrefs, this.base);
    const screen = this.screenOf(this.placementOf(item, loaded.landed), {
      title: capture.title,
      status: 'captured',
      error: null,
      screenshot: await this.ctx.evidence.putPng(capture.png),
      elements: capture.elements,
      forms: capture.forms,
      tokens: capture.tokens,
      links: links.filter((link) => isSameApp(link, this.base)).map((link) => link.href),
    });
    await this.ctx.log.append({ type: 'screen.captured', screen });
    if (capture.total > MAX_ELEMENTS_PER_SCREEN) {
      await this.ctx.log.append({
        type: 'screen.truncated',
        screenId: screen.id,
        elements: capture.total,
        kept: capture.elements.length,
      });
    }
    await this.opts.inspect?.(screen, this.ipage);
    await this.offer(links, screen.url);
    return screen;
  }

  /** `item` as recorded when the page landed on `landed`: itself, unless a redirect sent it elsewhere. */
  private placementOf(item: QueuedScreen, landed: URL): Placement {
    if (routeKey(landed) === routeKey(item.url)) {
      return { ...item, redirectedFrom: null };
    }
    return {
      url: landed,
      route: routeOf(landed, this.base, this.opts.routes),
      from: item.from,
      redirectedFrom: item.url.href,
    };
  }

  /**
   * Opens `url` and reads the page. What the page or the browser throws becomes the reason the
   * screen failed; a `LookoverError` is the run's failure, not the page's, and is rethrown.
   */
  private async load(url: URL): Promise<LoadResult> {
    const failure = await this.open(url);
    if (failure !== null) {
      return this.failed(failure);
    }
    const landed = landedUrl(this.ipage.page, this.base);
    if (!isSameApp(landed, this.base)) {
      // Only the origin: the rest of the foreign URL may carry a token, and is not the app's to record.
      return this.failed(`redirected outside the app to ${landed.origin}`);
    }
    if (!this.frontier.markCaptured(landed, url)) {
      return { kind: 'duplicate', landed };
    }
    try {
      return { kind: 'captured', landed, capture: await capturePage(this.ipage) };
    } catch (error) {
      if (error instanceof LookoverError) {
        throw error;
      }
      return this.failed(describeError(error));
    }
  }

  /**
   * A failed screen, unless the page itself is gone: once it is closed or has crashed every later
   * navigation fails at once, so that ends the crawl. Checked after the reset to `about:blank`, which
   * gives a crash or close the moment it takes to be reported (a crash first aborts the navigation
   * in flight, and only then is reported).
   */
  private async failed(reason: string): Promise<LoadResult> {
    const isDead = (): boolean => this.ipage.page.isClosed() || this.hasCrashed;
    await settleOnBlankPage(this.ipage.page, isDead);
    if (isDead()) {
      throw new LookoverError('E_RUN_FAILED', `Browser page closed or crashed during the crawl: ${reason}`);
    }
    return { kind: 'failed', reason };
  }

  /** Navigates to `url`, logging in again once if the session was lost; returns why it failed, or `null`. */
  private async open(url: URL): Promise<string | null> {
    const { page } = this.ipage;
    const { auth } = this.opts;
    const failure = await navigate(page, url.href, this.timing);
    if (failure !== null || auth === undefined || !isSessionLost(auth, page, url)) {
      return failure;
    }
    await this.ctx.log.append({ type: 'auth.lost', url: url.href });
    await auth.recover();
    const retryFailure = await navigate(page, url.href, this.timing);
    if (retryFailure === null && isSessionLost(auth, page, url)) {
      throw new LookoverError(
        'E_AUTH_FAILED',
        `Lost the session at ${url.href}: it still lands on the login page (${page.url()}) after logging in again.`,
        'Check the login credentials, and that the app keeps the session it starts at login.',
      );
    }
    return retryFailure;
  }

  private async offer(urls: readonly URL[], from: string | null): Promise<void> {
    for (const url of urls) {
      const skipped = this.frontier.offer(url, from);
      if (skipped !== null) {
        await this.ctx.log.append({ type: 'screen.skipped', url: url.href, reason: skipped });
      }
    }
  }

  private screenOf(placement: Placement, content: ScreenContent): Screen {
    const { viewport } = this.opts;
    return {
      id: shortId(`${placement.route}|${routeKey(placement.url)}|${viewport.name}`, SCREEN_ID_LENGTH),
      url: placement.url.href,
      route: placement.route,
      title: content.title,
      status: content.status,
      error: content.error,
      viewport,
      screenshot: content.screenshot,
      elements: content.elements,
      forms: content.forms,
      tokens: content.tokens,
      links: content.links,
      redirectedFrom: placement.redirectedFrom,
      discoveredFrom: placement.from,
      capturedAt: new Date().toISOString(),
    };
  }
}

/** Where the page is now, normalised like every crawl URL so its route key compares with the queue's. */
function landedUrl(page: Page, base: URL): URL {
  const href = page.url();
  return normaliseUrl(href, base) ?? new URL(href);
}

function isSessionLost(auth: CrawlAuth, page: Page, requested: URL): boolean {
  return auth.isLoginUrl(new URL(page.url())) && !auth.isLoginUrl(requested);
}

async function capturePage(ipage: InstrumentedPage): Promise<PageCapture> {
  const { page } = ipage;
  const title = await page.title();
  const png = await page.screenshot({ fullPage: true, type: 'png' });
  const { elements, total } = await extractElements(ipage);
  const forms = await extractForms(ipage);
  const tokens = await collectTokens(page);
  const hrefs = await page.evaluate(collectHrefs);
  return { title, png, elements, total, forms, tokens, hrefs };
}

/** Runs in the page: the `href` of every `a[href]`, resolved against the document's base URL. */
function collectHrefs(): string[] {
  return Array.from(document.querySelectorAll('a[href]'), (anchor) => {
    const href = anchor.getAttribute('href') ?? '';
    return URL.canParse(href, document.baseURI) ? new URL(href, document.baseURI).href : href;
  });
}

/** The navigable links among `hrefs`, normalised and deduplicated, in document order. */
function normaliseLinks(hrefs: readonly string[], base: URL): URL[] {
  const urls = hrefs.flatMap((href) => normaliseUrl(href, base) ?? []);
  return [...new Map(urls.map((url) => [url.href, url])).values()];
}

function failedContent(reason: string): ScreenContent {
  return {
    title: `(navigation failed: ${reason})`,
    status: 'navigation-failed',
    error: reason,
    screenshot: null,
    elements: [],
    forms: [],
    tokens: [],
    links: [],
  };
}
