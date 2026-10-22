import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserSession,
  configSchema,
  createRun,
  extractElements,
  type InstrumentedPage,
  type RunContext,
  type Screen,
  type Viewport,
} from '@jayslifecode/lookover-core';
import { type FixtureRoute, serveFixture } from '@jayslifecode/lookover-test-support';

export const DEFAULT_TEST_VIEWPORT: Viewport = { name: 'desktop', width: 1280, height: 800 };

/** A fixture server, a browser session as the engine launches one, and a run to write evidence into. */
export interface TestBed {
  /** The fixture server's origin, without a trailing slash. */
  url: string;
  session: BrowserSession;
  ctx: RunContext;
  /** Closes the session and the server and removes the run's directory. */
  close(): Promise<void>;
}

/**
 * Serves `dir` (with `routes`) on the loopback, launches a session that allows no hosts beyond the
 * loopback ones (the session always allows those) and creates a run in a fresh temporary directory.
 */
export async function openTestBed(
  dir: string,
  routes: Readonly<Record<string, FixtureRoute>> = {},
): Promise<TestBed> {
  const fixture = await serveFixture(dir, routes);
  const cwd = await mkdtemp(join(tmpdir(), 'lookover-judge-'));
  const session = await BrowserSession.launch({
    viewport: DEFAULT_TEST_VIEWPORT,
    allowHosts: [],
    onEvent: () => undefined,
  });
  const ctx = await createRun({
    cwd,
    config: configSchema.parse({ baseUrl: fixture.url, interaction: 'full' }),
  });
  return {
    url: fixture.url,
    session,
    ctx,
    close: async () => {
      try {
        await session.close();
      } finally {
        await fixture.close();
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}

/** The page as the crawler captures it: a screen at the page's URL with the elements on it. */
export async function screenOf(ipage: InstrumentedPage, id: string, viewport: Viewport): Promise<Screen> {
  const url = ipage.page.url();
  const { elements } = await extractElements(ipage);
  return {
    id,
    url,
    route: new URL(url).pathname,
    title: await ipage.page.title(),
    status: 'captured',
    error: null,
    viewport,
    screenshot: null,
    elements,
    forms: [],
    tokens: [],
    links: [],
    redirectedFrom: null,
    discoveredFrom: null,
    capturedAt: new Date().toISOString(),
  };
}
