import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LookoverError } from '../errors.js';
import type { RunContext } from '../run/run-context.js';
import { isMissingFile, writeFileAtomic } from '../util/fs.js';
import { redactDeep } from '../util/redact.js';
import type { FindingsFile } from './types.js';

/** The findings' file name, in the run directory and in the lookover directory (the project's latest). */
export const FINDINGS_FILE = 'findings.json';
const SUPPORTED_VERSION = 1;
const REBUILD_HINT = 'Delete the file and run again to rebuild the findings';

/**
 * Writes the findings, redacted, to `<run dir>/findings.json` and to `<lookover dir>/findings.json`
 * (the project's latest), each atomically, so a reader never sees a partial file. Both files hold the
 * same bytes. `file` itself is not modified.
 */
export async function writeFindings(
  ctx: RunContext,
  file: FindingsFile,
): Promise<{ runPath: string; latestPath: string }> {
  const runPath = resolve(ctx.dir, FINDINGS_FILE);
  const latestPath = resolve(ctx.lookoverDir, FINDINGS_FILE);
  const content = `${JSON.stringify(redactDeep(file), null, 2)}\n`;
  await writeFileAtomic(runPath, content);
  await writeFileAtomic(latestPath, content);
  return { runPath, latestPath };
}

/** Returns the project's latest findings, or `null` when no run has written any yet. */
export async function readLatestFindings(lookoverDir: string): Promise<FindingsFile | null> {
  const path = resolve(lookoverDir, FINDINGS_FILE);
  const raw = await readIfPresent(path);
  if (raw === null) return null;
  return parseFindings(raw, path);
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function parseFindings(raw: string, path: string): FindingsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new LookoverError(
      'E_RUN_FAILED',
      `Could not read the findings at ${path}: not valid JSON (${reason})`,
      REBUILD_HINT,
    );
  }
  if (!looksLikeFindingsFile(parsed)) {
    throw new LookoverError(
      'E_RUN_FAILED',
      `Could not read the findings at ${path}: expected "version": ${SUPPORTED_VERSION} with "findings" and "worthALook" lists`,
      REBUILD_HINT,
    );
  }
  // Only the shape of the top level is checked: this file is written by `writeFindings`, not by users.
  return parsed;
}

function looksLikeFindingsFile(value: unknown): value is FindingsFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === SUPPORTED_VERSION &&
    'findings' in value &&
    Array.isArray(value.findings) &&
    'worthALook' in value &&
    Array.isArray(value.worthALook)
  );
}
