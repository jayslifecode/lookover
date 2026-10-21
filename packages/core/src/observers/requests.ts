import { ruleById } from '@jayslifecode/lookover-rules';
import type { Request } from 'playwright';
import type { InstrumentedPage } from '../browser/session.js';
import { occurrenceFinding } from '../findings/build.js';
import type { EvidenceItem, Finding } from '../findings/types.js';
import { routePatternFromPath } from '../map/next-routes.js';
import type { Screen } from '../map/types.js';
import type { RunContext } from '../run/run-context.js';
import { redact } from '../util/redact.js';
import { isDocumentRequest, NavigationBuffer } from './buffer.js';
import type { Observer, ObserverResult } from './types.js';

/** Requests kept per screen; further ones are dropped and counted in the evidence. */
export const MAX_REQUESTS_PER_SCREEN = 500;
/** Characters kept of each URL; a `data:` URL or a query string can be far longer than anyone reads. */
export const MAX_REQUEST_URL_LENGTH = 2000;
const SERVER_ERROR_STATUS = 500;
const CLIENT_ERROR_STATUS = 400;
const UNKNOWN_FAILURE = 'unknown failure';
/**
 * What the browser reports for the requests Lookover itself aborts (`aborted` for a blocked navigation,
 * `blockedbyclient` for a blocked call, `failed` when deciding threw; see `BrowserSession`). They are
 * Lookover's doing, not the app's, so they never become findings. A request aborted through the
 * protocol carries the suffix `.Inspector` (`net::ERR_BLOCKED_BY_CLIENT.Inspector`). `net::ERR_ABORTED`
 * is also what a page's own cancelled request reports, which is no failure either.
 */
const OWN_ABORT_TEXT = /^net::ERR_(?:ABORTED|BLOCKED_BY_CLIENT|FAILED)(?:\.Inspector)?$/;
/** The browser and its tooling ask for these on their own; a 4xx for them says nothing about the app. */
const FAVICON_PATH = '/favicon.ico';
const WELL_KNOWN_PREFIX = '/.well-known/';

const RULE_ID = {
  server: 'observers.request-server-error',
  client: 'observers.request-client-error',
  network: 'observers.request-network-error',
} as const;

/** What a listener saw of a request, kept as it was then; `entryOf` reads the rest when it is collected. */
interface SeenRequest {
  readonly request: Request;
  readonly status: number | null;
  readonly failure: string | null;
}

/** One request as the evidence shows it. */
interface RequestEntry {
  readonly method: string;
  readonly url: string;
  /** `null` for a request that failed before it was answered. */
  readonly status: number | null;
  readonly resourceType: string;
  /** The browser's error text for a request that failed, else `null`. */
  readonly failure: string | null;
  /** `null` while the browser does not know when the body finished (Chromium reports it only then). */
  readonly durationMs: number | null;
}

/** The requests of one screen that fail in the same way. */
interface RequestGroup {
  readonly ruleId: string;
  readonly key: string;
  readonly first: RequestEntry;
}

/**
 * Watches the crawl page's requests and reports the ones that came up while a screen loaded: a server
 * error (500 and up) or a request that never got an answer, and a client error (400 to 499) except
 * for the favicon and `/.well-known/` the browser asks for on its own. The requests Lookover blocks
 * itself never are findings. The same request on one screen is one occurrence, and the same request
 * on every screen is one finding: `key` is the method, host and route pattern of the URL, so
 * `/api/items/1` and `/api/items/2` share it, and the status or failure.
 *
 * The document the screen shows counts too, though its answer arrives before the navigation commits
 * (see `NavigationBuffer.recordDocument`): a page that answers 500 itself is exactly what to report.
 */
export class RequestObserver implements Observer {
  readonly name = 'requests';

  private readonly buffer = new NavigationBuffer<SeenRequest>(MAX_REQUESTS_PER_SCREEN);

  constructor(private readonly ctx: RunContext) {}

