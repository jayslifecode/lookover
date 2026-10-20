import { access, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { EvidenceStore } from '../src/evidence/store.js';
import { sha256 } from '../src/util/hash.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ID_LENGTH = 16;

function png(...payload: number[]): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.from(payload)]);
}

describe('EvidenceStore', () => {
  let runDir: string;
  let store: EvidenceStore;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'lookover-evidence-'));
    store = new EvidenceStore(runDir);
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  async function evidenceFiles(): Promise<string[]> {
    return (await readdir(join(runDir, 'evidence'))).sort();
  }

  describe('putPng', () => {
    test('returns a ref keyed by the first 16 hex chars of the sha256 of the bytes', async () => {
      const buffer = png(1, 2, 3);

      const ref = await store.putPng(buffer);

      const id = sha256(buffer).slice(0, ID_LENGTH);
      expect(ref).toEqual({ id, path: `evidence/${id}.png`, bytes: buffer.length, kind: 'png' });
      expect(await readFile(join(runDir, ref.path))).toEqual(buffer);
    });

    test('stores identical bytes once and returns the same ref', async () => {
      const first = await store.putPng(png(1, 2, 3));
      const second = await store.putPng(png(1, 2, 3));

      expect(second).toEqual(first);
      expect(await evidenceFiles()).toEqual([`${first.id}.png`]);
    });

    test('does not rewrite a file that already exists', async () => {
      const buffer = png(4, 5, 6);
      const first = await store.putPng(buffer);
      const before = await stat(join(runDir, first.path));

      await new Promise((resolve) => setTimeout(resolve, 20));
      await store.putPng(buffer);

      const after = await stat(join(runDir, first.path));
      expect(after.mtimeMs).toBe(before.mtimeMs);
    });

    test('stores different bytes as separate files', async () => {
      const a = await store.putPng(png(1));
      const b = await store.putPng(png(2));

      expect(a.id).not.toBe(b.id);
      expect(await evidenceFiles()).toEqual([`${a.id}.png`, `${b.id}.png`].sort());
    });

    test('stores identical bytes written concurrently once, without leaving temp files', async () => {
      const buffer = png(7, 7, 7);

      const refs = await Promise.all(Array.from({ length: 8 }, () => store.putPng(buffer)));

      const [first] = refs;
      expect(first).toBeDefined();
      for (const ref of refs) expect(ref).toEqual(first);
      expect(await evidenceFiles()).toEqual([`${first?.id}.png`]);
    });

    test('creates the evidence directory lazily on first write', async () => {
      await expect(access(join(runDir, 'evidence'))).rejects.toMatchObject({ code: 'ENOENT' });

      await store.putPng(png(9));

      await expect(access(join(runDir, 'evidence'))).resolves.toBeUndefined();
    });
  });

  describe('putJson', () => {
    test('redacts values before they reach disk', async () => {
      const ref = await store.putJson('page', { email: 'a@b.c', note: 'contact jane@example.com' });

      const text = await readFile(join(runDir, ref.path), 'utf8');
      expect(text).toContain('[email]');
      expect(text).not.toContain('a@b.c');
      expect(text).not.toContain('jane@example.com');
    });

    test('redacts values under sensitive keys', async () => {
      const ref = await store.putJson('headers', { authorization: 'Bearer abcdefghijklmnop1234567890' });

      const text = await readFile(join(runDir, ref.path), 'utf8');
      expect(text).not.toContain('abcdefghijklmnop1234567890');
    });

    test('stores pretty-printed JSON with a trailing newline under evidence/<name>-<id>.json', async () => {
      const ref = await store.putJson('page', { title: 'Home', links: [1, 2] });

      const text = await readFile(join(runDir, ref.path), 'utf8');
      expect(text).toBe(`${JSON.stringify({ title: 'Home', links: [1, 2] }, null, 2)}\n`);
      const id = sha256(Buffer.from(text, 'utf8')).slice(0, ID_LENGTH);
      expect(ref).toEqual({
        id,
        path: `evidence/page-${id}.json`,
        bytes: Buffer.byteLength(text, 'utf8'),
        kind: 'json',
      });
    });

    test('hashes the redacted bytes, so values differing only in a secret share a ref', async () => {
      const a = await store.putJson('page', { email: 'one@example.com' });
      const b = await store.putJson('page', { email: 'two@example.com' });

      expect(b).toEqual(a);
      expect(await evidenceFiles()).toEqual([`page-${a.id}.json`]);
    });

    test('does not mutate the value it is given', async () => {
      const value = { email: 'a@b.c' };

      await store.putJson('page', value);

      expect(value).toEqual({ email: 'a@b.c' });
    });

    test.each([
      ['Home Page', 'home-page'],
      ['../../etc/passwd', 'etc-passwd'],
      ['a///b', 'a-b'],
      ['UPPER_case.v2', 'upper-case-v2'],
    ])('sanitises the name %j to %j in the filename', async (name, expected) => {
      const ref = await store.putJson(name, { ok: true });

      expect(ref.path).toBe(`evidence/${expected}-${ref.id}.json`);
      expect(await evidenceFiles()).toEqual([`${expected}-${ref.id}.json`]);
    });

    test('stores a value with no JSON representation as null', async () => {
      const ref = await store.putJson('nothing', undefined);

      expect(await readFile(join(runDir, ref.path), 'utf8')).toBe('null\n');
    });

    test('falls back to a placeholder name when sanitising leaves nothing', async () => {
      const ref = await store.putJson('!!!', { ok: true });

      expect(ref.path).toBe(`evidence/data-${ref.id}.json`);
    });
  });

  describe('resolve', () => {
    test('returns an absolute path to an existing file', async () => {
      const pngRef = await store.putPng(png(1));
      const jsonRef = await store.putJson('page', { ok: true });

      for (const ref of [pngRef, jsonRef]) {
        const resolved = store.resolve(ref);
        expect(isAbsolute(resolved)).toBe(true);
        expect(resolved).toBe(join(runDir, ref.path));
        await expect(access(resolved)).resolves.toBeUndefined();
      }
    });
  });

  describe('list', () => {
    test('returns an empty array before anything is written', async () => {
      expect(await store.list()).toEqual([]);
    });

    test('returns refs of both kinds, sorted by path', async () => {
      const pngRef = await store.putPng(png(1));
      const jsonRef = await store.putJson('page', { ok: true });
      const otherPng = await store.putPng(png(2));

      const listed = await store.list();

      const expectedPaths = [pngRef, jsonRef, otherPng].map((ref) => ref.path).sort();
      expect(listed.map((ref) => ref.path)).toEqual(expectedPaths);
      expect(listed).toHaveLength(3);
      expect(listed).toContainEqual(pngRef);
      expect(listed).toContainEqual(jsonRef);
      expect(listed).toContainEqual(otherPng);
    });

    test('rebuilds refs for a fresh store over the same run directory', async () => {
      const pngRef = await store.putPng(png(1));
      const jsonRef = await store.putJson('page-map', { ok: true });

      const listed = await new EvidenceStore(runDir).list();

      expect(listed).toHaveLength(2);
      expect(listed).toContainEqual(pngRef);
      expect(listed).toContainEqual(jsonRef);
    });
  });
});
