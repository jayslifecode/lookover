import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LookoverConfig } from '../config/schema.js';
import { EvidenceStore } from '../evidence/store.js';
import { RunLog } from './run-log.js';

const LOOKOVER_DIR = '.lookover';
const RUNS_DIR = 'runs';
const EVIDENCE_DIR = 'evidence';
const RUN_LOG_FILE = 'run.jsonl';

const SUFFIX_RADIX = 36;
const SUFFIX_LENGTH = 4;
const SUFFIX_VALUES = SUFFIX_RADIX ** SUFFIX_LENGTH;
const SUFFIX_RANDOM_BYTES = 4;

/** Everything one run needs, created once and passed down to every stage. */
export interface RunContext {
  readonly runId: string;
  /** `<lookoverDir>/runs/<runId>`: the run's log and evidence live here. */
  readonly dir: string;
  readonly lookoverDir: string;
  readonly log: RunLog;
  readonly evidence: EvidenceStore;
  readonly config: LookoverConfig;
  readonly startedAt: Date;
}

export interface CreateRunOptions {
  cwd: string;
  config: LookoverConfig;
  now?: Date;
  /** Returns the 4-character suffix of the run id. Injectable so ids are predictable in tests. */
  random?: () => string;
}

export async function createRun(options: CreateRunOptions): Promise<RunContext> {
  const { cwd, config, now = new Date(), random = randomSuffix } = options;
  const runId = formatRunId(now, random());
  const lookoverDir = join(cwd, LOOKOVER_DIR);
  const dir = join(lookoverDir, RUNS_DIR, runId);
  await mkdir(join(dir, EVIDENCE_DIR), { recursive: true });
  const log = await RunLog.open(join(dir, RUN_LOG_FILE), runId);
  return { runId, dir, lookoverDir, log, evidence: new EvidenceStore(dir), config, startedAt: now };
}

/** `YYYYMMDD-HHmmss-<suffix>` in local time, so the id matches the clock the user is looking at. */
function formatRunId(now: Date, suffix: string): string {
  const year = pad(now.getFullYear(), 4);
  const date = `${year}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}-${suffix}`;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function randomSuffix(): string {
  const value = randomBytes(SUFFIX_RANDOM_BYTES).readUInt32BE(0) % SUFFIX_VALUES;
  return value.toString(SUFFIX_RADIX).padStart(SUFFIX_LENGTH, '0');
}
