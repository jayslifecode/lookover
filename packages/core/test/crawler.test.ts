import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { BrowserSession, type InstrumentedPage } from '../src/browser/session.js';
import { configSchema } from '../src/config/schema.js';
import { LookoverError } from '../src/errors.js';
import { type CrawlOptions, crawl } from '../src/map/crawler.js';
import { MAX_ELEMENTS_PER_SCREEN } from '../src/map/elements.js';
import { extractForms } from '../src/map/forms.js';
import { isFailedScreen, type Screen } from '../src/map/types.js';
import type { RunEvent } from '../src/run/events.js';
import { createRun, type RunContext } from '../src/run/run-context.js';
import { RunLog } from '../src/run/run-log.js';
import { shortId } from '../src/util/hash.js';
import { redactDeep } from '../src/util/redact.js';
import {
  eventStream,
  type FixtureServer,
  LOGIN_PATH,
  redirect,
  requireSession,
  SESSION_COOKIE,
  serveFixture,
} from './fixtures/serve.js';

// The real form extractor, wrapped so one test can make a single capture throw a LookoverError.
vi.mock('../src/map/forms.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/map/forms.js')>();
  return { ...original, extractForms: vi.fn(original.extractForms) };
});

const SITE_DIR = fileURLToPath(new URL('./fixtures/site', import.meta.url));
const REDIRECT_DIR = fileURLToPath(new URL('./fixtures/site/redirect', import.meta.url));
const BROWSER_TIMEOUT_MS = 30_000;
const VIEWPORT = { name: 'desktop', width: 1280, height: 800 };
const SSE_SETTLE_MS = 800;
const SSE_CAPTURE_BUDGET_MS = 5_000;
/** Not allowed by the network policy; the test resolver points it at the loopback. */
const FOREIGN_HOST = 'foreign.test';
const SCREEN_ID = /^[0-9a-f]{10}$/;
const NAVIGATION_FAILED = /^\(navigation failed: .+\)$/;
const ORG_IDS = [1, 2, 3, 4, 5, 6];

type SkipReason = Extract<RunEvent, { type: 'screen.skipped' }>['reason'];

interface CrawlResult {
  ctx: RunContext;
  screens: Screen[];
  events: RunEvent[];
}

function eventsOf<T extends RunEvent['type']>(
  events: readonly RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

function skippedUrls(events: readonly RunEvent[], reason: SkipReason): string[] {
  return eventsOf(events, 'screen.skipped')
    .filter((event) => event.reason === reason)
    .map((event) => event.url);
}

/** Every URL the crawl logged as discovered or skipped, in log order. */
function loggedUrls(events: readonly RunEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'screen.discovered' || event.type === 'screen.skipped' ? [event.url] : [],
  );
}

/** An origin on the loopback where nothing listens, so every connection to it is refused. */
async function refusedOrigin(): Promise<string> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
  return `http://127.0.0.1:${port}`;
}

