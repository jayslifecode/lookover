import type { Page } from 'playwright';
import type { BrowserSession, InstrumentedPage } from '../browser/session.js';
import { LookoverError } from '../errors.js';
import type { RunEventBody } from '../run/events.js';
import type { RunContext } from '../run/run-context.js';
import { shortId } from '../util/hash.js';
import { isSameApp, normaliseUrl, resolveSeed, routeKey } from '../util/url.js';
import { extractElements, MAX_ELEMENTS_PER_SCREEN } from './elements.js';
import { extractForms } from './forms.js';
import { isDestructiveLink } from './links.js';
import { matchRoute, routePatternFromPath } from './next-routes.js';
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
}

type CrawlAuth = NonNullable<CrawlOptions['auth']>;
type SkipReason = Extract<RunEventBody, { type: 'screen.skipped' }>['reason'];
type ScreenContent = Pick<
  Screen,
  'title' | 'status' | 'error' | 'screenshot' | 'elements' | 'forms' | 'tokens' | 'links'
>;

interface QueuedScreen {
  url: URL;
  route: string;
  /** The normalised URL of the screen the link was found on; `null` for a seed. */
  from: string | null;
}

interface Timing {
  settleMs: number;
  navigationTimeoutMs: number;
}

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

type LoadResult = { kind: 'captured'; capture: PageCapture } | { kind: 'failed'; reason: string };

const DEFAULT_SETTLE_MS = 800;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 15_000;
const FONTS_READY_TIMEOUT_MS = 2_000;
/** `about:blank` commits in milliseconds; this only bounds a page that has stopped responding. */
const BLANK_PAGE_TIMEOUT_MS = 5_000;
const SCREEN_ID_LENGTH = 10;
const BLANK_PAGE = 'about:blank';
const BROWSER_ERROR_PAGE_PREFIX = 'chrome-error://';

/**
 * Walks the app breadth first from `opts.seeds` with one page of `session`, capturing each screen
 * into the App Map: title, full-page screenshot (into `ctx.evidence`), elements, forms, rendered
 * tokens and same-app links. Returns the screens in capture order.
 *
 * Bounds: a URL is visited once per route key; links off the app, destructive links, route
 * patterns already queued `maxPerRoute` times and links past the `maxScreens` budget are skipped,
 * each logged once as `screen.skipped`, checked in that order. A URL seen before is ignored.
 *
 * Logs `screen.discovered` before each visit and `screen.captured` after it, then
 * `screen.truncated` when the screen had more controls than the extractor keeps. A navigation that
 * fails is still a screen in the map, with status `navigation-failed`, the reason as its `error`, a
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
    for (let next = this.frontier.next(); next !== undefined; next = this.frontier.next()) {
      screens = [...screens, await this.visit(next)];
    }
    return screens;
  }

  private async visit(item: QueuedScreen): Promise<Screen> {
    await this.ctx.log.append({ type: 'screen.discovered', url: item.url.href, from: item.from });
    const loaded = await this.load(item.url);
    if (loaded.kind === 'failed') {
      const screen = this.screenOf(item, failedContent(loaded.reason));
      await this.ctx.log.append({ type: 'screen.captured', screen });
      return screen;
    }

    const { capture } = loaded;
    const links = normaliseLinks(capture.hrefs, this.base);
    const screen = this.screenOf(item, {
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
    await this.offer(links, screen.url);
    return screen;
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
    try {
      return { kind: 'captured', capture: await capturePage(this.ipage) };
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

  private screenOf(item: QueuedScreen, content: ScreenContent): Screen {
    const { viewport } = this.opts;
    return {
      id: shortId(`${item.route}|${routeKey(item.url)}|${viewport.name}`, SCREEN_ID_LENGTH),
      url: item.url.href,
      route: item.route,
      title: content.title,
      status: content.status,
      error: content.error,
      viewport,
      screenshot: content.screenshot,
      elements: content.elements,
      forms: content.forms,
      tokens: content.tokens,
      links: content.links,
      discoveredFrom: item.from,
      capturedAt: new Date().toISOString(),
    };
  }
}

/**
 * The breadth-first queue and the crawl's bounds. Every screen taken from the queue becomes one
 * captured screen, so the budget counts those plus the ones still queued.
 */
class Frontier {
  private readonly queue: QueuedScreen[] = [];
  private readonly seen = new Set<string>();
  private readonly perRoute = new Map<string, number>();
  private taken = 0;

  constructor(
    private readonly base: URL,
    private readonly opts: Pick<CrawlOptions, 'routes' | 'maxScreens' | 'maxPerRoute'>,
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

/** Loads `url` and lets it settle; returns why the navigation failed, or `null`. A `LookoverError` is rethrown. */
async function navigate(page: Page, url: string, timing: Timing): Promise<string | null> {
  try {
    await page.goto(url, { waitUntil: 'load', timeout: timing.navigationTimeoutMs });
  } catch (error) {
    if (error instanceof LookoverError) {
      throw error;
    }
    return describeError(error);
  }
  await settle(page, timing.settleMs);
  return landingFailure(page.url());
}

/**
 * Best effort, never throws: a page that holds a connection open (server-sent events, polling) never
 * goes quiet, and one that navigates itself while its fonts load destroys the context the wait runs
 * in. Whatever the page then is, the capture reads it, and fails the screen if it cannot.
 */
async function settle(page: Page, settleMs: number): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: settleMs }).catch(() => undefined);
  await atMost(FONTS_READY_TIMEOUT_MS, page.evaluate(waitForFonts));
}

/** Runs in the page. */
function waitForFonts(): Promise<void> {
  return document.fonts.ready.then(() => undefined);
}

/** Waits for `task` until it settles (either way) or `ms` have passed. */
async function atMost(ms: number, task: Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([task.catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A navigation that did not throw can still have gone nowhere: the session sends a frame that left
 * the allowed hosts to `about:blank`, and Chromium shows some network failures as an error page.
 */
function landingFailure(landed: string): string | null {
  if (landed === BLANK_PAGE) {
    return `ended on ${BLANK_PAGE}, where the session sends pages that leave the allowed hosts`;
  }
  if (landed.startsWith(BROWSER_ERROR_PAGE_PREFIX)) {
    return `ended on the browser error page ${landed}`;
  }
  return null;
}

/**
 * Leaves the page on `about:blank` with nothing in flight. A failed page can still be busy: Chromium
 * commits its error page for a failed navigation only after `goto` has thrown, and Playwright calls a
 * navigation interrupted as soon as another document commits while the interrupted one still commits
 * after it. Either would interrupt the next screen's navigation, so this asks for `about:blank` and,
 * when that request was interrupted, waits until it is the page, which puts every earlier commit
 * behind it. A dead page has nothing left to commit and would never get there, so it is not waited
 * on. Best effort: if the page cannot get there, the next navigation reports its own failure.
 */
async function settleOnBlankPage(page: Page, isDead: () => boolean): Promise<void> {
  const options = { timeout: BLANK_PAGE_TIMEOUT_MS };
  const hasLanded = await page.goto(BLANK_PAGE, options).then(
    () => true,
    () => false,
  );
  if (hasLanded || isDead()) {
    return;
  }
  await page.waitForURL((url) => url.href === BLANK_PAGE, options).catch(() => undefined);
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

/** The first line of the error's message: Playwright appends a multi-line call log. */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split('\n', 1)[0]?.trim() ?? '';
  return firstLine === '' ? 'unknown error' : firstLine;
}
