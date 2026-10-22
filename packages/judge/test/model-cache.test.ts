import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  createFakeJudge,
  JUDGE_CACHE_DIR,
  type JudgeBundle,
  type JudgeModel,
  readCachedVerdict,
  type Verdict,
  writeCachedVerdict,
} from '../src/index.js';

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const MODEL = 'claude-sonnet-5-5';
const EXEMPTION: Verdict = {
  verdict: 'reject',
  attribution: 'exemption',
  oracle: 'WCAG 2.2 2.5.8 Target Size (Minimum), inline exception',
  note: 'The link sits inside a sentence, and the standard exempts links in running text from the size rule.',
};

let lookoverDir: string;

beforeEach(async () => {
  lookoverDir = await mkdtemp(join(tmpdir(), 'lookover-judge-cache-'));
});

afterEach(async () => {
  await rm(lookoverDir, { recursive: true, force: true });
});

/** What the pipeline does with one bundle: the cache first, the model only on a miss. */
async function judgeOnce(
  model: JudgeModel,
  bundle: JudgeBundle,
): Promise<{ verdict: Verdict; cached: boolean }> {
  const hit = await readCachedVerdict(lookoverDir, bundle.hash);
  if (hit !== null) return { verdict: hit.verdict, cached: true };
  const { verdict } = await model.judge(bundle);
  await writeCachedVerdict(lookoverDir, bundle.hash, verdict, model.model);
  return { verdict, cached: false };
}

async function writeEntry(hash: string, content: string): Promise<void> {
  await mkdir(join(lookoverDir, JUDGE_CACHE_DIR), { recursive: true });
  await writeFile(join(lookoverDir, JUDGE_CACHE_DIR, `${hash}.json`), content);
}

describe('the verdict cache', () => {
  test('a second call with the same hash is served from the cache', async () => {
    const model = createFakeJudge(() => EXEMPTION, MODEL);
    const bundle: JudgeBundle = { text: 'one finding', images: [], hash: HASH };

    const first = await judgeOnce(model, bundle);
    const second = await judgeOnce(model, bundle);

    expect(first).toEqual({ verdict: EXEMPTION, cached: false });
    expect(second).toEqual({ verdict: EXEMPTION, cached: true });
    expect(model.calls).toHaveLength(1);
    expect(await readCachedVerdict(lookoverDir, HASH)).toEqual({ verdict: EXEMPTION, model: MODEL });
    expect(await readCachedVerdict(lookoverDir, OTHER_HASH)).toBeNull();
  });

  test('stores one JSON file per hash under .lookover/cache/judge', async () => {
    await writeCachedVerdict(lookoverDir, HASH, EXEMPTION, MODEL);

    const stored: unknown = JSON.parse(
      await readFile(join(lookoverDir, 'cache', 'judge', `${HASH}.json`), 'utf8'),
    );

    expect(JUDGE_CACHE_DIR).toBe('cache/judge');
    expect(stored).toEqual({ model: MODEL, verdict: EXEMPTION });
  });

  test('redacts the verdict before it is stored', async () => {
    const leaky = { ...EXEMPTION, note: 'The page shows token=abc123def456 next to the button.' };

    await writeCachedVerdict(lookoverDir, HASH, leaky, MODEL);

    const stored = await readFile(join(lookoverDir, JUDGE_CACHE_DIR, `${HASH}.json`), 'utf8');
    expect(stored).not.toContain('abc123def456');
    expect(stored).toContain('[redacted]');
  });

  test('a damaged or unusable entry is a miss', async () => {
    await writeEntry(HASH, '{ not json');
    await writeEntry(
      OTHER_HASH,
      JSON.stringify({ model: MODEL, verdict: { ...EXEMPTION, verdict: 'maybe' } }),
    );
    const confirmedExemption = { ...EXEMPTION, verdict: 'confirm' };
    await writeEntry('c'.repeat(64), JSON.stringify({ model: MODEL, verdict: confirmedExemption }));

    expect(await readCachedVerdict(lookoverDir, HASH)).toBeNull();
    expect(await readCachedVerdict(lookoverDir, OTHER_HASH)).toBeNull();
    expect(await readCachedVerdict(lookoverDir, 'c'.repeat(64))).toBeNull();
  });

  test('refuses a key that is not a sha256 in hex', async () => {
    await expect(readCachedVerdict(lookoverDir, '../../decisions')).rejects.toThrow(/sha256/);
    await expect(writeCachedVerdict(lookoverDir, 'ABC', EXEMPTION, MODEL)).rejects.toThrow(/sha256/);
  });
});
