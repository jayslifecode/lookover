import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configSchema,
  createRun,
  extractElements,
  type InstrumentedPage,
  type LensContext,
  type RunContext,
  type Screen,
  type Viewport,
} from '@jayslifecode/lookover-core';
import { DEFAULT_TEST_VIEWPORT } from './session.js';

export interface TestRun {
  ctx: RunContext;
  /** Removes the run's directory. */
  dispose(): Promise<void>;
}

export interface LensContextOptions {
  /** A `performance.now()` value; by default there is none, so the deadline never cuts a test short. */
  deadline?: number;
  /** By default the test session's one viewport; the first is the one the screen was captured at. */
  viewports?: readonly Viewport[];
  interaction?: LensContext['interaction'];
  screenId?: string;
}

/** A run in a fresh temporary directory, as the engine creates one, for a lens to write evidence into. */
export async function createTestRun(baseUrl: string): Promise<TestRun> {
  const cwd = await mkdtemp(join(tmpdir(), 'lookover-lenses-'));
  const ctx = await createRun({ cwd, config: configSchema.parse({ baseUrl, interaction: 'full' }) });
  return {
    ctx,
    dispose: () => rm(cwd, { recursive: true, force: true }),
  };
}

/**
 * What the pipeline hands a lens for the page as it is now: a captured screen at the page's URL, with
 * the elements the crawler's own `extractElements` finds on it.
 */
export async function lensContextFor(
  ipage: InstrumentedPage,
  ctx: RunContext,
  options: LensContextOptions = {},
): Promise<LensContext> {
  const viewports = options.viewports ?? [DEFAULT_TEST_VIEWPORT];
  const [viewport = DEFAULT_TEST_VIEWPORT] = viewports;
  const url = ipage.page.url();
  const { elements } = await extractElements(ipage);
  const screen: Screen = {
    id: options.screenId ?? 'screen-1',
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
  return {
    ctx,
    screen,
    ipage,
    viewports,
    interaction: options.interaction ?? 'full',
    deadline: options.deadline ?? Number.POSITIVE_INFINITY,
  };
}
