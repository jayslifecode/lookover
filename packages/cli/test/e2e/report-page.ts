import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AppMap,
  type DecisionsFile,
  type Finding,
  type FindingsFile,
  readDecisions,
  readFindingsAt,
  type Screen,
} from '@jayslifecode/lookover-core';
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from 'playwright';
import type { ReplayFinding, ReportServer } from '../../src/report/server.js';
import {
  createFixtureProject,
  FIXTURE_RUN_ID,
  type FixtureProject,
  PREVIOUS_RUN_ID,
  serveFixtureRun,
} from '../report-fixture.js';

/*
 * The served report as the end-to-end suite drives it: the real report server over a temporary project
 * holding the report package's fixture run (with the run before it and the project's decisions), and a
 * Chromium page on it at 1440×900 that counts every request it makes.
 */

/** The size the spec's baseline was measured at, and the report's three-column layout. */
export const REPORT_VIEWPORT = { width: 1440, height: 900 } as const;
/** URLs that load nothing from anywhere: the report inlines two small font subsets as `data:`. */
const LOCAL_PROTOCOLS: ReadonlySet<string> = new Set(['data:', 'blob:']);
/**
 * How Chromium reports a load the page's Content-Security-Policy blocked: a blocked `fetch` never becomes
 * a request, so the console is where an attempt to reach another origin shows.
 */
const POLICY_VIOLATION = /Content Security Policy/;
const PIN_SELECTOR = '[data-pin-findings]';
export const PANEL_SELECTOR = 'aside[data-finding-panel]';

/** A fixture project and the report server over its finished run. */
export interface ServedFixture {
  readonly project: FixtureProject;
  readonly server: ReportServer;
  readonly origin: string;
  readonly findings: FindingsFile;
  readonly previous: FindingsFile;
  readonly map: AppMap;
  readonly decisions: DecisionsFile;
  close(): Promise<void>;
}

export async function serveFixture(prefix: string, replay?: ReplayFinding): Promise<ServedFixture> {
  const project = await createFixtureProject(prefix);
  const runDir = join(project.runsDir, FIXTURE_RUN_ID);
  const server = await serveFixtureRun(project, FIXTURE_RUN_ID, replay);
  return {
    project,
    server,
    origin: `http://127.0.0.1:${server.port}`,
    findings: await readFindingsAt(join(runDir, 'findings.json')),
    previous: await readFindingsAt(join(project.runsDir, PREVIOUS_RUN_ID, 'findings.json')),
    map: JSON.parse(await readFile(join(runDir, 'app-map.json'), 'utf8')) as AppMap,
    decisions: await readDecisions(project.lookoverDir),
    close: async () => {
      await server.close();
      await rm(project.dir, { recursive: true, force: true });
    },
  };
}

/** A page on the served report, and what it asked for. */
export interface ReportPage {
  readonly context: BrowserContext;
  readonly page: Page;
  /** Every URL the context's pages requested, in order. */
  readonly requests: () => readonly string[];
  /** The uncaught errors of the context's pages. */
  readonly pageErrors: () => readonly string[];
  /** What the report's Content-Security-Policy blocked in the context's pages. */
  readonly policyViolations: () => readonly string[];
}

export interface OpenOptions {
  readonly contextOptions?: BrowserContextOptions;
  readonly canUseClipboard?: boolean;
  /** Runs on the new page before the report is loaded (a media emulation, say). */
  readonly beforeLoad?: (page: Page) => Promise<void>;
}

/** Opens the URL the CLI prints (it sets the token cookie and redirects to `/`) and waits for the run. */
export async function openReport(
  browser: Browser,
  served: ServedFixture,
  options: OpenOptions = {},
): Promise<ReportPage> {
  const context = await browser.newContext({ viewport: REPORT_VIEWPORT, ...options.contextOptions });
  if (options.canUseClipboard === true) {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: served.origin });
  }
  let requests: readonly string[] = [];
  let pageErrors: readonly string[] = [];
  let policyViolations: readonly string[] = [];
  context.on('request', (request) => {
    requests = [...requests, request.url()];
  });
  context.on('weberror', (error) => {
    pageErrors = [...pageErrors, error.error().message];
  });
  context.on('console', (message) => {
    if (POLICY_VIOLATION.test(message.text())) policyViolations = [...policyViolations, message.text()];
  });
  const page = await context.newPage();
  await options.beforeLoad?.(page);
  await page.goto(served.server.url);
  await waitForRun(page, served);
  return {
    context,
    page,
    requests: () => requests,
    pageErrors: () => pageErrors,
    policyViolations: () => policyViolations,
  };
}

/** The report has loaded the run: the top bar names it. */
export async function waitForRun(page: Page, served: ServedFixture): Promise<void> {
  await page.getByRole('banner').getByText(served.findings.runId, { exact: true }).waitFor();
}

/** The requests that left the report's origin: any but `data:` and `blob:` URLs on another origin. */
export function foreignRequests(requests: readonly string[], origin: string): string[] {
  return requests.filter((url) => {
    const { protocol, origin: requested } = new URL(url);
    return !LOCAL_PROTOCOLS.has(protocol) && requested !== origin;
  });
}

/** Moves the report to the hash route `route` (`#/screens/<id>?f=<findingId>`, …). */
export async function goTo(page: Page, route: string): Promise<void> {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, route);
}

export function screenRoute(screenId: string, findingId: string | null = null): string {
  return findingId === null ? `#/screens/${screenId}` : `#/screens/${screenId}?f=${findingId}`;
}

export function firstScreen(map: AppMap): Screen {
  const screen = map.screens.find((candidate) => candidate.status === 'captured');
  if (screen === undefined) throw new Error('The fixture run captured no screen');
  return screen;
}

/** The confirmed findings the report lists: none the project's decisions mark intended. */
export function confirmedFindings(served: ServedFixture): Finding[] {
  const { decisions } = served.decisions;
  return served.findings.findings.filter(
    (finding) => finding.status === 'confirmed' && !Object.hasOwn(decisions, finding.id),
  );
}

/** The confirmed step findings with a target on `screenId`: the ones the screenshot pins. */
export function pinnedFindings(served: ServedFixture, screenId: string): Finding[] {
  return confirmedFindings(served).filter(
    (finding) => finding.shape === 'step' && finding.screenId === screenId && finding.target !== null,
  );
}

export function pins(page: Page): Locator {
  return page.locator(PIN_SELECTOR);
}

/** The finding ids every pin on the screenshot holds (a cluster pin holds several), sorted. */
export async function pinnedIds(page: Page): Promise<string[]> {
  const held = await pins(page).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-pin-findings') ?? ''),
  );
  return held.flatMap((ids) => ids.split(' ')).toSorted();
}

/** Waits until the screenshot of the screen shown has been measured and its pins placed. */
export async function waitForPins(page: Page): Promise<void> {
  await pins(page).first().waitFor();
}

export function panel(page: Page): Locator {
  return page.locator(PANEL_SELECTOR);
}

/** The panel's heading: the finding's title, or "Run summary". */
export function panelHeading(page: Page): Locator {
  return panel(page).getByRole('heading', { level: 2 }).first();
}

/** The first finding the first screen of the fixture run pins. */
export function firstPinned(served: ServedFixture): Finding {
  const [finding] = pinnedFindings(served, firstScreen(served.map).id);
  if (finding === undefined) throw new Error('The first screen of the fixture run pins no finding');
  return finding;
}

/** The pin (or cluster pin) that holds `finding`. */
export function pinOf(page: Page, finding: Finding): Locator {
  return page.locator(`[data-pin-findings~="${finding.id}"]`);
}
