import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { hasErrorCode, isMissingFile, writeFileAtomic } from '../src/util/fs.js';

const PERMISSION_BITS = 0o777;
const PRIVATE_FILE_MODE = 0o600;
const GROUP_READABLE_FILE_MODE = 0o640;

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('writeFileAtomic', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lookover-fs-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('creates the file with the data, leaving no temporary file behind', async () => {
    const path = join(dir, 'out.json');

    await writeFileAtomic(path, '{"a":1}\n');

    expect(await readFile(path, 'utf8')).toBe('{"a":1}\n');
    expect(await readdir(dir)).toEqual(['out.json']);
  });

  test('replaces an existing file, and writes bytes as given', async () => {
    const path = join(dir, 'out.bin');
    await writeFile(path, 'old');

    await writeFileAtomic(path, Buffer.from([1, 2, 3]));

    expect([...(await readFile(path))]).toEqual([1, 2, 3]);
    expect(await readdir(dir)).toEqual(['out.bin']);
  });

  test.skipIf(process.platform === 'win32')('creates the file with the given mode', async () => {
    const path = join(dir, 'private.json');

    await writeFileAtomic(path, '{}', { mode: PRIVATE_FILE_MODE });

    expect((await stat(path)).mode & PERMISSION_BITS).toBe(PRIVATE_FILE_MODE);
  });

  test.skipIf(process.platform === 'win32')('keeps the mode of the file it replaces', async () => {
    const path = join(dir, 'private.json');
    await writeFile(path, 'a');
    await chmod(path, PRIVATE_FILE_MODE);

    await writeFileAtomic(path, 'b');

    expect(await readFile(path, 'utf8')).toBe('b');
    expect((await stat(path)).mode & PERMISSION_BITS).toBe(PRIVATE_FILE_MODE);
  });

  test.skipIf(process.platform === 'win32')('uses options.mode over the existing mode', async () => {
    const path = join(dir, 'private.json');
    await writeFile(path, 'a');
    await chmod(path, PRIVATE_FILE_MODE);

    await writeFileAtomic(path, 'b', { mode: GROUP_READABLE_FILE_MODE });

    expect((await stat(path)).mode & PERMISSION_BITS).toBe(GROUP_READABLE_FILE_MODE);
  });

  test('rejects with the rename error and removes the temporary file when the target is a directory', async () => {
    const path = join(dir, 'taken');
    await mkdir(path);

    const error = await errorOf(writeFileAtomic(path, 'data'));

    expect(error).toBeInstanceOf(Error);
    expect(await readdir(dir)).toEqual(['taken']);
  });

  test('rejects with ENOENT when the directory does not exist', async () => {
    const error = await errorOf(writeFileAtomic(join(dir, 'missing', 'out.json'), 'data'));

    expect(isMissingFile(error)).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('isMissingFile and hasErrorCode', () => {
  test('recognise a system error by its code', async () => {
    const error = await errorOf(readFile(join(tmpdir(), 'lookover-no-such-file', 'x')));

    expect(isMissingFile(error)).toBe(true);
    expect(hasErrorCode(error, 'ENOENT')).toBe(true);
    expect(hasErrorCode(error, 'ENOTDIR')).toBe(false);
  });

  test('are false for anything that is not a system error', () => {
    expect(isMissingFile(new Error('ENOENT'))).toBe(false);
    expect(isMissingFile({ code: 'ENOENT' })).toBe(false);
    expect(isMissingFile(undefined)).toBe(false);
  });
});
