import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { BENCH_PACKAGE, BENCH_PORT, BENCH_URL, E2E_OUTPUT_DIR, REPO_ROOT } from './bench-env.js';

/*
 * Serves the bench app for the end-to-end suite: resets its data to the seed, starts
 * `pnpm --filter @jayslifecode/lookover-bench dev` (port 3123) in its own process group, waits for
 * `GET /login` to answer 200, and stops the whole group after the suite.
 */

const execFileAsync = promisify(execFile);

const READY_PATH = '/login';
const HTTP_OK = 200;
const READY_TIMEOUT_MS = 90_000;
/** The first request compiles the page, so one request may take a while. */
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const CONNECT_TIMEOUT_MS = 1_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const MS_PER_SECOND = 1_000;
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', '::1'];
const SERVER_LOG = join(E2E_OUTPUT_DIR, 'bench-dev.log');

export async function setup(): Promise<() => Promise<void>> {
  // Only this suite's logs, so a CI artifact never mixes in an earlier run's.
  rmSync(E2E_OUTPUT_DIR, { recursive: true, force: true });
  mkdirSync(E2E_OUTPUT_DIR, { recursive: true });
  if (await isPortInUse(BENCH_PORT)) {
    throw new Error(
      `Port ${BENCH_PORT} is already in use. The end-to-end suite starts its own bench app there and ` +
        `will not test against another server. Stop whatever listens on it ` +
        `(lsof -nP -iTCP:${BENCH_PORT} -sTCP:LISTEN) and run the suite again.`,
    );
  }
  await execFileAsync('pnpm', ['--filter', BENCH_PACKAGE, 'reset'], { cwd: REPO_ROOT });
  const server = startBenchServer();
  try {
    await waitUntilReady(server);
  } catch (error) {
    await stopBenchServer(server);
    throw error;
  }
  return () => stopBenchServer(server);
}

function startBenchServer(): ChildProcess {
  const log = openSync(SERVER_LOG, 'w');
  try {
    return spawn('pnpm', ['--filter', BENCH_PACKAGE, 'dev'], {
      cwd: REPO_ROOT,
      // Its own process group, so teardown stops pnpm, next dev and next's workers together.
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    });
  } finally {
    // The child has its own copy of the descriptor.
    closeSync(log);
  }
}

async function waitUntilReady(server: ChildProcess): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`The bench app exited before it was ready; see ${SERVER_LOG}`);
    }
    if (await answersOk(Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()))) {
      return;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `The bench app did not answer GET ${READY_PATH} with ${HTTP_OK} within ` +
      `${READY_TIMEOUT_MS / MS_PER_SECOND} s; see ${SERVER_LOG}`,
  );
}

async function answersOk(timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(`${BENCH_URL}${READY_PATH}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(Math.max(timeoutMs, 1)),
    });
    await response.body?.cancel();
    return response.status === HTTP_OK;
  } catch {
    // Not listening yet, or still compiling past the timeout: poll again.
    return false;
  }
}

/** SIGTERM to the group, then SIGKILL if it is still there; throws if even that leaves a process behind. */
async function stopBenchServer(server: ChildProcess): Promise<void> {
  const { pid } = server;
  if (pid === undefined) {
    return;
  }
  signalGroup(pid, 'SIGTERM');
  if (await waitForGroupExit(pid)) {
    return;
  }
  signalGroup(pid, 'SIGKILL');
  if (!(await waitForGroupExit(pid))) {
    throw new Error(`The bench app's process group ${pid} survived SIGKILL; port ${BENCH_PORT} may be taken`);
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') {
      throw error;
    }
  }
}

async function waitForGroupExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isGroupAlive(pid)) {
      return true;
    }
    await delay(POLL_INTERVAL_MS);
  }
  return !isGroupAlive(pid);
}

function isGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function isPortInUse(port: number): Promise<boolean> {
  const answers = await Promise.all(LOOPBACK_HOSTS.map((host) => acceptsConnection(host, port)));
  return answers.some(Boolean);
}

function acceptsConnection(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const settle = (isOpen: boolean) => {
      socket.destroy();
      resolve(isOpen);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}
