import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  type Page,
  type Request,
  type Route,
  type WebSocketRoute,
} from 'playwright';
import type { Viewport } from '../map/types.js';
import type { RunEventBody } from '../run/events.js';
import {
  classifyRequest,
  launchArgs,
  type NetworkPolicy,
  networkHost,
  type RequestKind,
  type ResolverTestHooks,
  type Verdict,
} from './network-policy.js';

/** The run events a session emits; the engine forwards them to the run log unchanged. */
export type SessionEvent = Extract<RunEventBody, { type: 'host.observed' | 'request.blocked' }>;

type HostKind = Extract<SessionEvent, { type: 'host.observed' }>['kind'];
type BlockReason = Extract<Verdict, { kind: 'block' }>['reason'];

export interface SessionOptions {
  headless?: boolean;
  viewport: Viewport;
  storageStatePath?: string;
  allowHosts: string[];
  onEvent: (event: SessionEvent) => void;
  /** Test-only resolver overrides (see `ResolverTestHooks`); the engine never sets it. */
  testResolver?: ResolverTestHooks;
}

/** A page plus the CDP session later stages instrument (accessibility tree, forced states). */
export interface InstrumentedPage {
  page: Page;
  cdp: CDPSession;
  close(): Promise<void>;
}

const ALL_REQUESTS = '**/*';
const ALL_WEBSOCKETS = /.*/;
const BLANK_PAGE = 'about:blank';
const APP_CALL_RESOURCE_TYPES: ReadonlySet<string> = new Set(['fetch', 'xhr', 'websocket', 'eventsource']);
/**
 * Chromium commits an error page for a navigation aborted as `blockedbyclient`, which would take
 * the explorer off the app; `aborted` leaves the page where it was. Other requests use
 * `blockedbyclient`, which names the cause in the page's network errors.
 */
const NAVIGATION_ABORT_CODE = 'aborted';
const REQUEST_ABORT_CODE = 'blockedbyclient';
/** Used when deciding a request threw: it must neither go out undecided nor hang. */
const FAIL_CLOSED_ABORT_CODE = 'failed';
const WS_POLICY_VIOLATION = 1008;
const WS_BLOCKED_REASON = 'Blocked by Lookover';

/**
 * One browser and context that enforce the network policy (see `network-policy.ts`) on every
 * request: provider calls and navigations off the allowed hosts are blocked, everything else is let
 * through and its host recorded for the backend-confirmation step.
 *
 * Layers:
 * - `context.route` blocks what it sees, and fails closed if deciding throws.
 * - `context.routeWebSocket` does the same for websockets.
 * - The host-resolver rules, with the proxy off, make providers unresolvable. That also covers
 *   redirect hops, which the route never sees; `requestfailed` reports those hops.
 * - Any frame that still lands on a host that is not allowed is sent to `about:blank`.
 * - Service workers are blocked, because their requests bypass `context.route`.
 */
export class BrowserSession {
  private hostKinds: ReadonlyMap<string, ReadonlySet<HostKind>> = new Map();
  private blockedUrls: ReadonlySet<string> = new Set();

  private constructor(
    private readonly browser: Browser,
    readonly context: BrowserContext,
    private readonly policy: NetworkPolicy,
    private readonly onEvent: SessionOptions['onEvent'],
  ) {}

