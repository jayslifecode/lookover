import { access, copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppMap, Finding, FindingsFile } from '@jayslifecode/lookover-core';
import { expect } from 'vitest';
import type { CliResult } from '../run-cli.js';
import { E2E_OUTPUT_DIR } from './bench-env.js';

/*
 * The project directory the suite runs Lookover in: its config, what the run wrote under `.lookover/`, and
 * the copy of it kept for a failed CI run.
 */

export const CREDENTIALS = {
  LOOKOVER_USERNAME: 'demo@lookover.dev',
  LOOKOVER_PASSWORD: 'demo-password',
} as const;

export const FORM_AUTH = {
  type: 'form',
  loginUrl: '/login',
  usernameSelector: 'input[name="email"]',
  passwordSelector: 'input[name="password"]',
  submitSelector: 'button[type="submit"]',
  successUrl: 'http://localhost:3123/',
} as const;

export async function patchConfig(dir: string, patch: Record<string, unknown>): Promise<void> {
  const path = join(dir, 'lookover.config.json');
  const config = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(path, `${JSON.stringify({ ...config, ...patch }, null, 2)}\n`, 'utf8');
}

export function readAll(paths: readonly string[]): Promise<Buffer[]> {
  return Promise.all(paths.map((path) => readFile(path)));
}

export async function onlyRunDir(project: string): Promise<string> {
  const runsDir = join(project, '.lookover', 'runs');
  const runs = await readdir(runsDir);
  expect(runs).toHaveLength(1);
  return join(runsDir, runs[0] ?? '');
}

export async function readAppMap(project: string): Promise<AppMap> {
  return JSON.parse(await readFile(join(project, '.lookover', 'app-map.json'), 'utf8')) as AppMap;
}

export async function readFindings(project: string): Promise<FindingsFile> {
  return JSON.parse(await readFile(join(project, '.lookover', 'findings.json'), 'utf8')) as FindingsFile;
}

/** What the run reports: the findings (confirmed, in a judged run) and the worth-a-look entries. */
export function allFindings(file: FindingsFile): Finding[] {
  return [...file.findings, ...file.worthALook];
}

export async function isMissing(path: string): Promise<boolean> {
  return access(path).then(
    () => false,
    () => true,
  );
}

/** Where `keepOutput` keeps a run's transcript (`<log>.log`), and what it prints when it has. */
export interface KeptOutput {
  readonly log: string;
  readonly label: string;
}

const BENCH_RUN_OUTPUT: KeptOutput = { log: 'lookover-run', label: 'lookover run' };

/** Keeps what the run printed, logged and found next to the bench server's log, for a failed CI run. */
export async function keepOutput(
  project: string,
  run: CliResult,
  { log, label }: KeptOutput = BENCH_RUN_OUTPUT,
): Promise<void> {
  const seconds = (run.durationMs / 1_000).toFixed(1);
  const transcript = [
    `exit ${run.code} after ${seconds} s`,
    '--- stdout ---',
    run.stdout,
    '--- stderr ---',
    run.stderr,
  ].join('\n');
  await writeFile(join(E2E_OUTPUT_DIR, `${log}.log`), transcript, 'utf8');
  const runs = await readdir(join(project, '.lookover', 'runs')).catch(() => []);
  for (const runId of runs) {
    for (const file of ['run.jsonl', 'findings.json']) {
      await copyFile(
        join(project, '.lookover', 'runs', runId, file),
        join(E2E_OUTPUT_DIR, `${runId}.${file}`),
      ).catch(() => undefined);
    }
  }
  process.stdout.write(`${label}: exit ${run.code} in ${seconds} s\n`);
}
