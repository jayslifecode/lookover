import { join } from 'node:path';
import {
  DECISIONS_FILE,
  FINDINGS_FILE,
  type FindingsFile,
  LookoverError,
  readDecisions,
  readLatestFindings,
  writeDecision,
} from '@jayslifecode/lookover-core';
import type { Command } from 'commander';
import * as ui from '../ui.js';
import { findFinding, parseFindingId } from './finding-id.js';

/** What `lookover mark <finding id> <status> [--note <text>]` is given. */
export interface MarkInput {
  readonly id: string;
  readonly status: string;
  readonly note?: string;
}

interface MarkFlags {
  readonly note?: string;
}

type MarkStatus = 'intended' | 'clear';

const STATUSES: readonly MarkStatus[] = ['intended', 'clear'];
/** Where `lookover run` keeps the project's findings and decisions, under the project directory. */
const LOOKOVER_DIR = '.lookover';
const FINDINGS_PATH = `${LOOKOVER_DIR}/${FINDINGS_FILE}`;
const STATUS_HINT = 'Use intended or clear, e.g. lookover mark <finding id> intended';

export function registerMark(program: Command): void {
  program
    .command('mark')
    .description(
      `Record that a finding is intended, so later runs leave it out, or clear that decision (${LOOKOVER_DIR}/${DECISIONS_FILE})`,
    )
    .argument(
      '<finding-id>',
      `the id of a finding in ${FINDINGS_PATH}, or the start of it that names one finding`,
    )
    .argument('<status>', 'intended, or clear to forget the decision')
    .option('--note <text>', 'why the finding is intended, kept with the decision')
    .action((id: string, status: string, flags: MarkFlags) =>
      runMark({ id, status, ...(flags.note === undefined ? {} : { note: flags.note }) }),
    );
}

/**
 * `lookover mark`: finds the finding in the project's latest findings (confirmed, rejected, intended or
 * worth a look) by its id or the start of it, then records it as intended in `decisions.json` or forgets
 * the decision on it, and says which. Fails with `E_USAGE`, writing nothing, for a status other than
 * `intended` or `clear`, a note with `clear`, an id no finding has, or a prefix several ids start with.
 */
export async function runMark(input: MarkInput, cwd: string = process.cwd()): Promise<void> {
  const query = parseFindingId(input.id, FINDINGS_PATH);
  const status = parseStatus(input.status);
  const note = parseNote(input.note, status);
  const lookoverDir = join(cwd, LOOKOVER_DIR);
  const { id } = findFinding(await latestFindings(lookoverDir), query, FINDINGS_PATH);
  if (status === 'intended') {
    await writeDecision(lookoverDir, id, { status: 'intended', at: new Date().toISOString(), note });
    ui.success(`Marked ${id} as intended`);
    return;
  }
  const { decisions } = await readDecisions(lookoverDir);
  if (!Object.hasOwn(decisions, id)) {
    ui.info(`${id} has no decision to clear`);
    return;
  }
  await writeDecision(lookoverDir, id, null);
  ui.success(`Cleared the decision on ${id}`);
}

function parseStatus(value: string): MarkStatus {
  const status = STATUSES.find((known) => known === value);
  if (status === undefined) {
    throw new LookoverError('E_USAGE', `"${value}" is not a decision`, STATUS_HINT);
  }
  return status;
}

/** The note of an `intended` decision; `null` without one. */
function parseNote(value: string | undefined, status: MarkStatus): string | null {
  if (value === undefined) {
    return null;
  }
  if (status !== 'intended') {
    throw new LookoverError('E_USAGE', '--note goes with intended', 'Leave --note out to clear a decision');
  }
  const note = value.trim();
  if (note === '') {
    throw new LookoverError(
      'E_USAGE',
      '--note is empty',
      'Say why the finding is intended, or leave --note out',
    );
  }
  return note;
}

async function latestFindings(lookoverDir: string): Promise<FindingsFile> {
  const file = await readLatestFindings(lookoverDir);
  if (file === null) {
    throw new LookoverError(
      'E_USAGE',
      'There are no findings to mark yet',
      `Run lookover run first, then mark a finding by the id in ${FINDINGS_PATH}`,
    );
  }
  return file;
}
