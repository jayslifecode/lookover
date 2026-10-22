import { join } from 'node:path';
import { cancel } from '@clack/prompts';
import {
  APP_MAP_FILE,
  CONFIG_FILENAME,
  createRun,
  FINDINGS_FILE,
  type FindingsFile,
  isFailedScreen,
  type Judge,
  type Lens,
  loadConfig,
  type ReviewResult,
  type RunContext,
  type RunEvent,
  runReview,
  type Screen,
} from '@jayslifecode/lookover-core';
import type { Command } from 'commander';
import * as ui from '../ui.js';
import { findingLines } from './run-findings.js';
import { type HostKinds, hostLabel, labelUnconfirmedHosts, withObservedHost } from './run-hosts.js';
import { createJudge } from './run-judge.js';
import {
  collectRepeated,
  configForRun,
  createLens,
  JUDGE_FLAG_HELP,
  LENS_FLAG_HELP,
  parseRunFlags,
  type RunFlags,
  type RunOptions,
  saveConfirmedHosts,
} from './run-options.js';
import { createConfirmHosts, RunCancelledError, shouldPrompt } from './run-prompts.js';
import {
  blockedHostsWarning,
  findingsNote,
  type InspectionSummary,
  progressLine,
  summaryRows,
} from './run-summary.js';

/** What inspects each screen and judges what it yields; nothing for `--map-only`, which only maps. */
interface Inspectors {
  readonly lenses: readonly Lens[];
  /** `undefined` with `--no-judge` (and `--map-only`): the candidates are written as measured. */
  readonly judge: Judge | undefined;
}

/**
 * Prints a line per captured screen (with its candidates, once it has been inspected), counts the
 * blocked requests and notes what the app used each host for, as the run log records them.
 */
interface Progress {
  readonly onEvent: (event: RunEvent) => void;
  readonly blockedRequests: () => number;
  /** A host as the CLI lists it (see `hostLabel`), from the events so far. */
  readonly labelHost: (host: string) => string;
  /** Prints the screens captured but not yet inspected, as plain lines: a failed run's last screens. */
  readonly flushInFlight: () => void;
}

/** `lookoverVersion` is recorded in every judgement's environment. */
export function registerRun(program: Command, lookoverVersion: string): void {
  program
    .command('run')
    .description(
      'Open every screen of the app in a real browser, inspect it, reproduce what it finds, and write .lookover/app-map.json and findings.json',
    )
    .option('--headed', 'show the browser window')
    .option('--max-screens <n>', 'capture at most this many screens (overrides maxScreens)')
    .option(
      '--allow-host <host>',
      'let the browser load this host too, for this run only (repeatable)',
      collectRepeated,
    )
    .option(
      '--confirm-host <host>',
      `confirm this backend is a development or disposable instance (repeatable; saved to ${CONFIG_FILENAME})`,
      collectRepeated,
    )
    .option(
      '--yes',
      'never prompt: a backend not confirmed in the config or with --confirm-host stops the run',
    )
    .option('--map-only', 'only map the app: run no lenses and no observers, so there are no candidates')
    .option('--lens <name>', LENS_FLAG_HELP, collectRepeated)
    .option('--no-judge', JUDGE_FLAG_HELP.noJudge)
    .option('--judge-model <id>', JUDGE_FLAG_HELP.judgeModel)
    .option('--no-report', JUDGE_FLAG_HELP.noReport)
    .option('--no-open', JUDGE_FLAG_HELP.noOpen)
    .action((flags: RunFlags) => runRun(flags, lookoverVersion));
}

/**
 * `lookover run`: loads the config (the acknowledgement gate refuses an unacknowledged `full` run),
 * maps the app and inspects each screen with this run's flags applied (`--map-only` skips the
 * inspection), judges the candidates while the crawl goes on (`--no-judge` leaves them as measured),
 * prints the summary with the confirmed findings (or the candidates) and saves the confirmed backend
 * hosts to the config. `--no-report` and `--no-open` are accepted and change nothing until the report
 * exists. Errors propagate to `ui.fail`, which picks the exit code.
 */
export async function runRun(flags: RunFlags, lookoverVersion: string): Promise<void> {
  const cwd = process.cwd();
  const options = parseRunFlags(flags);
  const { config } = await loadConfig(cwd);
  const ctx = await createRun({ cwd, config: configForRun(config, options), onSubscriberError });
  const inspectors = await createInspectors(ctx, options, lookoverVersion);
  ui.info(`Mapping ${config.baseUrl} (run ${ctx.runId})`);
  const progress = createProgress(!options.isMapOnly);
  const startedAt = performance.now();
  const result = await discover(ctx, cwd, options, progress, inspectors);
  const durationMs = performance.now() - startedAt;

  const savedHosts = await saveConfirmedHosts(cwd, config, [
    ...options.confirmHosts,
    ...result.confirmedBackendHosts,
  ]);
  const inspection: InspectionSummary = {
    findings: result.findings,
    findingsPath: join(ctx.lookoverDir, FINDINGS_FILE),
  };
  ui.info('');
  ui.table(
    summaryRows({
      cwd,
      map: result.map,
      confirmedBackendHosts: result.confirmedBackendHosts,
      blockedRequests: progress.blockedRequests(),
      runDir: ctx.dir,
      appMapPath: join(ctx.lookoverDir, APP_MAP_FILE),
      durationMs,
      ...(options.isMapOnly ? {} : { inspection }),
    }),
  );
  if (!options.isMapOnly) {
    reportFindings(result.findings);
  }
  reportHosts(savedHosts, result.blockedUnconfirmedHosts, progress.labelHost);
}