function defined<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what}`);
  }
  return value;
}

function expectFailedNavigation(screen: Screen | undefined, reason: RegExp): void {
  const failed = defined(screen, 'a failed screen');
  expect(isFailedScreen(failed)).toBe(true);
  expect(failed.status).toBe('navigation-failed');
  expect(failed.error).toMatch(reason);
  // The title says the same for people; nothing reads it back.
  expect(failed.title).toBe(`(navigation failed: ${failed.error})`);
  expect(failed.title).toMatch(NAVIGATION_FAILED);
  expect(failed).toMatchObject({ screenshot: null, elements: [], forms: [], tokens: [], links: [] });
}

describe('crawl', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let session: BrowserSession;
  let workDir: string;
  let logoutRequests = 0;
  let eventStreamsOpened = 0;
  const openEventStream = eventStream();

  const url = (path: string): string => `${fixture.url}${path}`;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lookover-crawler-'));
    fixture = await serveFixture(SITE_DIR, {
      '/orgs/:id': (_req, _res, serveStatic) => serveStatic('/org.html'),
      '/events': (req, res, serveStatic) => {
        eventStreamsOpened += 1;
        openEventStream(req, res, serveStatic);
      },
      '/logout': (_req, _res, serveStatic) => {
        logoutRequests += 1;
        serveStatic('/logout.html');
      },
      '/home.html': requireSession,
      '/broken': (req) => req.socket.destroy(),
      '/away': (req, res) => redirect(res, `http://${FOREIGN_HOST}:${req.socket.localPort}/index.html`),
    });
    session = await BrowserSession.launch({
      viewport: VIEWPORT,
      allowHosts: [],
      testResolver: { loopbackHosts: [FOREIGN_HOST] },
      onEvent: () => {},
    });
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await session.close();
    await fixture.close();
    await rm(workDir, { recursive: true, force: true });
  }, BROWSER_TIMEOUT_MS);

  async function newRun(): Promise<RunContext> {
    const cwd = await mkdtemp(join(workDir, 'run-'));
    return createRun({ cwd, config: configSchema.parse({ baseUrl: fixture.url, interaction: 'safe' }) });
  }

  function optionsFor(overrides: Partial<CrawlOptions> = {}): CrawlOptions {
    return {
      baseUrl: fixture.url,
      seeds: ['/'],
      routes: [],
      maxScreens: 40,
      maxPerRoute: 2,
      viewport: VIEWPORT,
      ...overrides,
    };
  }

  async function crawlSite(overrides: Partial<CrawlOptions> = {}): Promise<CrawlResult> {
    const ctx = await newRun();
    const screens = await crawl(session, ctx, optionsFor(overrides));
    return { ctx, screens, events: await RunLog.read(ctx.log.file) };
  }

  describe('from the root of the site', () => {
    let result: CrawlResult;

    beforeAll(async () => {
      result = await crawlSite({ routes: [{ pattern: '/orgs/[id]', source: 'filesystem' }] });
    }, BROWSER_TIMEOUT_MS);

    test('captures every reachable same-app screen, breadth first', () => {
      expect(result.screens.map((screen) => screen.url)).toEqual([
        url('/'),
        url('/orgs.html'),
        url('/sse.html'),
        url('/orgs/1'),
        url('/orgs/2'),
      ]);
      expect(result.screens.map((screen) => screen.title)).toEqual([
        'Index',
        'Organisations',
        'Live updates',
        'Organisation',
        'Organisation',
      ]);
    });

    test('labels each screen with its matched route, or the pattern of its path', () => {
      expect(result.screens.map((screen) => screen.route)).toEqual([
        '/',
        '/orgs.html',
        '/sse.html',
        '/orgs/[id]',
        '/orgs/[id]',
      ]);
    });

    test('captures two instances of a dynamic route and skips the other four as route-cap', () => {
      expect(skippedUrls(result.events, 'route-cap')).toEqual(
        ORG_IDS.slice(2).map((id) => url(`/orgs/${id}`)),
      );
    });

    test('never requests the logout link and skips it once as destructive', () => {
      expect(logoutRequests).toBe(0);
      expect(skippedUrls(result.events, 'destructive-link')).toEqual([url('/logout')]);
    });

    test('treats /orgs.html#top as /orgs.html, without a second screen or event', () => {
      expect(result.screens.filter((screen) => screen.url === url('/orgs.html'))).toHaveLength(1);
      expect(loggedUrls(result.events).filter((logged) => logged === url('/orgs.html'))).toHaveLength(1);
      expect(loggedUrls(result.events).filter((logged) => logged.includes('#'))).toEqual([]);
    });

    test('skips another origin once as not-same-app and drops non-navigable hrefs', () => {
      expect(skippedUrls(result.events, 'not-same-app')).toEqual(['https://example.com/']);
      expect(loggedUrls(result.events).filter((logged) => logged.startsWith('mailto:'))).toEqual([]);
    });

    test('records the same-app links of each screen, deduplicated, in document order', () => {
      const [index] = result.screens;
      expect(index?.links).toEqual([url('/orgs.html'), url('/logout'), url('/sse.html')]);
    });

    test('records where each screen was discovered, with null for the seed', () => {
      expect(result.screens.map((screen) => screen.discoveredFrom)).toEqual([
        null,
        url('/'),
        url('/'),
        url('/orgs.html'),
        url('/orgs.html'),
      ]);
    });

    test('captures the elements, forms and tokens of each screen at the viewport', () => {
      const org = result.screens.find((screen) => screen.url === url('/orgs/1'));
      expect(org?.elements.map((element) => element.role)).toEqual(
        expect.arrayContaining(['textbox', 'button', 'link']),
      );
      expect(org?.forms.map((form) => form.action)).toEqual(['/orgs/save']);
      expect(org?.tokens.length).toBeGreaterThan(0);
      expect(result.screens.map((screen) => screen.viewport)).toEqual(result.screens.map(() => VIEWPORT));
    });

    test('marks every loaded screen as captured, with no error', () => {
      expect(result.screens.map(({ status, error }) => ({ status, error }))).toEqual(
        result.screens.map(() => ({ status: 'captured', error: null })),
      );
      expect(result.screens.filter(isFailedScreen)).toEqual([]);
    });

    test('gives each screen a short id derived from its route, route key and viewport', () => {
      for (const screen of result.screens) {
        const { pathname, search } = new URL(screen.url);
        expect(screen.id).toMatch(SCREEN_ID);
        expect(screen.id).toBe(shortId(`${screen.route}|${pathname}${search}|${VIEWPORT.name}`, 10));
        expect(Number.isNaN(Date.parse(screen.capturedAt))).toBe(false);
      }
    });

    test('stores a full-page screenshot file for every captured screen', async () => {
      for (const screen of result.screens) {
        const screenshot = defined(screen.screenshot, `a screenshot of ${screen.url}`);
        expect(screenshot.kind).toBe('png');
        const file = result.ctx.evidence.resolve(screenshot);
        await expect(access(file)).resolves.toBeUndefined();
        expect(relative(result.ctx.dir, file).startsWith('evidence')).toBe(true);
      }
    });

    test('logs each screen as discovered and then captured, with the full screen', () => {
      const discovered = eventsOf(result.events, 'screen.discovered');
      const captured = eventsOf(result.events, 'screen.captured');
      expect(discovered.map((event) => [event.url, event.from])).toEqual(
        result.screens.map((screen) => [screen.url, screen.discoveredFrom]),
      );
      // The log holds the screens as redaction leaves them; the screens returned are not redacted.
      expect(captured.map((event) => event.screen)).toEqual(redactDeep(result.screens));
      discovered.forEach((event, index) => {
        expect(event.seq).toBeLessThan(captured[index]?.seq ?? 0);
      });
    });

    test('does not report controls without area as truncation', () => {
      expect(eventsOf(result.events, 'screen.truncated')).toEqual([]);
    });
  });

  test('caps a dynamic route by the pattern of its path when no known route matches', async () => {
    const { screens, events } = await crawlSite({ seeds: ['/orgs.html'], maxPerRoute: 1 });

    expect(screens.map((screen) => [screen.url, screen.route])).toEqual([
      [url('/orgs.html'), '/orgs.html'],
      [url('/orgs/1'), '/orgs/[param]'],
    ]);
    expect(skippedUrls(events, 'route-cap')).toEqual(ORG_IDS.slice(1).map((id) => url(`/orgs/${id}`)));
  });

  test('stops at maxScreens and skips the rest of the queue as max-screens', async () => {
    const { screens, events } = await crawlSite({ maxScreens: 2 });

    expect(screens.map((screen) => screen.url)).toEqual([url('/'), url('/orgs.html')]);
    expect(eventsOf(events, 'screen.captured')).toHaveLength(2);
    expect(eventsOf(events, 'screen.discovered').map((event) => event.url)).toEqual([
      url('/'),
      url('/orgs.html'),
    ]);
    expect(skippedUrls(events, 'max-screens')).toEqual([
      url('/sse.html'),
      ...ORG_IDS.map((id) => url(`/orgs/${id}`)),
    ]);
  });

  test('captures a page holding a never-ending event stream within the time budget', async () => {
    const ctx = await newRun();
    const streamsBefore = eventStreamsOpened;

    const started = performance.now();
    const screens = await crawl(
      session,
      ctx,
      optionsFor({ seeds: ['/sse.html'], maxScreens: 1, settleMs: SSE_SETTLE_MS }),
    );
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(SSE_CAPTURE_BUDGET_MS);
    expect(eventStreamsOpened).toBeGreaterThan(streamsBefore);
    expect(screens.map((screen) => screen.title)).toEqual(['Live updates']);
    expect(screens[0]?.screenshot).not.toBeNull();
  });

  test('keeps a crawl with a base path inside that path, with app-relative seeds', async () => {
    const { screens, events } = await crawlSite({
      baseUrl: `${fixture.url}/sub/`,
      seeds: ['/', url('/index.html')],
    });

    expect(screens.map((screen) => screen.url)).toEqual([url('/sub'), url('/sub/page.html')]);
    expect(skippedUrls(events, 'not-same-app')).toEqual([
      url('/index.html'),
      url('/orgs.html'),
      url('/'),
      url('/subway.html'),
      'https://example.com/',
    ]);
  });

  test('matches routes below a base path', async () => {
    const { screens } = await crawlSite({
      baseUrl: `${fixture.url}/sub/`,
      seeds: ['/', '/page.html'],
      routes: [{ pattern: '/[name]', source: 'filesystem' }],
    });

    expect(screens.map((screen) => [screen.url, screen.route])).toEqual([
      [url('/sub'), '/'],
      [url('/sub/page.html'), '/[name]'],
    ]);
  });

  test('never visits a destructive seed', async () => {
    const { screens, events } = await crawlSite({
      seeds: ['/logout', '/orgs.html?action=delete', '/users/sign_out', '/logoff'],
    });

    expect(screens).toEqual([]);
    expect(skippedUrls(events, 'destructive-link')).toEqual([
      url('/logout'),
      url('/orgs.html?action=delete'),
      url('/users/sign_out'),
      url('/logoff'),
    ]);
    expect(logoutRequests).toBe(0);
  });

  test('judges destructive links by their app-relative path, so a base path like /reset/ is crawled', async () => {
    const { screens, events } = await crawlSite({ baseUrl: `${fixture.url}/reset/`, seeds: ['/'] });

    expect(screens.map((screen) => [screen.url, screen.title])).toEqual([
      [url('/reset'), 'Reset tool'],
      [url('/reset/page.html'), 'Reset tool page'],
    ]);
    expect(skippedUrls(events, 'destructive-link')).toEqual([url('/reset/logout')]);
  });

  test('reports truncation when a screen has more controls than the extractor keeps', async () => {
    const count = MAX_ELEMENTS_PER_SCREEN + 10;

    const { screens, events } = await crawlSite({ seeds: [`/many.html?count=${count}`], maxScreens: 1 });

    const [screen] = screens;
    expect(screen?.elements).toHaveLength(MAX_ELEMENTS_PER_SCREEN);
    expect(eventsOf(events, 'screen.truncated')).toEqual([
      expect.objectContaining({ screenId: screen?.id, elements: count, kept: MAX_ELEMENTS_PER_SCREEN }),
    ]);
  });

  test('calls onPage once before the first navigation and inspect once per captured screen, before offering links', async () => {
    const ctx = await newRun();
    const timeline: string[] = [];
    ctx.log.subscribe((event) => {
      if (event.type === 'screen.captured') {
        timeline.push(`captured ${event.screen.url}`);
      } else if (event.type === 'screen.skipped') {
        timeline.push(`skipped ${event.url}`);
      }
    });
    const opened: { url: string; ipage: InstrumentedPage }[] = [];
    const inspected: { screen: string; page: string; ipage: InstrumentedPage }[] = [];

    const screens = await crawl(
      session,
      ctx,
      optionsFor({
        seeds: ['/broken', '/'],
        maxScreens: 3,
        onPage: (ipage) => {
          opened.push({ url: ipage.page.url(), ipage });
        },
        inspect: async (screen, ipage) => {
          timeline.push(`inspect ${screen.url}`);
          inspected.push({ screen: screen.url, page: ipage.page.url(), ipage });
        },
      }),
    );

    expect(opened.map((entry) => entry.url)).toEqual(['about:blank']);
    expect(screens.map((screen) => [screen.url, screen.status])).toEqual([
      [url('/broken'), 'navigation-failed'],
      [url('/'), 'captured'],
      [url('/orgs.html'), 'captured'],
    ]);
    // The failed screen is not inspected; each captured one is, on the page it was captured from.
    expect(inspected.map(({ screen, page }) => [screen, page])).toEqual([
      [url('/'), url('/')],
      [url('/orgs.html'), url('/orgs.html')],
    ]);
    expect(inspected.every((entry) => entry.ipage === opened[0]?.ipage)).toBe(true);
    // The index's links are offered after it is inspected: off-app, destructive, then over budget.
    expect(timeline.slice(0, 8)).toEqual([
      `captured ${url('/broken')}`,
      `captured ${url('/')}`,
      `inspect ${url('/')}`,
      'skipped https://example.com/',
      `skipped ${url('/logout')}`,
      `skipped ${url('/sse.html')}`,
      `captured ${url('/orgs.html')}`,
      `inspect ${url('/orgs.html')}`,
    ]);
  });

  describe('when the session is lost', () => {
    const isLoginUrl = (candidate: URL): boolean => candidate.pathname === LOGIN_PATH;

    async function signIn(): Promise<void> {
      await session.context.addCookies([{ ...SESSION_COOKIE, url: fixture.url }]);
    }

    test('logs in again once and captures the screen it was sent away from', async () => {
      await session.context.clearCookies();
      await signIn();
      const ctx = await newRun();
      let signingOut: Promise<void> | undefined;
      ctx.log.subscribe((event) => {
        if (event.type === 'screen.captured' && signingOut === undefined) {
          signingOut = session.context.clearCookies();
        }
      });
      let recoveries = 0;
      const recover = async (): Promise<void> => {
        recoveries += 1;
        await signIn();
      };

      const screens = await crawl(
        session,
        ctx,
        optionsFor({ seeds: ['/home.html'], auth: { isLoginUrl, recover } }),
      );
      await signingOut;

      const events = await RunLog.read(ctx.log.file);
      expect(screens.map((screen) => [screen.url, screen.title])).toEqual([
        [url('/home.html'), 'Home'],
        [url('/home.html?tab=2'), 'Home'],
      ]);
      expect(recoveries).toBe(1);
      expect(eventsOf(events, 'auth.lost').map((event) => event.url)).toEqual([url('/home.html?tab=2')]);
      expect(
        events
          .filter((event) => ['screen.discovered', 'auth.lost', 'screen.captured'].includes(event.type))
          .map((event) => event.type),
      ).toEqual([
        'screen.discovered',
        'screen.captured',
        'screen.discovered',
        'auth.lost',
        'screen.captured',
      ]);
    });

    test('fails with E_AUTH_FAILED when logging in again still lands on the login page', async () => {
      await session.context.clearCookies();
      const ctx = await newRun();
      let recoveries = 0;
      const recover = async (): Promise<void> => {
        recoveries += 1;
      };

      const crawling = crawl(
        session,
        ctx,
        optionsFor({ seeds: ['/home.html'], auth: { isLoginUrl, recover } }),
      );

      await expect(crawling).rejects.toBeInstanceOf(LookoverError);
      await expect(crawling).rejects.toMatchObject({ code: 'E_AUTH_FAILED' });
      const events = await RunLog.read(ctx.log.file);
      expect(recoveries).toBe(1);
      expect(eventsOf(events, 'auth.lost')).toHaveLength(1);
      expect(eventsOf(events, 'screen.captured')).toEqual([]);
    });

    test('captures the login page itself as an ordinary screen', async () => {
      await session.context.clearCookies();
      const recover = (): Promise<void> => Promise.reject(new Error('the login page is not a lost session'));

      const { screens, events } = await crawlSite({ seeds: [LOGIN_PATH], auth: { isLoginUrl, recover } });

      expect(screens.map((screen) => screen.title)).toEqual(['Log in']);
      expect(eventsOf(events, 'auth.lost')).toEqual([]);
    });
  });

  describe('when a navigation fails', () => {
    test('records a refused connection as a captured screen without a screenshot', async () => {
      const deadOrigin = await refusedOrigin();

      const { screens, events } = await crawlSite({ baseUrl: deadOrigin, seeds: ['/', '/second'] });

      expect(screens.map((screen) => screen.url)).toEqual([`${deadOrigin}/`, `${deadOrigin}/second`]);
      for (const screen of screens) {
        expectFailedNavigation(screen, /ERR_CONNECTION_REFUSED/);
      }
      expect(eventsOf(events, 'screen.captured').map((event) => event.screen)).toEqual(screens);
    });

    test('keeps crawling with the same page after a dead link', async () => {
      const { screens } = await crawlSite({ seeds: ['/broken', '/orgs.html'], maxScreens: 2 });

      expectFailedNavigation(screens[0], /ERR_EMPTY_RESPONSE/);
      expect(screens[1]?.title).toBe('Organisations');
      expect(screens[1]?.screenshot).not.toBeNull();
    });

    test('records a redirect off the allowed hosts as a failed navigation', async () => {
      const { screens } = await crawlSite({ seeds: ['/away'], maxScreens: 1 });

      expectFailedNavigation(screens[0], /about:blank|interrupted|ERR_/);
    });
  });

  describe('when a page redirects', () => {
    const SECRET_QUERY = 'token=abc123secret';
    let app: FixtureServer;
    let elsewhere: FixtureServer;

    beforeAll(async () => {
      elsewhere = await serveFixture(REDIRECT_DIR);
      app = await serveFixture(REDIRECT_DIR, {
        '/': (_req, res) => redirect(res, '/home.html'),
        '/away': (_req, res) => redirect(res, `${elsewhere.url}/home.html?${SECRET_QUERY}`),
        // A login redirect that remembers where it came from, as NextAuth's `callbackUrl` does.
        '/private/:page': (req, res) => {
          const page = new URL(req.url ?? '/', app.url).pathname.split('/').pop();
          redirect(res, `/login.html?next=${page}`);
        },
      });
    }, BROWSER_TIMEOUT_MS);

    afterAll(async () => {
      await app.close();
      await elsewhere.close();
    }, BROWSER_TIMEOUT_MS);

    const crawlApp = (seeds: string[]): Promise<CrawlResult> =>
      crawlSite({ baseUrl: app.url, seeds, maxScreens: 5 });

    test('records a redirected screen under the URL it landed on', async () => {
      const { screens, events } = await crawlApp(['/']);

      expect(screens).toHaveLength(1);
      const [screen] = screens;
      expect(screen).toMatchObject({
        url: `${app.url}/home.html`,
        route: '/home.html',
        redirectedFrom: `${app.url}/`,
        title: 'Redirect target',
        status: 'captured',
        discoveredFrom: null,
      });
      expect(screen?.id).toBe(shortId(`/home.html|/home.html|${VIEWPORT.name}`, 10));
      expect(screen?.links).toEqual([`${app.url}/`]);
      expect(eventsOf(events, 'screen.discovered').map((event) => event.url)).toEqual([`${app.url}/`]);
      expect(eventsOf(events, 'screen.skipped')).toEqual([]);
    });

    test('leaves redirectedFrom null for a page that loads where it was asked for', async () => {
      const { screens } = await crawlApp(['/home.html']);

      expect(screens.map((screen) => [screen.url, screen.redirectedFrom])).toEqual([
        [`${app.url}/home.html`, null],
      ]);
    });

    test('skips a redirect to a screen already captured', async () => {
      const { screens, events } = await crawlApp(['/home.html', '/']);

      expect(screens.map((screen) => [screen.url, screen.redirectedFrom])).toEqual([
        [`${app.url}/home.html`, null],
      ]);
      expect(eventsOf(events, 'screen.skipped')).toEqual([
        expect.objectContaining({
          url: `${app.url}/`,
          reason: 'redirected-duplicate',
          landed: `${app.url}/home.html`,
        }),
      ]);
      expect(eventsOf(events, 'screen.discovered').map((event) => event.url)).toEqual([
        `${app.url}/home.html`,
        `${app.url}/`,
      ]);
    });

    test('skips a queued screen that a redirect already captured, and reports it', async () => {
      const { screens, events } = await crawlApp(['/', '/home.html']);

      expect(screens.map((screen) => [screen.url, screen.redirectedFrom])).toEqual([
        [`${app.url}/home.html`, `${app.url}/`],
      ]);
      expect(eventsOf(events, 'screen.skipped')).toEqual([
        expect.objectContaining({
          url: `${app.url}/home.html`,
          reason: 'redirected-duplicate',
          landed: `${app.url}/home.html`,
        }),
      ]);
      expect(eventsOf(events, 'screen.discovered').map((event) => event.url)).toEqual([`${app.url}/`]);
    });

    test.each([1, 2])(
      'maps pages that redirect to a login URL carrying their own path at most maxPerRoute (%i) times',
      async (maxPerRoute) => {
        const pages = ['a', 'b', 'c'];

        const { screens, events } = await crawlSite({
          baseUrl: app.url,
          seeds: pages.map((page) => `/private/${page}`),
          maxScreens: 5,
          maxPerRoute,
        });

        const mapped = pages.slice(0, maxPerRoute);
        const skipped = pages.slice(maxPerRoute);
        expect(screens.map((screen) => [screen.url, screen.route, screen.redirectedFrom])).toEqual(
          mapped.map((page) => [
            `${app.url}/login.html?next=${page}`,
            '/login.html',
            `${app.url}/private/${page}`,
          ]),
        );
        expect(eventsOf(events, 'screen.skipped')).toEqual(
          skipped.map((page) =>
            expect.objectContaining({
              url: `${app.url}/private/${page}`,
              reason: 'redirected-duplicate',
              landed: `${app.url}/login.html?next=${page}`,
            }),
          ),
        );
      },
    );

    test('a redirect off the app is a failed screen without the foreign URL', async () => {
      const { screens, events } = await crawlApp(['/away']);

      expect(screens).toHaveLength(1);
      expectFailedNavigation(screens[0], /^redirected outside the app to /);
      expect(screens[0]).toMatchObject({
        url: `${app.url}/away`,
        error: `redirected outside the app to ${elsewhere.url}`,
        redirectedFrom: null,
      });
      expect(JSON.stringify([screens, events])).not.toContain(SECRET_QUERY);
    });

    test('goes on crawling after a redirect off the app', async () => {
      const { screens } = await crawlApp(['/away', '/home.html']);

      expect(screens.map((screen) => [screen.url, screen.status])).toEqual([
        [`${app.url}/away`, 'navigation-failed'],
        [`${app.url}/home.html`, 'captured'],
      ]);
    });
  });

  describe('when the browser page dies', () => {
    const DEAD_PAGE = /^Browser page closed or crashed during the crawl: /;

    /** A session of its own, so killing its page or context leaves the shared one alone. */
    async function withOwnSession(run: (own: BrowserSession) => Promise<void>): Promise<void> {
      const own = await BrowserSession.launch({ viewport: VIEWPORT, allowHosts: [], onEvent: () => {} });
      try {
        await run(own);
      } finally {
        await own.close();
      }
    }

    /** Runs `kill` once, from the log, right after the first screen is captured. */
    function afterFirstCapture(ctx: RunContext, kill: () => Promise<unknown>): () => Promise<unknown> {
      let killing: Promise<unknown> | undefined;
      ctx.log.subscribe((event) => {
        if (event.type === 'screen.captured' && killing === undefined) {
          killing = kill();
        }
      });
      return () => killing ?? Promise.resolve();
    }

    async function crashCrawlPage(own: BrowserSession): Promise<void> {
      const [page] = own.context.pages();
      const cdp = await own.context.newCDPSession(defined(page, 'the crawl page'));
      // The renderer dies before it can answer.
      await cdp.send('Page.crash').catch(() => undefined);
    }

    test('rejects with E_RUN_FAILED instead of failing every queued screen when the context closes', async () => {
      await withOwnSession(async (own) => {
        const ctx = await newRun();
        const killed = afterFirstCapture(ctx, () => own.context.close());

        const crawling = crawl(own, ctx, optionsFor());

        await expect(crawling).rejects.toBeInstanceOf(LookoverError);
        await expect(crawling).rejects.toMatchObject({
          code: 'E_RUN_FAILED',
          message: expect.stringMatching(DEAD_PAGE),
        });
        await killed();
        const events = await RunLog.read(ctx.log.file);
        expect(eventsOf(events, 'screen.captured').map((event) => event.screen.title)).toEqual(['Index']);
      });
    });

    test('rejects with E_RUN_FAILED when the page crashes', async () => {
      await withOwnSession(async (own) => {
        const ctx = await newRun();
        const killed = afterFirstCapture(ctx, () => crashCrawlPage(own));

        const crawling = crawl(own, ctx, optionsFor());

        await expect(crawling).rejects.toMatchObject({
          code: 'E_RUN_FAILED',
          message: expect.stringMatching(DEAD_PAGE),
        });
        await killed();
        const events = await RunLog.read(ctx.log.file);
        const screens = eventsOf(events, 'screen.captured').map((event) => event.screen);
        expect(screens.filter(isFailedScreen)).toEqual([]);
      });
    });
  });

  describe('when something other than the page fails', () => {
    test('rethrows a LookoverError raised while capturing instead of recording a failed screen', async () => {
      const injected = new LookoverError('E_RUN_FAILED', 'injected while extracting forms');
      vi.mocked(extractForms).mockRejectedValueOnce(injected);
      const ctx = await newRun();

      const crawling = crawl(session, ctx, optionsFor({ seeds: ['/orgs.html'], maxScreens: 1 }));

      await expect(crawling).rejects.toBe(injected);
      expect(eventsOf(await RunLog.read(ctx.log.file), 'screen.captured')).toEqual([]);
    });

    test('propagates an evidence store failure instead of recording a failed screen', async () => {
      const ctx = await newRun();
      // A file where the evidence directory should be: storing the screenshot fails with ENOTDIR.
      const evidenceDir = join(ctx.dir, 'evidence');
      await rm(evidenceDir, { recursive: true, force: true });
      await writeFile(evidenceDir, 'not a directory');

      const crawling = crawl(session, ctx, optionsFor({ seeds: ['/orgs.html'], maxScreens: 1 }));

      await expect(crawling).rejects.toMatchObject({ code: 'ENOTDIR' });
      expect(eventsOf(await RunLog.read(ctx.log.file), 'screen.captured')).toEqual([]);
    });
  });
});
