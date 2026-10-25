import { readFile } from 'node:fs/promises';
import { isMissingFile, type RunEvent } from '@jayslifecode/lookover-core';

/*
 * The run log as the report server reads it while `lookover run` may still be appending to it: only the
 * lines that are complete (their newline written) and hold a run event. A last line not written to its
 * end is left for a later read, and a line that is not an event is passed over. `RunLog.read` refuses the
 * whole log for either, which a live view of a run being written cannot afford.
 */

const NEWLINE = '\n';

/** The events of the complete lines of `text`, in order: whatever follows its last newline is not read. */
export function parseCompleteLines(text: string): RunEvent[] {
  const complete = text.slice(0, text.lastIndexOf(NEWLINE) + 1);
  return complete.split(NEWLINE).flatMap((line) => {
    const event = parseEvent(line);
    return event === null ? [] : [event];
  });
}

/** The events of the log at `file` so far, as `parseCompleteLines` reads them; none while it does not exist. */
export async function readRunEvents(file: string): Promise<RunEvent[]> {
  try {
    return parseCompleteLines(await readFile(file, 'utf8'));
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

function parseEvent(line: string): RunEvent | null {
  if (line.trim() === '') return null;
  try {
    const value: unknown = JSON.parse(line);
    return isRunEvent(value) ? value : null;
  } catch {
    return null;
  }
}

/** The envelope every line `RunLog` writes has; the body is trusted, as `RunLog.read` trusts it. */
function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== 'object' || value === null) return false;
  const { seq, at, type } = value as Record<string, unknown>;
  return Number.isInteger(seq) && typeof at === 'string' && typeof type === 'string';
}
