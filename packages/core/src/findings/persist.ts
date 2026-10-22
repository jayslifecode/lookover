import { resolve } from 'node:path';
import { LookoverError } from '../errors.js';
import type { RunContext } from '../run/run-context.js';
import { readIfPresent, writeFileAtomic } from '../util/fs.js';
import { redactDeep } from '../util/redact.js';
import type { Finding, FindingsFile, OccurrenceFinding, SkipTally, StepFinding } from './types.js';

/** The findings' file name, in the run directory and in the lookover directory (the project's latest). */
export const FINDINGS_FILE = 'findings.json';
const LEGACY_VERSION = 1;
const CURRENT_VERSION = 2;
const REBUILD_HINT = 'Delete the file and run again to rebuild the findings';
const NO_FILE_HINT = 'Run lookover run to write one';

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

/**
 * Returns the project's latest findings, or `null` when no run has written any yet. A version 1 file (no
 * judge existed yet) is upgraded in memory to the version 2 shape, every finding still a candidate; the
 * file on disk is left as it is. Any other version fails with `E_RUN_FAILED`.
 */
export async function readLatestFindings(lookoverDir: string): Promise<FindingsFile | null> {
  const path = resolve(lookoverDir, FINDINGS_FILE);
  const raw = await readIfPresent(path);
  if (raw === null) return null;
  return parseFindings(raw, path);
}

/**
 * Reads the findings file at `path`, such as one run's `<run dir>/findings.json`, as `readLatestFindings`
 * reads the latest (a version 1 file upgraded in memory). Fails with `E_RUN_FAILED` when there is no file
 * there or it is not a findings file.
 */
export async function readFindingsAt(path: string): Promise<FindingsFile> {
  const raw = await readIfPresent(path);
  if (raw === null) {
    throw new LookoverError('E_RUN_FAILED', `There is no findings file at ${path}`, NO_FILE_HINT);
  }
  return parseFindings(raw, path);
}

/** A finding as version 1 wrote it: the same, without `judgement`. */
type LegacyFinding = Omit<StepFinding, 'judgement'> | Omit<OccurrenceFinding, 'judgement'>;

/** `findings.json` as version 1 wrote it: no judge existed, so every finding is a candidate. */
interface LegacyFindingsFile {
  version: typeof LEGACY_VERSION;
  runId: string;
  createdAt: string;
  findings: LegacyFinding[];
  worthALook: LegacyFinding[];
  skipped?: SkipTally[];
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
  // Only the shape of the top level is checked: this file is written by `writeFindings`, not by users.
  if (!isRecord(parsed)) throw unreadable(path, 'expected a findings object');
  if (parsed.version === CURRENT_VERSION) {
    if (!looksLikeFindingsFile(parsed)) throw unreadable(path, SHAPE_PROBLEM);
    return parsed;
  }
  if (parsed.version === LEGACY_VERSION) {
    if (!looksLikeLegacyFindingsFile(parsed)) throw unreadable(path, SHAPE_PROBLEM);
    return upgraded(parsed);
  }
  throw unreadable(
    path,
    `${describeVersion(parsed.version)} is not supported (this Lookover reads versions ${LEGACY_VERSION} and ${CURRENT_VERSION})`,
  );
}

const SHAPE_PROBLEM = `expected "version": ${CURRENT_VERSION} with "findings", "worthALook", "rejected" and "intended" lists (or "version": ${LEGACY_VERSION} with "findings" and "worthALook" lists)`;

function unreadable(path: string, problem: string): LookoverError {
  return new LookoverError(
    'E_RUN_FAILED',
    `Could not read the findings at ${path}: ${problem}`,
    REBUILD_HINT,
  );
}

function describeVersion(version: unknown): string {
  return typeof version === 'number' ? `version ${version}` : 'a file without a version number';
}

/** The version 1 file in the version 2 shape: nothing judged, nothing rejected or decided on. */
function upgraded(legacy: LegacyFindingsFile): FindingsFile {
  return {
    ...legacy,
    version: CURRENT_VERSION,
    findings: legacy.findings.map(withoutJudgement),
    worthALook: legacy.worthALook.map(withoutJudgement),
    rejected: [],
    intended: [],
    judge: null,
    environment: null,
  };
}

function withoutJudgement(finding: LegacyFinding): Finding {
  return { ...finding, judgement: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasLists(value: Record<string, unknown>, names: readonly string[]): boolean {
  return names.every((name) => Array.isArray(value[name]));
}

function looksLikeFindingsFile(
  value: Record<string, unknown>,
): value is Record<string, unknown> & FindingsFile {
  return hasLists(value, ['findings', 'worthALook', 'rejected', 'intended']);
}

function looksLikeLegacyFindingsFile(
  value: Record<string, unknown>,
): value is Record<string, unknown> & LegacyFindingsFile {
  return hasLists(value, ['findings', 'worthALook']);
}
