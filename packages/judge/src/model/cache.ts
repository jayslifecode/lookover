import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMissingFile, redactDeep, writeFileAtomic } from '@jayslifecode/lookover-core';
import { z } from 'zod';
import { readVerdict, type Verdict } from './schema.js';

/** Where verdicts are cached, under the project's `.lookover/` directory: one `<hash>.json` per bundle. */
export const JUDGE_CACHE_DIR = 'cache/judge';

/** A bundle hash: a sha256 in lowercase hex, so a key can never name a path outside the cache. */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

const entrySchema = z.object({ model: z.string().min(1), verdict: z.unknown() });

/** A verdict served from the cache, and the model that gave it. */
export interface CachedVerdict {
  verdict: Verdict;
  model: string;
}

/**
 * The verdict cached under `hash`, or `null` on a miss. An entry that is not valid JSON, or not a verdict
 * Lookover can use, is a miss too (the next write replaces it); any other read failure is thrown.
 */
export async function readCachedVerdict(lookoverDir: string, hash: string): Promise<CachedVerdict | null> {
  const text = await readIfPresent(entryPath(lookoverDir, hash));
  if (text === null) return null;
  const entry = entrySchema.safeParse(parseJson(text));
  if (!entry.success) return null;
  const reading = readVerdict(entry.data.verdict);
  return reading.ok ? { verdict: reading.verdict, model: entry.data.model } : null;
}

/** Caches `verdict` from `model` under `hash`, redacted and written atomically. */
export async function writeCachedVerdict(
  lookoverDir: string,
  hash: string,
  verdict: Verdict,
  model: string,
): Promise<void> {
  const path = entryPath(lookoverDir, hash);
  await mkdir(join(lookoverDir, JUDGE_CACHE_DIR), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(redactDeep({ model, verdict }), null, 2)}\n`);
}

/** Throws a plain `Error`: a key that is not a bundle hash is a bug in the caller. */
function entryPath(lookoverDir: string, hash: string): string {
  if (!HASH_PATTERN.test(hash)) throw new Error('A judge cache key is a sha256 in lowercase hex');
  return join(lookoverDir, JUDGE_CACHE_DIR, `${hash}.json`);
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

/** The parsed JSON, or `undefined` when `text` is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
