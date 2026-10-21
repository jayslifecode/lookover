import {
  BrowserSession,
  type InstrumentedPage,
  type SessionEvent,
  type Viewport,
} from '@jayslifecode/lookover-core';

export const DEFAULT_TEST_VIEWPORT: Viewport = { name: 'desktop', width: 1280, height: 800 };

export interface TestSession {
  session: BrowserSession;
  /** What the session reported (hosts observed, requests blocked), in order. */
  events: readonly SessionEvent[];
  newPage(): Promise<InstrumentedPage>;
  close(): Promise<void>;
}

/**
 * A browser session as the engine launches one, with no hosts allowed beyond the loopback ones the
 * fixture servers listen on (the session always allows those). Its events are collected, not logged.
 */
export async function launchTestSession(viewport: Viewport = DEFAULT_TEST_VIEWPORT): Promise<TestSession> {
  const events: SessionEvent[] = [];
  const session = await BrowserSession.launch({
    viewport,
    allowHosts: [],
    onEvent: (event) => events.push(event),
  });
  return {
    session,
    events,
    newPage: () => session.newPage(),
    close: () => session.close(),
  };
}
