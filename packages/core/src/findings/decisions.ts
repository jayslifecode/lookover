import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { LookoverError } from '../errors.js';
import { readIfPresent, writeFileAtomic } from '../util/fs.js';
import { redactDeep } from '../util/redact.js';
import type { Finding, Judgement } from './types.js';

/** The user's decisions' file name, in the lookover directory. */
export const DECISIONS_FILE = 'decisions.json';
const HINT =
  'Fix the file, or delete it to forget every decision (the findings marked intended will be judged again)';

const decisionSchema = z.object({
  status: z.literal('intended'),
  at: z.string(),
  note: z.string().nullable(),
});

const decisionsFileSchema = z.object({
  version: z.literal(1),
  decisions: z.record(z.string(), decisionSchema),
});

/** The user's word on one finding: this is on purpose. */
export interface Decision {
  status: 'intended';
  /** When the user decided. */
  at: string;
  note: string | null;
}

/** `decisions.json`: the findings the user decided are intended, by finding id. */
export interface DecisionsFile {
  version: 1;
  decisions: Record<string, Decision>;
}

/**
 * The project's decisions: an empty file when none was written yet. Fails with `E_RUN_FAILED` when the
 * file cannot be read as JSON or does not have the shape of a decisions file.
 */
export async function readDecisions(lookoverDir: string): Promise<DecisionsFile> {
  const path = decisionsPath(lookoverDir);
  const raw = await readIfPresent(path);
  if (raw === null) return { version: 1, decisions: {} };
  return parseDecisions(raw, path);
}

/**
 * Records the user's `decision` for `findingId`, or forgets it when `decision` is `null`, and returns the
 * file as written. The file is replaced atomically, redacted like every stored blob; the other decisions
 * are kept. Fails with `E_RUN_FAILED`, writing nothing, when the existing file cannot be read.
 */
export async function writeDecision(
  lookoverDir: string,
  findingId: string,
  decision: Decision | null,
): Promise<DecisionsFile> {
  const current = await readDecisions(lookoverDir);
  const others = Object.entries(current.decisions).filter(([id]) => id !== findingId);
  const entries: [string, Decision][] = decision === null ? others : [...others, [findingId, decision]];
  const decisions = Object.fromEntries(entries);
  const next = redactDeep<DecisionsFile>({ version: 1, decisions });
  await mkdir(lookoverDir, { recursive: true });
  await writeFileAtomic(decisionsPath(lookoverDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * Splits `findings` by the user's decisions: the undecided ones are `kept`, in order, as they are; each
 * decided one is `intended`, with the status `intended` and a judgement by the user (nothing was
 * reproduced, so `of` is 0) that carries the decision's note and `now` as the time. The inputs are
 * untouched.
 */
export function applyDecisions(
  findings: readonly Finding[],
  decisions: DecisionsFile,
  now: string,
): { kept: Finding[]; intended: Finding[] } {
  const decided = findings.map((finding) => ({ finding, decision: decisionFor(decisions, finding.id) }));
  return {
    kept: decided.filter(({ decision }) => decision === undefined).map(({ finding }) => finding),
    intended: decided.flatMap(({ finding, decision }) =>
      decision === undefined
        ? []
        : [{ ...finding, status: 'intended', judgement: userJudgement(decision, now) }],
    ),
  };
}

function decisionFor(decisions: DecisionsFile, findingId: string): Decision | undefined {
  return Object.hasOwn(decisions.decisions, findingId) ? decisions.decisions[findingId] : undefined;
}

function userJudgement(decision: Decision, now: string): Judgement {
  return {
    reproduced: 0,
    of: 0,
    attempts: [],
    decidedBy: 'user',
    attribution: null,
    oracle: null,
    note: decision.note,
    model: null,
    usage: null,
    estimatedUsd: null,
    cached: false,
    droppedOccurrences: [],
    environment: null,
    judgedAt: now,
  };
}

function decisionsPath(lookoverDir: string): string {
  return resolve(lookoverDir, DECISIONS_FILE);
}

function parseDecisions(raw: string, path: string): DecisionsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw unreadable(path, `not valid JSON (${reason})`);
  }
  const result = decisionsFileSchema.safeParse(parsed);
  if (!result.success) {
    throw unreadable(path, result.error.issues.map(describeIssue).join('; '));
  }
  return result.data;
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const where = issue.path.length > 0 ? issue.path.map(String).join('.') : 'the file';
  return `${where}: ${issue.message}`;
}

function unreadable(path: string, problem: string): LookoverError {
  return new LookoverError('E_RUN_FAILED', `Could not read the decisions at ${path}: ${problem}`, HINT);
}
