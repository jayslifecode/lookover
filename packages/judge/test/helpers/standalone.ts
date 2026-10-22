import { execFile } from 'node:child_process';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A package that depends on Playwright, so its copy is the one the workspace pins. */
const LENSES_PACKAGE = fileURLToPath(new URL('../../../lenses/package.json', import.meta.url));
const CORE_PACKAGE = fileURLToPath(new URL('../../../core/package.json', import.meta.url));
/** What the standalone script reads from the environment; a developer's own must not change a test. */
const SCRIPT_ENV = ['LOOKOVER_BASE_URL', 'HEADED', 'TIMES', 'STORAGE_STATE'];

export interface NodeResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Makes `playwright` importable from `dir`, as `npm i playwright` there would: a link to the workspace's copy. */
export async function linkPlaywright(dir: string): Promise<void> {
  const manifest = createRequire(LENSES_PACKAGE).resolve('playwright/package.json');
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await symlink(dirname(manifest), join(dir, 'node_modules', 'playwright'), 'dir');
}

/** The Playwright version core depends on: the one the script tells its reader to install. */
export async function pinnedPlaywright(): Promise<string> {
  const manifest = JSON.parse(await readFile(CORE_PACKAGE, 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const version = manifest.dependencies.playwright;
  if (version === undefined) throw new Error('core does not depend on playwright');
  return version;
}

/** Runs `node <args>` with this process's environment less the script's variables, plus `env`. */
export function runNode(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
  timeoutMs = 90_000,
): Promise<NodeResult> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !SCRIPT_ENV.includes(name)),
  );
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [...args],
      { encoding: 'utf8', env: { ...inherited, ...env }, timeout: timeoutMs },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}
