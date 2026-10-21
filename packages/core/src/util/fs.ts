import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

const PERMISSION_BITS = 0o777;

export interface WriteFileAtomicOptions {
  /**
   * Permission bits for the new file, such as `0o600` (the umask still applies). When absent and
   * `path` is an existing file, that file's permission bits are kept; otherwise `0o666` (umask applies).
   */
  readonly mode?: number;
}

/**
 * Replaces `path` with `data` so a reader sees the old file or the new one, never partial bytes:
 * `data` goes to a new temporary file next to `path` (same directory, so the rename cannot cross
 * file systems), which is then renamed onto `path`. When either step fails, the temporary file is
 * removed and that step's error is rethrown. A replaced file keeps its permission bits unless
 * `options.mode` says otherwise.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const keptMode = options.mode === undefined ? await modeOfExistingFile(path) : undefined;
  try {
    await writeFile(temp, data, {
      flag: 'wx',
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    if (keptMode !== undefined) {
      // chmod, not the writeFile mode: the umask would clear bits the replaced file had.
      await chmod(temp, keptMode);
    }
    await rename(temp, path);
  } catch (error) {
    // The write or rename error is the one worth surfacing; a failed cleanup on top of it adds nothing.
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The permission bits of the regular file at `path`; `undefined` when there is none to keep them from. */
async function modeOfExistingFile(path: string): Promise<number | undefined> {
  try {
    const stats = await stat(path);
    return stats.isFile() ? stats.mode & PERMISSION_BITS : undefined;
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
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

/** The text of the file at `path`; `null` when the file does not exist. Any other failure is thrown. */
export async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}
