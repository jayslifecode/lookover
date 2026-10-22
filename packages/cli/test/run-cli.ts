import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The built CLI: the `test` and `test:e2e` scripts build it first. */
export const CLI_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface RunCliOptions {
  /** Added to this process's environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Left out of the environment the CLI gets, whatever this process's holds. */
  readonly withoutEnv?: readonly string[];
  /** Kills the CLI after this long (it then exits non-zero). Default: no limit. */
  readonly timeoutMs?: number;
}

function childEnv(options: RunCliOptions): NodeJS.ProcessEnv {
  const removed = new Set(options.withoutEnv ?? []);
  const merged = { ...process.env, ...options.env };
  return Object.fromEntries(Object.entries(merged).filter(([name]) => !removed.has(name)));
}

/** Runs `lookover <args>` in `cwd` without a terminal and resolves with how it ended. */
export function runCli(
  cwd: string,
  args: readonly string[],
  options: RunCliOptions = {},
): Promise<CliResult> {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, ...args],
      {
        cwd,
        encoding: 'utf8',
        env: childEnv(options),
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr, durationMs: performance.now() - startedAt });
      },
    );
  });
}
