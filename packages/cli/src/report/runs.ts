import type { Stats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { FINDINGS_FILE, isMissingFile } from '@jayslifecode/lookover-core';

/*
 * The runs of a project, as `.lookover/runs/<runId>/` holds them. A run id is `YYYYMMDD-HHmmss-xxxx`,
 * so the lexical order of the ids is the order the runs started in. A run that wrote its `findings.json`
 * is over; one without it is going on, or stopped before the end.
 */

export const LOOKOVER_DIR = '.lookover';
export const RUNS_DIR = 'runs';
export const RUN_LOG_FILE = 'run.jsonl';
export const EVIDENCE_DIR = 'evidence';
/** A run directory's name: no separator or dot can lead it out of `.lookover/runs`. */
export const RUN_ID = /^[0-9A-Za-z][\w-]*$/;

/** `<lookoverDir>/runs/<runId>`. */
export function runDirOf(lookoverDir: string, runId: string): string {
  return join(lookoverDir, RUNS_DIR, runId);
}

/** Whether `runId` names a directory of `<lookoverDir>/runs`. */
export async function runExists(lookoverDir: string, runId: string): Promise<boolean> {
  if (!RUN_ID.test(runId)) return false;
  const stats = await statIfPresent(runDirOf(lookoverDir, runId));
  return stats?.isDirectory() ?? false;
}

/** The latest run that wrote its findings; `null` when no run has. */
export async function latestFinishedRun(lookoverDir: string): Promise<string | null> {
  return lastFinished(lookoverDir, await runIds(lookoverDir));
}

/** The run before `runId` that wrote its findings, for the drift since then; `null` when none did. */
export async function previousFinishedRun(lookoverDir: string, runId: string): Promise<string | null> {
  const earlier = (await runIds(lookoverDir)).filter((id) => id < runId);
  return lastFinished(lookoverDir, earlier);
}

/** The last of `ids` whose directory holds a findings file; `null` when none does. */
async function lastFinished(lookoverDir: string, ids: readonly string[]): Promise<string | null> {
  for (const id of [...ids].reverse()) {
    const findings = await statIfPresent(join(runDirOf(lookoverDir, id), FINDINGS_FILE));
    if (findings?.isFile() === true) return id;
  }
  return null;
}

/** Every run directory's id, in the order the runs started; none when there is no runs directory. */
async function runIds(lookoverDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(lookoverDir, RUNS_DIR), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

async function statIfPresent(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}