  /** The listeners only read the event and record it, so none of them can throw. */
  attach({ page }: InstrumentedPage): void {
    this.buffer.attach(page);
    page.on('response', (response) =>
      this.record({ request: response.request(), status: response.status(), failure: null }),
    );
    page.on('requestfailed', (request) =>
      this.record({ request, status: null, failure: request.failure()?.errorText ?? UNKNOWN_FAILURE }),
    );
  }

  async collect(screen: Screen): Promise<ObserverResult> {
    const { entries: seen, dropped } = this.buffer.drain();
    const entries = seen.map(entryOf);
    const groups = groupCandidates(entries);
    if (groups.length === 0) return { findings: [], worthALook: [], evidence: [] };
    const ref = await this.ctx.evidence.putJson(`requests-${screen.id}`, {
      screenId: screen.id,
      url: screen.url,
      dropped,
      entries,
    });
    const evidence: EvidenceItem = { kind: 'requests', label: `Network requests on ${screen.route}`, ref };
    return {
      findings: groups.map((group) => findingOf(group, screen, evidence)),
      worthALook: [],
      evidence: [evidence],
    };
  }

  private record(seen: SeenRequest): void {
    if (isDocumentRequest(seen.request)) {
      this.buffer.recordDocument(seen);
      return;
    }
    this.buffer.record(seen);
  }
}

/** The URL is redacted before it is cut, because a secret that straddles the cut would no longer look like one. */
function entryOf({ request, status, failure }: SeenRequest): RequestEntry {
  return {
    method: request.method(),
    url: redact(request.url()).slice(0, MAX_REQUEST_URL_LENGTH),
    status,
    resourceType: request.resourceType(),
    failure,
    durationMs: durationOf(request),
  };
}

/** `responseEnd` is relative to the start of the request, and -1 until the body has finished. */
function durationOf(request: Request): number | null {
  const { responseEnd } = request.timing();
  return responseEnd >= 0 ? Math.round(responseEnd) : null;
}

/** `host` keeps the port: two servers on one machine are two backends. A URL cut short may not parse. */
function locationOf(url: string): { host: string; pathname: string } {
  if (!URL.canParse(url)) return { host: '', pathname: url };
  const { host, pathname } = new URL(url);
  return { host, pathname };
}

/** The rule a request breaks, or `null` when it is fine (or Lookover's own doing). */
function ruleIdOf({ status, failure, url }: RequestEntry): string | null {
  if (failure !== null) return OWN_ABORT_TEXT.test(failure) ? null : RULE_ID.network;
  if (status === null) return null;
  if (status >= SERVER_ERROR_STATUS) return RULE_ID.server;
  if (status < CLIENT_ERROR_STATUS) return null;
  const { pathname } = locationOf(url);
  return pathname === FAVICON_PATH || pathname.startsWith(WELL_KNOWN_PREFIX) ? null : RULE_ID.client;
}

/** One group per key, in the order each first appeared; the group keeps the first request. */
function groupCandidates(entries: readonly RequestEntry[]): RequestGroup[] {
  const groups = new Map<string, RequestGroup>();
  for (const entry of entries) {
    const ruleId = ruleIdOf(entry);
    if (ruleId === null) continue;
    const key = keyOf(entry);
    if (!groups.has(key)) groups.set(key, { ruleId, key, first: entry });
  }
  return [...groups.values()];
}

function keyOf({ method, url, status, failure }: RequestEntry): string {
  const { host, pathname } = locationOf(url);
  return `${method} ${host}${routePatternFromPath(pathname)} → ${status ?? failure}`;
}

function findingOf({ ruleId, key, first }: RequestGroup, screen: Screen, evidence: EvidenceItem): Finding {
  const { method, url, status, failure, resourceType } = first;
  const where = `${method} ${locationOf(url).pathname}`;
  return occurrenceFinding({
    rule: ruleById(ruleId),
    key,
    occurrences: [
      {
        screenId: screen.id,
        route: screen.route,
        url: screen.url,
        viewport: screen.viewport,
        selector: null,
        measured: { method, url, status, failure, resourceType },
      },
    ],
    observed: failure === null ? `${where} answered ${status}` : `${where} failed: ${failure}`,
    evidence: [evidence],
  });
}
