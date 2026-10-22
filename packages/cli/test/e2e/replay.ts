import { execFile } from 'node:child_process';
import { mkdir, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { AppMap, Finding, FindingsFile } from '@jayslifecode/lookover-core';
import type { CliResult } from '../run-cli.js';
import { REPO_ROOT } from './bench-env.js';
import { findingsFor, readSeeds, reportsSeed } from './seeds.js';

/*
 * What the suite needs to replay a seed: its finding, and a standalone script's Playwright and process.
 */

/** Core depends on Playwright, so its copy is the one the workspace pins. */
const CORE_PACKAGE = join(REPO_ROOT, 'packages', 'core', 'package.json');
/** What a standalone script reads from the environment; this process's own must not change a test. */
const SCRIPT_ENV: readonly string[] = ['LOOKOVER_BASE_URL', 'HEADED', 'TIMES', 'STORAGE_STATE'];

/** The finding that reports the seed `seedId`, as the run wrote it. */
export async function seedFinding(file: FindingsFile, map: AppMap, seedId: string): Promise<Finding> {
  const { issues } = await readSeeds();
  const seed = issues.find(({ id }) => id === seedId);
  if (seed === undefined) throw new Error(`bench/seeds.json has no seed ${seedId}`);
  const finding = findingsFor(file, seed).find((candidate) => reportsSeed(candidate, seed, map));
  if (finding === undefined) throw new Error(`the run found nothing for ${seedId}`);
  return finding;
}

/** Makes `playwright` importable from `dir`, as `npm i playwright` there would: a link to the workspace's copy. */
export async function linkPlaywright(dir: string): Promise<void> {
  const manifest = createRequire(CORE_PACKAGE).resolve('playwright/package.json');
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await symlink(dirname(manifest), join(dir, 'node_modules', 'playwright'), 'dir');
}

/** Runs `node <script>` in `cwd` with this process's environment less the script's variables, plus `env`. */
export function runScript(
  cwd: string,
  script: string,
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<CliResult> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !SCRIPT_ENV.includes(name)),
  );
  const startedAt = performance.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script],
      { cwd, encoding: 'utf8', env: { ...inherited, ...env }, timeout: timeoutMs },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr, durationMs: performance.now() - startedAt });
      },
    );
  });
}