  static async launch(opts: SessionOptions): Promise<BrowserSession> {
    const policy: NetworkPolicy = { allowHosts: Object.freeze([...opts.allowHosts]) };
    const browser = await chromium.launch({
      headless: opts.headless ?? true,
      args: launchArgs(policy.allowHosts, opts.testResolver),
    });
    try {
      const context = await browser.newContext({
        viewport: { width: opts.viewport.width, height: opts.viewport.height },
        serviceWorkers: 'block',
        ...(opts.storageStatePath === undefined ? {} : { storageState: opts.storageStatePath }),
      });
      const session = new BrowserSession(browser, context, policy, opts.onEvent);
      await session.install();
      return session;
    } catch (error) {
      // The launch error is the one worth surfacing; a failure to close on top of it adds nothing.
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  async newPage(): Promise<InstrumentedPage> {
    const page = await this.context.newPage();
    try {
      const cdp = await this.context.newCDPSession(page);
      return { page, cdp, close: () => page.close() };
    } catch (error) {
      await page.close();
      throw error;
    }
  }

  /** Every distinct host a request was let through to (allowed or observed), sorted. */
  observedHosts(): string[] {
    return [...this.hostKinds.keys()].toSorted();
  }

  async close(): Promise<void> {
    try {
      await this.context.close();
    } finally {
      await this.browser.close();
    }
  }

  private async install(): Promise<void> {
    this.context.on('request', (request) => this.observe(request));
    this.context.on('requestfailed', (request) => this.reportFailedProviderHop(request));
    this.context.on('page', (page) => this.containFrames(page));
    await this.context.route(ALL_REQUESTS, (route) => this.enforce(route));
    await this.context.routeWebSocket(ALL_WEBSOCKETS, (ws) => this.enforceWebSocket(ws));
  }

  private enforce(route: Route): Promise<void> {
    return this.failClosed(
      route.request().url(),
      () => this.decide(route),
      () => route.abort(FAIL_CLOSED_ABORT_CODE),
    );
  }

  private async decide(route: Route): Promise<void> {
    const request = route.request();
    const { verdict } = assess(request.url(), requestKind(request), this.policy);
    if (verdict.kind !== 'block') {
      await route.continue();
      return;
    }
    await route.abort(request.isNavigationRequest() ? NAVIGATION_ABORT_CODE : REQUEST_ABORT_CODE);
    this.reportBlocked(request.url(), verdict.reason);
  }

  private enforceWebSocket(ws: WebSocketRoute): Promise<void> {
    return this.failClosed(
      ws.url(),
      () => this.decideWebSocket(ws),
      () => ws.close({ code: WS_POLICY_VIOLATION, reason: WS_BLOCKED_REASON }),
    );
  }

  private async decideWebSocket(ws: WebSocketRoute): Promise<void> {
    const { verdict, host } = assess(ws.url(), 'fetch', this.policy);
    if (verdict.kind === 'block') {
      await ws.close({ code: WS_POLICY_VIOLATION, reason: WS_BLOCKED_REASON });
      this.reportBlocked(ws.url(), verdict.reason);
      return;
    }
    if (host !== null) {
      this.recordHost(host, 'app-call');
    }
    ws.connectToServer();
  }

  /**
   * Runs `decide`; if it throws, the request is refused instead of left undecided (which would hang
   * it), and reported. The refusal is best effort: Playwright marks a route handled before it sends
   * `continue()`, so when `continue()` itself throws the request can no longer be aborted; it stays
   * paused, never reaching the network, until its page closes. A throwing policy check never gets
   * here: `assess` already turns it into a block.
   */
  private async failClosed(
    url: string,
    decide: () => Promise<void>,
    refuse: () => Promise<void>,
  ): Promise<void> {
    try {
      await decide();
    } catch {
      await refuse().catch(() => undefined);
      this.reportBlocked(url, 'host-not-allowed');
    }
  }

  /** Fires for redirect hops too, which `enforce` never sees. */
  private observe(request: Request): void {
    const kind = requestKind(request);
    const { verdict, host } = assess(request.url(), kind, this.policy);
    // Blocked hops behind a redirect are reported once they have failed (`reportFailedProviderHop`)
    // or landed in a frame (`containFrames`), never on the strength of the verdict alone.
    if (verdict.kind === 'block' || host === null) {
      return;
    }
    this.recordHost(host, kind === 'navigation' ? 'navigation' : 'app-call');
  }

  /** A provider hop behind a redirect never reaches `enforce`; the DNS rules make it fail. */
  private reportFailedProviderHop(request: Request): void {
    if (request.redirectedFrom() === null) {
      return;
    }
    const { verdict } = assess(request.url(), requestKind(request), this.policy);
    if (verdict.kind === 'block' && verdict.reason === 'provider') {
      this.reportBlocked(request.url(), verdict.reason);
    }
  }

  /** Any frame (main or iframe) that lands on a host that is not allowed is sent to a blank page. */
  private containFrames(page: Page): void {
    page.on('framenavigated', (frame) => {
      const url = frame.url();
      if (!URL.canParse(url)) {
        return;
      }
      const { verdict } = assess(url, 'navigation', this.policy);
      if (verdict.kind !== 'block') {
        return;
      }
      this.reportBlocked(url, verdict.reason);
      // Best effort: the frame may be detaching, or already navigating somewhere else.
      void frame.goto(BLANK_PAGE).catch(() => undefined);
    });
  }

  private recordHost(host: string, kind: HostKind): void {
    const kinds = this.hostKinds.get(host) ?? new Set<HostKind>();
    if (kinds.has(kind)) {
      return;
    }
    this.hostKinds = new Map([...this.hostKinds, [host, new Set([...kinds, kind])]]);
    this.emit({ type: 'host.observed', host, kind });
  }

  private reportBlocked(url: string, reason: BlockReason): void {
    if (this.blockedUrls.has(url)) {
      return;
    }
    this.blockedUrls = new Set([...this.blockedUrls, url]);
    this.emit({ type: 'request.blocked', url, reason });
  }

  /** A throwing listener must not stall request handling, so its error is re-raised outside it. */
  private emit(event: SessionEvent): void {
    try {
      this.onEvent(event);
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}

function requestKind(request: Request): RequestKind {
  if (request.isNavigationRequest()) {
    return 'navigation';
  }
  return APP_CALL_RESOURCE_TYPES.has(request.resourceType()) ? 'fetch' : 'subresource';
}

/**
 * The verdict for a request, failing closed: a URL that cannot be parsed cannot be checked, and a
 * policy check that throws must not let the request through, so both are refused.
 */
function assess(
  rawUrl: string,
  kind: RequestKind,
  policy: NetworkPolicy,
): { verdict: Verdict; host: string | null } {
  const refused = { verdict: { kind: 'block', reason: 'host-not-allowed' }, host: null } as const;
  const url = URL.parse(rawUrl);
  if (url === null) {
    return refused;
  }
  try {
    return { verdict: classifyRequest(url, kind, policy), host: networkHost(url) };
  } catch {
    return refused;
  }
}
