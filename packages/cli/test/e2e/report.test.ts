import { join } from 'node:path';
import { type Finding, readDecisions } from '@jayslifecode/lookover-core';
import type { ReplayResult } from '@jayslifecode/lookover-report/api';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { FIXTURE_RUN_ID, PREVIOUS_RUN_ID } from '../report-fixture.js';
import { readGallery } from './controls.js';
import { sampleFrames } from './frames.js';
import {
  confirmedFindings,
  firstPinned,
  firstScreen,
  foreignRequests,
  goTo,
  type OpenOptions,
  openReport,
  PANEL_SELECTOR,
  panel,
  panelHeading,
  pinnedFindings,
  pinnedIds,
  pinOf,
  pins,
  type ReportPage,
  type ServedFixture,
  screenRoute,
  serveFixture,
  waitForPins,
  waitForRun,
} from './report-page.js';

/*
 * The built report, served by the real report server over the report package's fixture run, in
 * Chromium at 1440×900: what each view shows, what the panel's actions write, the theme, and that the
 * page asks nothing of any origin but its own. Each test has a project and a server of its own, so a
 * decision one writes is never seen by another.
 */

/** The report's `GALLERY_PREVIEW_ROWS`: a long gallery shows this many controls until asked for all. */
const GALLERY_PREVIEW_ROWS = 8;
/** The 560 ms grow, the 150 ms fade of the ghost, and room to spare. */
const TRANSFORM_SETTLE_MS = 900;
/** The transform runs for over thirty frames at 60 Hz; fewer samples than this measured nothing. */
const MIN_SAMPLED_FRAMES = 20;
const SUMMARY_HEADING = 'Run summary';
/** A pin's accessible name: `<n>. <title>`. */
const PIN_NAME = /^(\d+)\. (.+)$/;
/** How the gallery names a control that has no name. */
const NO_NAME = '(no name)';
const THEME_STORAGE_KEY = 'lookover.theme';
const REPLAYED: ReplayResult = { attempts: [], reproduced: 1, of: 1 };

/** A replay the report asked for, held until the test lets it answer. */
interface HeldReplay {
  readonly finding: Finding;
  readonly release: (result: ReplayResult) => void;
}

let browser: Browser;
let served: ServedFixture;
let opened: readonly ReportPage[] = [];
let replays: readonly HeldReplay[] = [];

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

beforeEach(async () => {
  replays = [];
  // The fixture's run cannot be replayed here (its config has no login for the bench, and the server's
  // replay opens a browser window), so each replay is held: what is tested is how the report shows it.
  served = await serveFixture(
    'lookover-e2e-report-',
    (finding) =>
      new Promise((resolve) => {
        replays = [...replays, { finding, release: resolve }];
      }),
  );
});

afterEach(async () => {
  const foreign = opened.flatMap((each) => foreignRequests(each.requests(), served.origin));
  const errors = opened.flatMap((each) => each.pageErrors());
  const blocked = opened.flatMap((each) => each.policyViolations());
  for (const each of opened) await each.context.close();
  opened = [];
  await served.close();
  expect(foreign, 'requests to another origin').toEqual([]);
  expect(blocked, 'loads the Content-Security-Policy blocked').toEqual([]);
  expect(errors, 'uncaught errors in the page').toEqual([]);
});

async function open(options: OpenOptions = {}): Promise<ReportPage> {
  const report = await openReport(browser, served, options);
  opened = [...opened, report];
  return report;
}

/** Shows `finding` in the panel through its route, and waits until the panel holds it. */
async function showFinding(page: Page, finding: Finding): Promise<void> {
  await goTo(page, screenRoute(firstScreen(served.map).id, finding.id));
  await panel(page).getByRole('heading', { level: 2, name: finding.title, exact: true }).waitFor();
}

/** What the Findings view groups a finding under: its signature, else its component, else its rule. */
function groupLabel(finding: Finding): string {
  const target = finding.shape === 'step' ? finding.target : null;
  return target?.signature ?? target?.componentName ?? finding.rule.id;
}

function groupedByLabel(findings: readonly Finding[]): ReadonlyMap<string, readonly Finding[]> {
  return findings.reduce((groups, finding) => {
    const label = groupLabel(finding);
    return new Map(groups).set(label, [...(groups.get(label) ?? []), finding]);
  }, new Map<string, readonly Finding[]>());
}

function findingsCount(count: number): RegExp {
  return new RegExp(`(^|\\D)${count} ${count === 1 ? 'finding' : 'findings'}$`);
}

