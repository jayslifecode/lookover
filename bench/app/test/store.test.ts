import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  getOrganisation,
  getSettings,
  listOrganisations,
  resetStore,
  saveOrganisation,
  saveSettings,
} from '../lib/store.ts';

const SEED_DIR = join(import.meta.dirname, '..', 'data', 'seed');
const SEEDED_COUNT = 12;

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'lookover-bench-store-'));
  await cp(SEED_DIR, join(dataDir, 'seed'), { recursive: true });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('organisations', () => {
  test('resetStore then listOrganisations returns the 12 seeded organisations', async () => {
    await resetStore(dataDir);

    const organisations = await listOrganisations(dataDir);

    expect(organisations).toHaveLength(SEEDED_COUNT);
    expect(organisations.map((org) => org.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const org of organisations) {
      expect(org.phone).toMatch(/^\d{8}$/);
      expect(org.registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('saveOrganisation persists and resetStore restores the seed', async () => {
    await resetStore(dataDir);
    const [first] = await listOrganisations(dataDir);
    if (first === undefined) throw new Error('seed is empty');

    await saveOrganisation({ ...first, name: 'X' }, dataDir);
    expect((await getOrganisation(first.id, dataDir))?.name).toBe('X');

    await resetStore(dataDir);
    expect(await getOrganisation(first.id, dataDir)).toEqual(first);
  });

  test('saveOrganisation without an id appends one with the next id', async () => {
    await resetStore(dataDir);

    const created = await saveOrganisation(
      { name: 'New Org', phone: '12345678', email: 'new@org.example', registeredAt: '2026-10-21' },
      dataDir,
    );

    expect(created.id).toBe(SEEDED_COUNT + 1);
    expect(await listOrganisations(dataDir)).toHaveLength(SEEDED_COUNT + 1);
  });

  test('saveOrganisation with an unknown id is rejected', async () => {
    await resetStore(dataDir);

    await expect(
      saveOrganisation(
        { id: 999, name: 'Ghost', phone: '12345678', email: 'g@org.example', registeredAt: '2026-10-21' },
        dataDir,
      ),
    ).rejects.toThrow(/999/);
  });

  test('getOrganisation returns null for an unknown id', async () => {
    await resetStore(dataDir);

    expect(await getOrganisation(999, dataDir)).toBeNull();
  });

  test('reads fall back to the seed when the data file does not exist yet', async () => {
    expect(await listOrganisations(dataDir)).toHaveLength(SEEDED_COUNT);
  });

  test('a malformed data file fails with a message naming the file', async () => {
    await writeFile(join(dataDir, 'organisations.json'), '[{"id":"one"}]');

    await expect(listOrganisations(dataDir)).rejects.toThrow(/organisations\.json/);
  });

  test('writes leave no temp files behind and do not touch the seed', async () => {
    const seedBefore = await readFile(join(dataDir, 'seed', 'organisations.json'), 'utf8');
    await resetStore(dataDir);
    const [first] = await listOrganisations(dataDir);
    if (first === undefined) throw new Error('seed is empty');

    await saveOrganisation({ ...first, name: 'Renamed' }, dataDir);

    expect((await readdir(dataDir)).sort()).toEqual(['organisations.json', 'seed', 'settings.json']);
    expect(await readFile(join(dataDir, 'seed', 'organisations.json'), 'utf8')).toBe(seedBefore);
  });
});

describe('settings', () => {
  test('saveSettings persists and resetStore restores the seed', async () => {
    await resetStore(dataDir);
    const seeded = await getSettings(dataDir);

    await saveSettings({ ...seeded, workspaceName: 'Changed' }, dataDir);
    expect((await getSettings(dataDir)).workspaceName).toBe('Changed');

    await resetStore(dataDir);
    expect(await getSettings(dataDir)).toEqual(seeded);
  });
});
