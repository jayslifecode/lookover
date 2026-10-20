import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Framework } from './init-config.js';

export type GitignoreChange = 'created' | 'updated' | 'unchanged';

const IGNORED_ENTRY = '.lookover/';
const IGNORED_ENTRY_SPELLINGS: readonly string[] = ['.lookover/', '.lookover'];

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function dependencyNames(manifest: unknown): ReadonlySet<string> {
  if (typeof manifest !== 'object' || manifest === null) {
    return new Set();
  }
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies']) {
    const group: unknown = (manifest as Record<string, unknown>)[field];
    if (typeof group === 'object' && group !== null) {
      for (const name of Object.keys(group)) {
        names.add(name);
      }
    }
  }
  return names;
}

/**
 * Guesses the framework from the `package.json` in `rootDir`. A missing or unreadable manifest is
 * not an error: the user is asked (or told to pass `--framework`) instead.
 */
export async function detectFramework(rootDir: string): Promise<Framework> {
  const raw = await readIfPresent(join(rootDir, 'package.json'));
  if (raw === undefined) {
    return 'unknown';
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return 'unknown';
  }
  const names = dependencyNames(manifest);
  if (names.has('next')) {
    return 'next';
  }
  return names.has('vite') && names.has('react') ? 'vite-react' : 'unknown';
}

/** Makes sure `.lookover/` (run artifacts, screenshots, session state) never reaches git. */
export async function ensureGitignored(cwd: string): Promise<GitignoreChange> {
  const path = join(cwd, '.gitignore');
  const existing = await readIfPresent(path);
  const lines = (existing ?? '').split(/\r?\n/).map((line) => line.trim());
  if (lines.some((line) => IGNORED_ENTRY_SPELLINGS.includes(line))) {
    return 'unchanged';
  }
  const separator = existing === undefined || existing === '' || existing.endsWith('\n') ? '' : '\n';
  await writeFile(path, `${existing ?? ''}${separator}${IGNORED_ENTRY}\n`, 'utf8');
  return existing === undefined ? 'created' : 'updated';
}