/**
 * The run's lenses, and the judge that reproduces what they and the observers find through those same
 * lenses. Fails with `E_RUN_FAILED` when the project's decisions cannot be read.
 */
async function createInspectors(
  ctx: RunContext,
  options: RunOptions,
  lookoverVersion: string,
): Promise<Inspectors> {
  if (options.isMapOnly) {
    return { lenses: [], judge: undefined };
  }
  const lenses = options.lenses.map(createLens);
  const judge = await createJudge({
    ctx,
    lenses,
    config: ctx.config,
    env: process.env,
    flags: options,
    lookoverVersion,
  });
  return { lenses, judge };
}

/**
 * Runs the discovery engine; a cancelled prompt exits 1 once the engine has closed the browser. The
 * hosts an `E_HOSTS_UNCONFIRMED` lists are labelled as the prompt labels them.
 */
async function discover(
  ctx: RunContext,
  cwd: string,
  options: RunOptions,
  progress: Progress,
  { lenses, judge }: Inspectors,
): Promise<ReviewResult> {
  const isInteractive = shouldPrompt({
    isYes: options.isYes,
    isStdinTTY: process.stdin.isTTY === true,
    isStdoutTTY: process.stdout.isTTY === true,
  });
  try {
    return await runReview(ctx, {
      cwd,
      ...(options.isHeaded ? { headless: false } : {}),
      lenses,
      ...(options.isMapOnly ? { observers: [] } : {}),
      ...(judge === undefined ? {} : { judge }),
      hooks: {
        confirmHosts: createConfirmHosts(isInteractive, progress.labelHost),
        onEvent: progress.onEvent,
      },
    });
  } catch (error) {
    progress.flushInFlight();
    if (error instanceof RunCancelledError) {
      cancel(error.message);
      process.exit(ui.EXIT_FAILURE);
    }
    throw labelUnconfirmedHosts(error, progress.labelHost);
  }
}

function createProgress(isInspecting: boolean): Progress {
  let blocked = 0;
  let hostKinds: HostKinds = new Map();
  let awaiting: ReadonlyMap<string, Screen> = new Map();
  return {
    onEvent: (event) => {
      hostKinds = withObservedHost(hostKinds, event);
      if (event.type === 'screen.captured') {
        // An inspected screen is shown once its inspection is reported, with what it yielded.
        if (isInspecting && !isFailedScreen(event.screen)) {
          awaiting = new Map(awaiting).set(event.screen.id, event.screen);
        } else {
          ui.info(progressLine(event.screen));
        }
      } else if (event.type === 'screen.inspected' && isInspecting) {
        const screen = awaiting.get(event.screenId);
        awaiting = new Map([...awaiting].filter(([id]) => id !== event.screenId));
        if (screen !== undefined) {
          reportInspected(screen, event.candidates, event.error);
        }
      } else if (event.type === 'request.blocked') {
        blocked += 1;
      }
    },
    blockedRequests: () => blocked,
    labelHost: (host) => hostLabel(host, hostKinds),
    flushInFlight: () => {
      for (const screen of awaiting.values()) {
        ui.info(progressLine(screen));
      }
      awaiting = new Map();
    },
  };
}

/** The screen's line with its candidates; an inspection that stopped on an error adds a warning. */
function reportInspected(screen: Screen, candidates: number, error: string | null): void {
  ui.info(progressLine(screen, candidates));
  if (error !== null) {
    ui.warn(`${screen.route}  inspection failed: ${error}`);
  }
}

/**
 * The confirmed findings by rule (the rejected ones are only counted, in the table), or the candidates
 * of a run that was not judged; then the note on how far they were judged, when there is one.
 */
function reportFindings(findings: FindingsFile): void {
  const lines = findingLines(findings);
  if (lines.length > 0) {
    ui.info('');
    for (const line of lines) {
      ui.info(line);
    }
  }
  const note = findingsNote(findings.judge);
  if (note !== null) {
    ui.info('');
    ui.info(note);
  }
}

function reportHosts(
  savedHosts: readonly string[],
  blockedHosts: readonly string[],
  labelHost: (host: string) => string,
): void {
  if (savedHosts.length > 0) {
    ui.success(`Saved to confirmedBackendHosts in ${CONFIG_FILENAME}: ${savedHosts.join(', ')}`);
  }
  if (blockedHosts.length > 0) {
    ui.warn(blockedHostsWarning(blockedHosts, labelHost));
  }
}

/** A progress line that fails to print must not stop the run; it becomes a warning. */
function onSubscriberError(error: unknown, event: RunEvent): void {
  const message = error instanceof Error ? error.message : String(error);
  ui.warn(`Could not show progress for ${event.type}: ${message}`);
}