describe('the served report, at 1440×900', () => {
  test('pins each confirmed step finding of the first screen once, and lists its state gallery', async () => {
    const { page } = await open();
    const screen = firstScreen(served.map);
    const expected = pinnedFindings(served, screen.id);
    const gallery = await readGallery(join(served.project.runsDir, FIXTURE_RUN_ID), screen.id);

    await page.getByRole('heading', { level: 1, name: screen.title, exact: true }).waitFor();
    await waitForPins(page);
    const names = await pins(page).evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('aria-label') ?? ''),
    );
    const rows = page.getByRole('list', { name: 'Controls in each state' }).locator(':scope > li');
    const entries = gallery?.entries ?? [];
    await expect.poll(() => rows.count()).toBe(Math.min(entries.length, GALLERY_PREVIEW_ROWS));
    await page.getByRole('button', { name: `Show all ${entries.length} controls` }).click();
    await expect.poll(() => rows.count()).toBe(entries.length);
    const rowTexts = await rows.allTextContents();
    const numbered = names.map((name) => PIN_NAME.exec(name));
    const unlisted = entries.filter(
      (entry, index) => !(rowTexts[index] ?? '').includes(entry.name === '' ? NO_NAME : entry.name),
    );

    expect(expected.length).toBeGreaterThan(0);
    // One pin per finding (none clustered here), each named `<n>. <title>`, numbered from 1.
    expect(await pinnedIds(page)).toEqual(expected.map(({ id }) => id).toSorted());
    expect(numbered.map((match) => match?.[2]).toSorted()).toEqual(
      expected.map(({ title }) => title).toSorted(),
    );
    expect(numbered.map((match) => Number(match?.[1])).toSorted((a, b) => a - b)).toEqual(
      expected.map((_, index) => index + 1),
    );
    expect(entries.length).toBeGreaterThan(GALLERY_PREVIEW_ROWS);
    expect(unlisted.map(({ selector }) => selector)).toEqual([]);
  });

  test('a pin opens its finding in the panel, which is never empty while it grows out of the pin', async () => {
    const { page } = await open();
    const finding = firstPinned(served);
    await waitForPins(page);
    await panelHeading(page).filter({ hasText: SUMMARY_HEADING }).waitFor();

    const { texts, animations } = await sampleFrames(
      page,
      async () => {
        await pinOf(page, finding).click();
        await page.waitForTimeout(TRANSFORM_SETTLE_MS);
      },
      { textOf: `${PANEL_SELECTOR} h2`, countAnimations: true },
    );

    // The panel grew the finding out of the pin (it animated), and showed a heading on every frame.
    expect(Math.max(...animations)).toBeGreaterThan(0);
    expect(texts.length).toBeGreaterThan(MIN_SAMPLED_FRAMES);
    expect(texts.filter((text) => (text ?? '').trim() === '')).toEqual([]);
    expect([...new Set(texts)]).toEqual([SUMMARY_HEADING, finding.title]);
    expect(await panelHeading(page).textContent()).toBe(finding.title);
    expect(await pinOf(page, finding).getAttribute('aria-current')).toBe('true');
    expect(new URL(page.url()).hash).toBe(screenRoute(firstScreen(served.map).id, finding.id));
  });

  test("Copy fix prompt puts the finding's fix prompt on the clipboard", async () => {
    const { page } = await open({ canUseClipboard: true });
    const finding = firstPinned(served);
    await showFinding(page, finding);

    await panel(page).getByRole('button', { name: 'Copy fix prompt' }).click();
    await page.getByText('Fix prompt copied', { exact: true }).waitFor();

    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(finding.fixPrompt);
  });

  test('Mark intended writes decisions.json, and the finding is still intended after a reload', async () => {
    const { page } = await open();
    const finding = firstPinned(served);
    const earlier = Object.keys(served.decisions.decisions);
    await showFinding(page, finding);

    await panel(page).getByRole('button', { name: 'Mark intended' }).click();
    await panel(page).getByText('Marked intended', { exact: true }).waitFor();
    await expect
      .poll(async () => (await readDecisions(served.project.lookoverDir)).decisions[finding.id]?.status)
      .toBe('intended');
    await page.reload();
    await waitForRun(page, served);
    await panel(page).getByRole('heading', { level: 2, name: finding.title, exact: true }).waitFor();
    await panel(page).getByText('Marked intended', { exact: true }).waitFor();

    const { decisions } = await readDecisions(served.project.lookoverDir);
    expect(Object.keys(decisions)).toEqual(expect.arrayContaining([...earlier, finding.id]));
    expect(await panel(page).getByRole('button', { name: 'Undo' }).isVisible()).toBe(true);
    expect(await panel(page).getByRole('button', { name: 'Mark intended' }).count()).toBe(0);
  });

  test('the Findings view groups the confirmed findings by signature', async () => {
    const { page } = await open();
    const findings = confirmedFindings(served);
    const expected = groupedByLabel(findings);
    const [largest] = [...expected].toSorted(([, a], [, b]) => b.length - a.length);

    await page.getByRole('tab', { name: 'Findings' }).click();
    await page.getByRole('heading', { level: 1, name: 'Findings' }).waitFor();
    const groups = page.getByRole('list', { name: 'Fix first' }).locator(':scope > li');
    await expect.poll(() => groups.count()).toBe(expected.size);
    const headers = await groups.locator(':scope > button').allTextContents();
    const group = groups.filter({ has: page.getByRole('button', { name: `${largest?.[0]} · ` }) });
    await group.getByRole('button').first().click();
    const links = group.getByRole('list').getByRole('link');

    // A signature the bench's organisations page repeats on a dozen links and buttons.
    expect(largest?.[1].length).toBeGreaterThan(1);
    for (const [label, members] of expected) {
      const matching = headers.filter(
        (text) => text.includes(`${label} · `) && findingsCount(members.length).test(text),
      );
      expect(matching, label).toHaveLength(1);
    }
    expect(await links.count()).toBe(largest?.[1].length);
  });

  test('the Drift view compares the run with the one before it', async () => {
    const { page } = await open();
    const current = confirmedFindings(served);
    const before = served.previous.findings.filter((finding) => finding.status === 'confirmed');
    const beforeIds = new Set(before.map(({ id }) => id));
    const currentIds = new Set(current.map(({ id }) => id));
    const intendedIds = new Set([
      ...served.findings.intended.map(({ id }) => id),
      ...Object.keys(served.decisions.decisions),
    ]);
    const added = current.filter(({ id }) => !beforeIds.has(id));
    const unchanged = current.filter(({ id }) => beforeIds.has(id));
    const fixed = before.filter(({ id }) => !currentIds.has(id) && !intendedIds.has(id));
    const intendedSince = before.filter(({ id }) => intendedIds.has(id));
    const section = (name: string) => page.getByRole('region', { name, exact: true });

    await page.getByRole('tab', { name: 'Drift' }).click();
    await page.getByRole('heading', { level: 1, name: 'Drift' }).waitFor();
    await page
      .getByText(
        `Since the run ${PREVIOUS_RUN_ID}: ${added.length} new · ${fixed.length} fixed · ${unchanged.length} still there`,
        { exact: true },
      )
      .waitFor();

    expect(unchanged.length).toBeGreaterThan(0);
    expect(await section('New').getByRole('listitem').count()).toBe(added.length);
    expect(await section('Still there').getByRole('listitem').allTextContents()).toEqual(
      expect.arrayContaining(unchanged.map(({ title }) => expect.stringContaining(title))),
    );
    expect(await section('Still there').getByRole('listitem').count()).toBe(unchanged.length);
    expect(await section('Intended').getByRole('listitem').count()).toBe(intendedSince.length);
  });

  test('the theme toggle switches data-theme, and the choice holds across a reload', async () => {
    const { page } = await open();
    const themeOf = () => page.evaluate(() => document.documentElement.dataset.theme);
    const before = await themeOf();
    const next = before === 'dark' ? 'light' : 'dark';

    await page.getByRole('button', { name: `Switch to ${next} theme` }).click();
    await expect.poll(themeOf).toBe(next);
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), THEME_STORAGE_KEY);
    await page.reload();
    await waitForRun(page, served);

    expect(stored).toBe(next);
    expect(await themeOf()).toBe(next);
    expect(await page.getByRole('button', { name: `Switch to ${before} theme` }).isVisible()).toBe(true);
  });

  test("a replay asked for while another runs shows the server's 409 message, word for word", async () => {
    const { context, page } = await open();
    const finding = firstPinned(served);
    await showFinding(page, finding);
    await panel(page).getByRole('button', { name: 'Replay' }).click();
    await expect.poll(() => replays.length).toBe(1);
    const second = await context.newPage();
    await second.goto(`${served.origin}/${screenRoute(firstScreen(served.map).id, finding.id)}`);
    await waitForRun(second, served);
    await panel(second).getByRole('heading', { level: 2, name: finding.title, exact: true }).waitFor();

    const [busy] = await Promise.all([
      second.waitForResponse((response) => new URL(response.url()).pathname === '/api/replay'),
      panel(second).getByRole('button', { name: 'Replay' }).click(),
    ]);
    const { error } = (await busy.json()) as { error: string };
    await panel(second).getByText(error, { exact: true }).waitFor();
    replays[0]?.release(REPLAYED);
    await panel(page).getByText('Reproduced 1 of 1', { exact: true }).waitFor();

    expect(busy.status()).toBe(409);
    expect(error).not.toBe('');
    expect(replays.map((replay) => replay.finding.id)).toEqual([finding.id]);
  });

  test('asks nothing of any origin but its own, across every view', async () => {
    const { page, requests } = await open();
    const finding = firstPinned(served);
    await waitForPins(page);
    await pinOf(page, finding).click();
    await panelHeading(page).filter({ hasText: finding.title }).waitFor();
    const views = [
      ['Findings', 'Findings'],
      ['Drift', 'Drift'],
      ['Screens', firstScreen(served.map).title],
    ] as const;
    for (const [tab, heading] of views) {
      await page.getByRole('tab', { name: tab }).click();
      await page.getByRole('heading', { level: 1, name: heading, exact: true }).waitFor();
    }
    const paths = requests().map((url) => new URL(url).pathname);

    expect(paths.filter((path) => path.startsWith('/api/evidence/')).length).toBeGreaterThan(0);
    expect(paths.filter((path) => path.startsWith('/assets/')).length).toBeGreaterThan(0);
    expect(foreignRequests(requests(), served.origin)).toEqual([]);
  });
});
