import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

export interface WriteFileAtomicOptions {
  /** Permission bits for the new file, such as `0o600` (the umask still applies). Default `0o666`. */
  readonly mode?: number;
}

/**
 * Replaces `path` with `data` so a reader sees the old file or the new one, never partial bytes:
 * `data` goes to a new temporary file next to `path` (same directory, so the rename cannot cross
 * file systems), which is then renamed onto `path`. When either step fails, the temporary file is
 * removed and that step's error is rethrown.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data, {
      flag: 'wx',
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    await rename(temp, path);
  } catch (error) {
    // The write or rename error is the one worth surfacing; a failed cleanup on top of it adds nothing.
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** True when `error` is a Node.js system error with this `code` (`ENOENT`, `ENOTDIR`, ...). */
export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** True when a file system call failed because the path does not exist (`ENOENT`). */
export function isMissingFile(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}
