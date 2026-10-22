import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  FINDINGS_FILE,
  type Finding,
  type FindingsFile,
  type Lens,
  LookoverError,
  loadConfig,
  readFindingsAt,
  readLatestFindings,
  writeFileAtomic,
} from '@jayslifecode/lookover-core';
import {
  attemptLines,
  DEFAULT_REPLAY_TIMES,
  generateStandaloneScript,
  isFullyReproduced,
  replayHeading,
  replaySummary,
  runReplay,
} from '@jayslifecode/lookover-judge';
import type { Command } from 'commander';
import * as ui from '../ui.js';
import { findFinding, parseFindingId } from './finding-id.js';
import { createLens } from './run-options.js';

/** What commander hands the `replay` action. */
export interface ReplayFlags {
  readonly run?: string;
  readonly times?: string;
  readonly headless?: boolean;
  /** `true` for `--script` alone, the path for `--script <path>`. */
  readonly script?: string | boolean;
}

/** `--script`, and where it writes: the path given, or `null` for `.lookover/replays/<id>.mjs`. */
interface ScriptRequest {
  readonly path: string | null;
}

/** Where the findings are read from: the file, and how a message names it. */
interface FindingsSource {
  readonly path: string;
  readonly shown: string;
  /** The run named with `--run`; `null` for the project's latest findings. */
  readonly run: string | null;
}

const LOOKOVER_DIR = '.lookover';
const RUNS_DIR = 'runs';
const REPLAYS_DIR = 'replays';
const SCRIPT_EXTENSION = '.mjs';
const LATEST_PATH = `${LOOKOVER_DIR}/${FINDINGS_FILE}`;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
/** A run directory's name: no separator or dot can lead it out of `.lookover/runs`. */
const RUN_ID = /^[0-9A-Za-z][\w-]*$/;

/** `lookoverVersion` is recorded in the replay's environment. */
export function registerReplay(program: Command, lookoverVersion: string): void {
  program
    .command('replay')
    .description(
      'Measure one finding again in a fresh browser, as the judge does, or write a standalone Playwright script that does',
    )
    .argument(
      '<finding-id>',
      `the id of a finding in ${LATEST_PATH}, or the start of it that names one finding`,
    )
    .option('--run <run-id>', `look the finding up in ${LOOKOVER_DIR}/${RUNS_DIR}/<run-id>/${FINDINGS_FILE}`)
    .option('--times <n>', `measure it in this many fresh browser contexts (default ${DEFAULT_REPLAY_TIMES})`)
    .option('--headless', 'hide the browser window')
    .option(
      '--script [path]',
      `write a script that replays it with Playwright alone, instead of replaying it (default ${LOOKOVER_DIR}/${REPLAYS_DIR}/<id>${SCRIPT_EXTENSION})`,
    )
    .action((id: string, flags: ReplayFlags) => runReplayCommand(id, flags, lookoverVersion));
}

/**
 * `lookover replay`: finds the finding by its id or the start of it among the latest findings (or the
 * run's, with `--run`), confirmed, rejected, intended or worth a look; then replays it in a browser of
 * its own (headed unless `--headless`, `--times` fresh contexts) and prints one line per attempt and
 * `reproduced <n>/<of>`, the exit code 0 when every attempt reproduced it and 1 otherwise. With
 * `--script` it replays nothing and writes a standalone script instead. Fails with `E_USAGE` for a bad
 * flag or an id that names no one finding, and `E_RUN_FAILED` when there are no findings to look in.
 */
export async function runReplayCommand(
  id: string,
  flags: ReplayFlags,
  lookoverVersion: string,
  cwd: string = process.cwd(),
): Promise<void> {
  const times = parseTimes(flags.times);
  const source = findingsSource(cwd, flags.run);
  const query = parseFindingId(id, source.shown);
  const script = parseScript(flags.script);
  const { config } = await loadConfig(cwd);
  const finding = findFinding(await readSource(source), query, source.shown);
  if (script !== null) {
    await writeScript(script, cwd, finding, config.baseUrl);
    return;
  }
  ui.info(replayHeading(finding, times));
  const result = await runReplay({
    cwd,
    config,
    finding,
    lenses: lensesFor(finding),
    lookoverVersion,
    times,
    headless: flags.headless === true,
    env: process.env,
  });
  for (const line of [...attemptLines(result.attempts), replaySummary(result)]) {
    ui.info(line);
  }
  process.exitCode = isFullyReproduced(result) ? ui.EXIT_OK : ui.EXIT_FAILURE;
}

function parseTimes(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_REPLAY_TIMES;
  }
  if (!POSITIVE_INTEGER.test(value.trim())) {
    throw new LookoverError(
      'E_USAGE',
      `--times "${value}" is not a whole number above 0`,
      'For example: --times 3',
    );
  }
  return Number(value.trim());
}

/** What `--script` asks for; `null` without it, when the finding is replayed. */
function parseScript(value: string | boolean | undefined): ScriptRequest | null {
  if (value === undefined || value === false) {
    return null;
  }
  if (value === true) {
    return { path: null };
  }
  if (value.trim() === '') {
    throw new LookoverError(
      'E_USAGE',
      '--script is given an empty path',
      'Leave the path out, or name a file',
    );
  }
  return { path: value };
}

function findingsSource(cwd: string, run: string | undefined): FindingsSource {
  const lookoverDir = join(cwd, LOOKOVER_DIR);
  if (run === undefined) {
    return { path: join(lookoverDir, FINDINGS_FILE), shown: LATEST_PATH, run: null };
  }
  if (!RUN_ID.test(run)) {
    throw new LookoverError(
      'E_USAGE',
      `--run "${run}" is not a run id`,
      `Name a directory of ${LOOKOVER_DIR}/${RUNS_DIR}, such as 20261022-101500-a1b2`,
    );
  }
  return {
    path: join(lookoverDir, RUNS_DIR, run, FINDINGS_FILE),
    shown: `${LOOKOVER_DIR}/${RUNS_DIR}/${run}/${FINDINGS_FILE}`,
    run,
  };
}

async function readSource(source: FindingsSource): Promise<FindingsFile> {
  if (source.run !== null) {
    return readFindingsAt(source.path);
  }
  const file = await readLatestFindings(dirname(source.path));
  if (file === null) {
    throw new LookoverError(
      'E_RUN_FAILED',
      'There are no findings to replay yet',
      `Run lookover run first, then replay a finding by its id in ${LATEST_PATH}`,
    );
  }
  return file;
}

/** The lens that reported the finding; an observer finding is measured by the observers alone. */
function lensesFor(finding: Finding): Lens[] {
  return finding.source === 'observers' ? [] : [createLens(finding.source)];
}

/** Writes the standalone script where `request` says (relative to `cwd`), creating its directory. */
async function writeScript(
  request: ScriptRequest,
  cwd: string,
  finding: Finding,
  baseUrl: string,
): Promise<void> {
  const target =
    request.path === null
      ? join(cwd, LOOKOVER_DIR, REPLAYS_DIR, `${finding.id}${SCRIPT_EXTENSION}`)
      : resolve(cwd, request.path);
  const script = generateStandaloneScript(finding, { baseUrl });
  await mkdir(dirname(target), { recursive: true });
  await writeFileAtomic(target, script);
  ui.success(`Wrote ${target}`);
  ui.info(`Run it with: node ${target}`);
}
