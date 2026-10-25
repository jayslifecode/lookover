import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema } from '@jayslifecode/lookover-core';
import { type ReportServer, type ReportServerOptions, startReportServer } from '../src/report/server.js';

/** The report package's fixture run, the one its dev mock serves (Task 9). */
const FIXTURES_DIR = fileURLToPath(new URL('../../report/fixtures/', import.meta.url));

/** The fixture run's id, and the id of the run its `previous-findings.json` came from. */
export const FIXTURE_RUN_ID = '20261022-212802-kwtz';
export const PREVIOUS_RUN_ID = '20261022-212755-bal6';
/** Between the two, a run that stopped before writing its findings: never anyone's previous run. */
export const UNFINISHED_RUN_ID = '20261022-212800-stop';
/** Before them all, a run with no findings either: the oldest run, which has no previous run. */
export const OLDEST_RUN_ID = '20261022-100000-old0';

/** The Lookover version the servers of these tests report. */
export const FIXTURE_VERSION = '9.9.9';
/** The config of the project the fixture run was made in: the bench. */
export const FIXTURE_CONFIG = configSchema.parse({
  baseUrl: 'http://localhost:3123',
  interaction: 'safe',
  framework: 'unknown',
});

/** A project directory holding the fixture run as `lookover run` would have left it. */
export interface FixtureProject {
  readonly dir: string;
  readonly lookoverDir: string;
  readonly runsDir: string;
}

/**
 * Copies the fixture into a new temporary project: the run into `.lookover/runs/<id>/`, the previous
 * findings into the previous run's directory, the decisions into `.lookover/`, and two runs that wrote
 * no findings (one between the two, one before them all) with a log of their `run.started` alone.
 */
export async function createFixtureProject(prefix: string): Promise<FixtureProject> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const lookoverDir = join(dir, '.lookover');
  const runsDir = join(lookoverDir, 'runs');
  await cp(join(FIXTURES_DIR, 'run'), join(runsDir, FIXTURE_RUN_ID), { recursive: true });
  await mkdir(join(runsDir, PREVIOUS_RUN_ID), { recursive: true });
  await cp(join(FIXTURES_DIR, 'previous-findings.json'), join(runsDir, PREVIOUS_RUN_ID, 'findings.json'));
  await cp(join(FIXTURES_DIR, 'decisions.json'), join(lookoverDir, 'decisions.json'));
  for (const runId of [UNFINISHED_RUN_ID, OLDEST_RUN_ID]) {
    await mkdir(join(runsDir, runId, 'evidence'), { recursive: true });
    await writeFile(join(runsDir, runId, 'run.jsonl'), `${JSON.stringify(startedEvent(runId))}\n`);
  }
  return { dir, lookoverDir, runsDir };
}

/** The first line of a run log. */
export function startedEvent(runId: string): Record<string, unknown> {
  return {
    type: 'run.started',
    baseUrl: 'http://localhost:3123',
    interaction: 'safe',
    viewports: [{ name: 'desktop', width: 1440, height: 900 }],
    seq: 1,
    at: '2026-10-22T10:00:00.000Z',
    runId,
  };
}

/** A report server for the run `runId` of `project`, with no lens, replaying with `replay` when given. */
export function serveFixtureRun(
  project: FixtureProject,
  runId: string,
  replay?: ReportServerOptions['replay'],
): Promise<ReportServer> {
  return startReportServer({
    lookoverDir: project.lookoverDir,
    runId,
    cwd: project.dir,
    config: FIXTURE_CONFIG,
    lenses: [],
    lookoverVersion: FIXTURE_VERSION,
    ...(replay === undefined ? {} : { replay }),
  });
}
