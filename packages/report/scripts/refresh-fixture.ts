/*
 * Rebuilds the report's fixtures from real, judged runs of the bench app:
 *
 *   pnpm --filter @jayslifecode/lookover-report refresh-fixture
 *
 * It needs the packages built (`pnpm --filter "./packages/**" build`) and port 3123 free. Like the
 * end-to-end suite's global setup, it resets the bench data and serves the bench (`next dev -p 3123`) in
 * its own process group, then runs the built CLI in a temporary project with the form login: an earlier
 * run of PREVIOUS_SCREENS screens, one of its findings marked intended, then the run of FIXTURE_SCREENS
 * screens. It writes
 *
 *   fixtures/run/                    the later run's directory: app-map.json, findings.json, run.jsonl, evidence/
 *   fixtures/previous-findings.json  the earlier run's findings, for drift
 *   fixtures/decisions.json          the project's decisions: the one intended finding
 *
 * The judge model is never asked (ANTHROPIC_API_KEY is left out of the CLI's environment), as in CI.
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { access, cp, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));
const CLI_ENTRY = join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');
const BENCH_APP_DIR = join(REPO_ROOT, 'bench', 'app');
const BENCH_PACKAGE = '@jayslifecode/lookover-bench';
const BENCH_PORT = 3123;
const BENCH_URL = `http://localhost:${BENCH_PORT}`;
const READY_PATH = '/login';
const HTTP_OK = 200;

const FIXTURE_SCREENS = 3;
const PREVIOUS_SCREENS = 2;
const RUN_FILES = ['app-map.json', 'findings.json', 'run.jsonl'];
const INTENDED_NOTE = 'Kept on purpose: the intended finding of the report fixture.';

const READY_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const RUN_TIMEOUT_MS = 360_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const BYTES_PER_KB = 1024;

const CREDENTIALS = { LOOKOVER_USERNAME: 'demo@lookover.dev', LOOKOVER_PASSWORD: 'demo-password' };
const FORM_AUTH = {
  type: 'form',
  loginUrl: '/login',
  usernameSelector: 'input[name="email"]',
  passwordSelector: 'input[name="password"]',
  submitSelector: 'button[type="submit"]',
  successUrl: `${BENCH_URL}/`,
};

interface FindingsSummary {
  findings: { id: string; title: string }[];
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function cliEnv(): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY: _left, ...rest } = process.env;
  return { ...rest, ...CREDENTIALS };
}

async function lookover(project: string, args: string[]): Promise<void> {
  await execFileAsync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: project,
    env: cliEnv(),
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: 16 * BYTES_PER_KB * BYTES_PER_KB,
  });
}

async function assertReady(): Promise<void> {
  try {
    await access(CLI_ENTRY);
  } catch {
    throw new Error(`The CLI is not built (${CLI_ENTRY}); run pnpm --filter "./packages/**" build first`);
  }
  if (await answersOk(BENCH_URL, POLL_INTERVAL_MS)) {
    throw new Error(
      `Something already answers on ${BENCH_URL}; stop it, this script serves the bench itself`,
    );
  }
}

async function answersOk(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(`${url}${READY_PATH}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.status === HTTP_OK;
  } catch {
    return false;
  }
}

function startBench(): ChildProcess {
  return spawn('pnpm', ['--filter', BENCH_PACKAGE, 'dev'], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
}

async function waitUntilReady(bench: ChildProcess): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (bench.exitCode !== null || bench.signalCode !== null)
      throw new Error('The bench exited before it was ready');
    if (await answersOk(BENCH_URL, REQUEST_TIMEOUT_MS)) return;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`The bench did not answer GET ${READY_PATH} within ${READY_TIMEOUT_MS} ms`);
}

function isGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopBench(bench: ChildProcess): Promise<void> {
  const { pid } = bench;
  if (pid === undefined || !isGroupAlive(pid)) return;
  process.kill(-pid, 'SIGTERM');
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (isGroupAlive(pid) && Date.now() < deadline) await delay(POLL_INTERVAL_MS);
  if (isGroupAlive(pid)) process.kill(-pid, 'SIGKILL');
}

async function initProject(project: string): Promise<void> {
  await lookover(project, [
    'init',
    '--non-interactive',
    '--base-url',
    BENCH_URL,
    '--root',
    BENCH_APP_DIR,
    '--interaction',
    'full',
    '--acknowledge-disposable-data',
  ]);
  const configPath = join(project, 'lookover.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  await writeFile(configPath, `${JSON.stringify({ ...config, auth: FORM_AUTH }, null, 2)}\n`, 'utf8');
}

async function runIds(project: string): Promise<string[]> {
  return readdir(join(project, '.lookover', 'runs')).catch(() => []);
}

/** Runs `lookover run` and returns the directory of the run it made. */
async function runOnce(project: string, maxScreens: number): Promise<string> {
  const before = new Set(await runIds(project));
  await lookover(project, ['run', '--yes', '--no-report', '--max-screens', String(maxScreens)]);
  const made = (await runIds(project)).filter((id) => !before.has(id));
  if (made.length !== 1 || made[0] === undefined)
    throw new Error(`Expected one new run, found ${made.length}`);
  return join(project, '.lookover', 'runs', made[0]);
}

