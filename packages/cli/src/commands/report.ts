import { join } from 'node:path';
import { LookoverError, loadConfig } from '@jayslifecode/lookover-core';
import type { Command } from 'commander';
import { openInBrowser } from '../report/open-browser.js';
import { LOOKOVER_DIR, latestFinishedRun, RUNS_DIR, runExists } from '../report/runs.js';
import { LOOPBACK_HOST, type ReportServer, startReportServer } from '../report/server.js';
import * as ui from '../ui.js';
import { createAvailableLenses } from './run-options.js';

/** What commander hands the `report` action. */
export interface ReportFlags {
  readonly run?: string;
  readonly port?: string;
  /** `false` for `--no-open`. */
  readonly open?: boolean;
}

const RUNS_PATH = `${LOOKOVER_DIR}/${RUNS_DIR}`;
const PORT_NUMBER = /^\d+$/;
const MAX_PORT = 65_535;
const PORT_IN_USE = 'EADDRINUSE';

export function registerReport(program: Command, lookoverVersion: string): void {
  program
    .command('report')
    .description(
      'Serve the report of the latest finished run (the last one that wrote its findings) on this machine and open it in the browser, until Ctrl-C',
    )
    .option(
      '--run <run-id>',
      `serve the report of ${RUNS_PATH}/<run-id> instead, finished or not (a run stopped before its end stays "running")`,
    )
    .option('--port <n>', `listen on this port of ${LOOPBACK_HOST} (0 picks a free one, the default)`)
    .option('--no-open', 'serve the report but do not open it in the browser')
    .action((flags: ReportFlags) => runReportCommand(flags, lookoverVersion));
}

/**
 * `lookover report`: serves the latest run that wrote its findings (or the run `--run` names, finished or
 * not) on `127.0.0.1`, prints its URL, opens it in the browser unless `--no-open`, and keeps serving until
 * Ctrl-C. Fails with `E_RUN_FAILED` when no run has written its findings yet, and `E_USAGE` for a
 * `--run` that names no run or a `--port` that is not a free port number.
 */
export async function runReportCommand(
  flags: ReportFlags,
  lookoverVersion: string,
  cwd: string = process.cwd(),
): Promise<void> {
  const port = parsePort(flags.port);
  const lookoverDir = join(cwd, LOOKOVER_DIR);
  const runId = await chooseRun(lookoverDir, flags.run);
  const { config } = await loadConfig(cwd);
  const server = await startReportServer({
    lookoverDir,
    runId,
    cwd,
    config,
    lenses: createAvailableLenses(),
    lookoverVersion,
    port,
    host: LOOPBACK_HOST,
  }).catch((error: unknown) => {
    throw isPortInUse(error) ? portInUse(port) : error;
  });
  await announceReport(server, flags.open !== false);
  ui.info('Press Ctrl-C to close');
  await untilInterrupted();
  await server.close();
  process.exitCode = ui.EXIT_OK;
}

/** Prints the report's URL, then opens it unless `shouldOpen` is false; a browser that will not open is a warning. */
export async function announceReport(server: ReportServer, shouldOpen: boolean): Promise<void> {
  ui.info(`Report: ${server.url}`);
  if (shouldOpen && !(await openInBrowser(server.url))) {
    ui.warn('Could not open the report in a browser; open the URL above');
  }
}

/** Resolves on the next Ctrl-C, which then no longer ends the process by itself. */
export function untilInterrupted(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
  });
}

async function chooseRun(lookoverDir: string, run: string | undefined): Promise<string> {
  if (run !== undefined) {
    if (!(await runExists(lookoverDir, run))) {
      throw new LookoverError(
        'E_USAGE',
        `--run "${run}" names no run in ${RUNS_PATH}`,
        `Name a directory of ${RUNS_PATH}, such as 20261022-101500-a1b2`,
      );
    }
    return run;
  }
  const latest = await latestFinishedRun(lookoverDir);
  if (latest === null) {
    throw new LookoverError(
      'E_RUN_FAILED',
      'There is no run to report yet: no run has written its findings',
      'Run lookover run first; it serves the report while it runs',
    );
  }
  return latest;
}

/** `--port`: 0 (a free port, the default) to 65535. */
function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }
  const port = value.trim();
  if (!PORT_NUMBER.test(port) || Number(port) > MAX_PORT) {
    throw new LookoverError(
      'E_USAGE',
      `--port "${value}" is not a port number`,
      `Give a whole number from 0 to ${MAX_PORT} (0 picks a free port, as leaving --port out does)`,
    );
  }
  return Number(port);
}

function isPortInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === PORT_IN_USE;
}

function portInUse(port: number): LookoverError {
  return new LookoverError(
    'E_USAGE',
    `--port ${port} is in use`,
    'Pick another port, or leave --port out for a free one',
  );
}
