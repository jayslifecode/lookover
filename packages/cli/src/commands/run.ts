import { join } from 'node:path';
import { cancel } from '@clack/prompts';
import {
  APP_MAP_FILE,
  CONFIG_FILENAME,
  createRun,
  type DiscoveryResult,
  loadConfig,
  type RunContext,
  type RunEvent,
  runDiscovery,
} from '@jayslifecode/lookover-core';
import type { Command } from 'commander';
import * as ui from '../ui.js';
import { type HostKinds, hostLabel, labelUnconfirmedHosts, withObservedHost } from './run-hosts.js';
import {
  collectRepeated,
  configForRun,
  parseRunFlags,
  type RunFlags,
  type RunOptions,
  saveConfirmedHosts,
} from './run-options.js';
import { createConfirmHosts, RunCancelledError, shouldPrompt } from './run-prompts.js';
import { blockedHostsWarning, progressLine, summaryRows } from './run-summary.js';

/**
 * Prints a line per captured screen, counts the blocked requests and notes what the app used each host
 * for, as the run log records them.
 */
interface Progress {
  readonly onEvent: (event: RunEvent) => void;
  readonly blockedRequests: () => number;
  /** A host as the CLI lists it (see `hostLabel`), from the events so far. */
  readonly labelHost: (host: string) => string;
}

export function registerRun(program: Command): void {
  program
    .command('run')
    .description('Open every screen of the app in a real browser and write .lookover/app-map.json')
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
    .action(runRun);
}

/**
 * `lookover run`: loads the config (the acknowledgement gate refuses an unacknowledged `full` run),
 * maps the app with this run's flags applied, prints the summary and saves the confirmed backend
 * hosts to the config. Errors propagate to `ui.fail`, which picks the exit code.
 */
export async function runRun(flags: RunFlags): Promise<void> {
  const cwd = process.cwd();
  const options = parseRunFlags(flags);
  const { config } = await loadConfig(cwd);
  const ctx = await createRun({ cwd, config: configForRun(config, options), onSubscriberError });
  ui.info(`Mapping ${config.baseUrl} (run ${ctx.runId})`);
  const progress = createProgress();
  const startedAt = performance.now();
  const result = await discover(ctx, cwd, options, progress);
  const durationMs = performance.now() - startedAt;

  const savedHosts = await saveConfirmedHosts(cwd, config, [
    ...options.confirmHosts,
    ...result.confirmedBackendHosts,
  ]);
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
    }),
  );
  reportHosts(savedHosts, result.blockedUnconfirmedHosts, progress.labelHost);
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
): Promise<DiscoveryResult> {
  const isInteractive = shouldPrompt({
    isYes: options.isYes,
    isStdinTTY: process.stdin.isTTY === true,
    isStdoutTTY: process.stdout.isTTY === true,
  });
  try {
    return await runDiscovery(ctx, {
      cwd,
      ...(options.isHeaded ? { headless: false } : {}),
      hooks: {
        confirmHosts: createConfirmHosts(isInteractive, progress.labelHost),
        onEvent: progress.onEvent,
      },
    });
  } catch (error) {
    if (error instanceof RunCancelledError) {
      cancel(error.message);
      process.exit(ui.EXIT_FAILURE);
    }
    throw labelUnconfirmedHosts(error, progress.labelHost);
  }
}

function createProgress(): Progress {
  let blocked = 0;
  let hostKinds: HostKinds = new Map();
  return {
    onEvent: (event) => {
      hostKinds = withObservedHost(hostKinds, event);
      if (event.type === 'screen.captured') {
        ui.info(progressLine(event.screen));
      } else if (event.type === 'request.blocked') {
        blocked += 1;
      }
    },
    blockedRequests: () => blocked,
    labelHost: (host) => hostLabel(host, hostKinds),
  };
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