async function readFindings(runDir: string): Promise<FindingsSummary> {
  return JSON.parse(await readFile(join(runDir, 'findings.json'), 'utf8')) as FindingsSummary;
}

/** Marks the earlier run's last confirmed finding intended, so the fixture has one. */
async function markOneIntended(project: string, previousRunDir: string): Promise<string> {
  const { findings } = await readFindings(previousRunDir);
  const chosen = findings.at(-1);
  if (chosen === undefined) throw new Error('The earlier run confirmed no finding to mark intended');
  await lookover(project, ['mark', chosen.id, 'intended', '--note', INTENDED_NOTE]);
  return chosen.id;
}

async function sizeOf(path: string): Promise<number> {
  const info = await stat(path);
  if (!info.isDirectory()) return info.size;
  const entries = await readdir(path);
  const sizes = await Promise.all(entries.map((entry) => sizeOf(join(path, entry))));
  return sizes.reduce((sum, size) => sum + size, 0);
}

/**
 * The run log names the temporary project by its absolute path (the saved login state's `statePath`);
 * the fixture says it relative to the project instead. Evidence files are content-addressed and hold no
 * paths, so they stay as produced.
 */
async function relativiseProjectPaths(project: string, files: string[]): Promise<void> {
  const prefixes = [`${await realpath(project)}/`, `${project}/`];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const relative = prefixes.reduce((current, prefix) => current.replaceAll(prefix, ''), text);
    if (relative !== text) await writeFile(file, relative, 'utf8');
  }
}

async function writeFixtures(project: string, previousRunDir: string, runDir: string): Promise<void> {
  const fixtureRun = join(FIXTURES_DIR, 'run');
  await rm(fixtureRun, { recursive: true, force: true });
  await cp(runDir, fixtureRun, { recursive: true });
  await cp(join(previousRunDir, 'findings.json'), join(FIXTURES_DIR, 'previous-findings.json'));
  await cp(join(project, '.lookover', 'decisions.json'), join(FIXTURES_DIR, 'decisions.json'));
  await relativiseProjectPaths(project, [
    ...RUN_FILES.map((file) => join(fixtureRun, file)),
    join(FIXTURES_DIR, 'previous-findings.json'),
    join(FIXTURES_DIR, 'decisions.json'),
  ]);
}

async function refresh(): Promise<void> {
  await assertReady();
  await execFileAsync('pnpm', ['--filter', BENCH_PACKAGE, 'reset'], { cwd: REPO_ROOT });
  const bench = startBench();
  const project = await mkdtemp(join(tmpdir(), 'lookover-report-fixture-'));
  try {
    await waitUntilReady(bench);
    say(`Bench ready at ${BENCH_URL}`);
    await initProject(project);
    const previousRunDir = await runOnce(project, PREVIOUS_SCREENS);
    say(`Earlier run: ${previousRunDir}`);
    const intendedId = await markOneIntended(project, previousRunDir);
    say(`Marked intended: ${intendedId}`);
    const runDir = await runOnce(project, FIXTURE_SCREENS);
    say(`Fixture run: ${runDir}`);
    await writeFixtures(project, previousRunDir, runDir);
    const { findings } = await readFindings(runDir);
    const kb = Math.round((await sizeOf(FIXTURES_DIR)) / BYTES_PER_KB);
    say(`Wrote ${FIXTURES_DIR}: ${findings.length} confirmed findings, ${kb} KB`);
  } finally {
    await rm(project, { recursive: true, force: true });
    await stopBench(bench);
  }
}

await refresh();
