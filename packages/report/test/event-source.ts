/*
 * jsdom has no EventSource: one that records what the report does with it and lets a test send a
 * message, drop the connection (the browser then reconnects: CONNECTING) and open it again.
 */
export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static latest: FakeEventSource | null = null;
  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  isClosed = false;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.latest = this;
  }

  close(): void {
    this.isClosed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  send(data: unknown): void {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    this.onmessage?.({ data: text } as MessageEvent<string>);
  }

  /** The connection drops and the browser starts reconnecting. */
  drop(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.();
  }

  /** The connection is (re)established. */
  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
}
