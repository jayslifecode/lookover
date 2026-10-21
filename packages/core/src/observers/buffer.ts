import type { Frame, Page, Request } from 'playwright';

/** What `NavigationBuffer.drain` hands out: the entries of one screen and how many did not fit. */
export interface Drained<T> {
  entries: T[];
  /** How many entries arrived after the buffer was full. */
  dropped: number;
}

/**
 * True for the request that loads the main frame's document (a navigation, or a hop of a redirect on
 * the way to one). `isNavigationRequest` comes first: `frame()` throws for a service worker's request,
 * which is not one. A page's own `request` events always have their frame.
 */
export function isDocumentRequest(request: Request): boolean {
  return request.isNavigationRequest() && request.frame().parentFrame() === null;
}

/**
 * What a page reports between two `collect` calls of an observer, scoped to the document it came from.
 *
 * Entries arrive one at a time through `record` (at most `capacity`, the rest counted as dropped), so a
 * page that logs or fetches in a loop costs a push each rather than a copy of everything so far. The
 * array is never handed out: `drain` swaps in a fresh one.
 *
 * A main-frame document navigation (a request that loads a document, then its commit) empties the
 * buffer: what arrived before it belongs to a page that is gone (a lens reload, a redirect that landed
 * elsewhere), and what the new page reports arrives only after the commit. A same-document navigation
 * (`pushState`, `replaceState`, a hash change) also raises `framenavigated` but sends no request, so
 * its entries stay. The commit is the `framenavigated` that lands on the URL last requested (the hash
 * aside): the page being left can still navigate within itself while the next document loads (Next.js's
 * router replaces its history entry once the page has hydrated), and taking that for the commit would
 * hand what it logs next to the next page.
 *
 * The one thing that arrives before the commit and belongs to the new page is the answer to the
 * document request itself (a page that answers 500 is the page). `recordDocument` holds such an
 * entry aside until the commit, which then puts it into the fresh buffer; a later document request
 * (the next hop of a redirect, a newer navigation) replaces what was held.
 */
export class NavigationBuffer<T> {
  private entries: T[] = [];
  private dropped = 0;
  /** Entries about the document request now loading, kept across the commit's clear. */
  private heldForCommit: T[] = [];
  /** The URL (without its hash) of the main-frame document requested and not yet committed; `null` when none is. */
  private loadingUrl: string | null = null;

  constructor(private readonly capacity: number) {}

  /**
   * Installs the page listeners that scope the buffer. They only read the event and update the
   * buffer, so none of them can throw.
   */
  attach(page: Page): void {
    page.on('request', (request) => this.noteRequest(request));
    page.on('framenavigated', (frame) => this.commit(frame));
  }

  /** Keeps `entry` unless the buffer is full, in which case it is counted as dropped. */
  record(entry: T): void {
    if (this.entries.length >= this.capacity) {
      this.dropped += 1;
      return;
    }
    this.entries.push(entry);
  }

  /**
   * Like `record`, for an entry about a document request (see the class note). Once the document has
   * committed there is nothing left to wait for, so a late entry (the body of the page failing to
   * arrive) goes straight into the buffer.
   */
  recordDocument(entry: T): void {
    if (this.loadingUrl === null) {
      this.record(entry);
      return;
    }
    this.heldForCommit = [...this.heldForCommit, entry];
  }

  /** What was recorded since the last drain or navigation; the buffer starts empty again. */
  drain(): Drained<T> {
    const seen = { entries: this.entries, dropped: this.dropped };
    this.entries = [];
    this.dropped = 0;
    return seen;
  }

  private noteRequest(request: Request): void {
    if (!isDocumentRequest(request)) return;
    this.loadingUrl = withoutHash(request.url());
    this.heldForCommit = [];
  }

  private commit(frame: Frame): void {
    if (frame.parentFrame() !== null || this.loadingUrl !== withoutHash(frame.url())) return;
    this.loadingUrl = null;
    const carried = this.heldForCommit;
    this.heldForCommit = [];
    this.drain();
    for (const entry of carried) this.record(entry);
  }
}

/** A request never carries the hash; the address the frame lands on keeps it. */
function withoutHash(url: string): string {
  const hashAt = url.indexOf('#');
  return hashAt === -1 ? url : url.slice(0, hashAt);
}
