import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Finding, isFailedScreen } from '@jayslifecode/lookover-core';
import { tokenCookieName } from '@jayslifecode/lookover-report/api';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type CliResult, runCli } from '../run-cli.js';
import { keepOutput, readAppMap, readFindings } from './project.js';
import { firstPinned, type ServedFixture, serveFixture } from './report-page.js';

/*
 * Lookover reviews its own report (spec §11: the report must pass Lookover's own interaction lens with
 * zero candidates). The report server serves the fixture run; a project whose config points at it logs in
 * with a Playwright storage state holding the report's token cookie, and `lookover run` reviews it, in
 * safe mode, unjudged, without opening a report of its own. Anything it reports is a defect of the report.
 */

/** Stops a hung CLI well before the test times out, so the failure says what happened. */
const PROCESS_TIMEOUT_MS = 300_000;
const MAX_SCREENS = 2;
/** The suite never spends money on the judge model, and `--no-judge` would not call it anyway. */
const API_KEY_ENV = 'ANTHROPIC_API_KEY';
const STATE_FILE = 'report-session.json';
/** The report's own title (packages/report/index.html). */
const REPORT_TITLE = 'Lookover report';

let served: ServedFixture;
let project: string;
let run: CliResult;

/** The session a browser has once it opened the URL the CLI printed: the token cookie, nothing else. */
function storageState(fixture: ServedFixture): unknown {
  return {
    cookies: [
      {
        name: tokenCookieName(fixture.server.port),
        value: fixture.server.token,
        domain: '127.0.0.1',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Strict',
      },
    ],
    origins: [],
  };
}

function describeFinding(finding: Finding): string {
  const where =
    finding.shape === 'step'
      ? (finding.target?.selector ?? finding.trace.route)
      : finding.occurrences.map((occurrence) => occurrence.selector ?? occurrence.route).join(', ');
  return `${finding.rule.id} at ${where}: ${finding.observed}`;
}

beforeAll(async () => {
  served = await serveFixture('lookover-e2e-dogfood-report-');
  project = await mkdtemp(join(tmpdir(), 'lookover-e2e-dogfood-'));
  await writeFile(join(project, STATE_FILE), `${JSON.stringify(storageState(served), null, 2)}\n`);
  const config = {
    baseUrl: `${served.origin}/`,
    interaction: 'safe',
    framework: 'unknown',
    auth: { type: 'storageState', path: STATE_FILE },
    maxScreens: MAX_SCREENS,
  };
  await writeFile(join(project, 'lookover.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  run = await runCli(
    project,
    ['run', '--no-judge', '--no-report', '--yes', '--max-screens', String(MAX_SCREENS)],
    { withoutEnv: [API_KEY_ENV], timeoutMs: PROCESS_TIMEOUT_MS },
  );
  await keepOutput(project, run, 'lookover-dogfood');
});

afterAll(async () => {
  await served?.close();
  if (project !== undefined) await rm(project, { recursive: true, force: true });
});

describe('Lookover reviewing its own report', () => {
  test('exits 0, having captured the report with the run it serves', async () => {
    const map = await readAppMap(project);
    const captured = map.screens.filter((screen) => !isFailedScreen(screen));
    const names = captured.flatMap((screen) => screen.elements.map((element) => element.name));

    expect(run.code, run.stderr).toBe(0);
    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured.map((screen) => screen.title)).toContain(REPORT_TITLE);
    // A pin is drawn only once the report has read the run: the token cookie let it in.
    expect(names).toContain(`1. ${firstPinned(served).title}`);
  });

  test('finds nothing to report: no candidate among the findings', async () => {
    const file = await readFindings(project);

    expect(file.findings.map(describeFinding)).toEqual([]);
  });
});
