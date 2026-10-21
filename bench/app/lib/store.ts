/*
 * The bench app's whole database: JSON files under `data/`, seeded from `data/seed/`.
 *
 * This module is also run directly by Node (`bench/scripts/reset.ts` under `--experimental-strip-types`),
 * so it imports only `node:` built-ins and uses only erasable TypeScript syntax.
 */
import { randomUUID } from 'node:crypto';
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Organisation {
  id: number;
  name: string;
  /** Eight digits. */
  phone: string;
  email: string;
  /** `YYYY-MM-DD`, the only date format the app uses. */
  registeredAt: string;
  /** Who last edited the organisation. No organisation in the data has one yet. */
  editor?: string;
}

/** An organisation to save: without `id` it is created with the next free id. */
export type OrganisationInput = Omit<Organisation, 'id'> & { id?: number };

export interface Settings {
  workspaceName: string;
  contactEmail: string;
  timeZone: string;
}

const ORGANISATIONS_FILE = 'organisations.json';
const SETTINGS_FILE = 'settings.json';
const STORE_FILES: readonly string[] = [ORGANISATIONS_FILE, SETTINGS_FILE];
const SEED_DIRECTORY = 'seed';

/** `data/` under the working directory: the app's root under `next dev`, `next start` and the package scripts. */
export function defaultDataDir(): string {
  return join(process.cwd(), 'data');
}

/**
 * A path inside the data directory. The directory is only known at run time, so the comment tells
 * Turbopack not to trace it (otherwise `next build` traces the whole project into the server output).
 */
function storePath(dataDir: string, ...segments: string[]): string {
  return join(/* turbopackIgnore: true */ dataDir, ...segments);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOrganisation(value: unknown): value is Organisation {
  return (
    isRecord(value) &&
    Number.isInteger(value.id) &&
    typeof value.name === 'string' &&
    typeof value.phone === 'string' &&
    typeof value.email === 'string' &&
    typeof value.registeredAt === 'string'
  );
}

function isSettings(value: unknown): value is Settings {
  return (
    isRecord(value) &&
    typeof value.workspaceName === 'string' &&
    typeof value.contactEmail === 'string' &&
    typeof value.timeZone === 'string'
  );
}

async function parseJsonFile(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

/** The data file's content; the seed's while the data file has not been written yet. */
async function readStoreFile(dataDir: string, file: string): Promise<{ path: string; value: unknown }> {
  const path = storePath(dataDir, file);
  try {
    return { path, value: await parseJsonFile(path) };
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    const seedPath = storePath(dataDir, SEED_DIRECTORY, file);
    return { path: seedPath, value: await parseJsonFile(seedPath) };
  }
}

/** Write through a unique temp file then rename, so a reader never sees partial bytes. */
async function replaceAtomically(target: string, writeTemp: (temp: string) => Promise<void>): Promise<void> {
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeTemp(temp);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function writeStoreFile(dataDir: string, file: string, value: unknown): Promise<void> {
  return replaceAtomically(storePath(dataDir, file), (temp) =>
    writeFile(temp, `${JSON.stringify(value, null, 2)}\n`),
  );
}

/** Overwrite every data file with its seed. */
export async function resetStore(dataDir = defaultDataDir()): Promise<void> {
  await Promise.all(
    STORE_FILES.map((file) =>
      replaceAtomically(storePath(dataDir, file), (temp) =>
        copyFile(storePath(dataDir, SEED_DIRECTORY, file), temp),
      ),
    ),
  );
}

export async function listOrganisations(dataDir = defaultDataDir()): Promise<Organisation[]> {
  const { path, value } = await readStoreFile(dataDir, ORGANISATIONS_FILE);
  if (!Array.isArray(value) || !value.every(isOrganisation)) {
    throw new Error(`${path} is not a list of organisations`);
  }
  return value;
}

export async function getOrganisation(id: number, dataDir = defaultDataDir()): Promise<Organisation | null> {
  const organisations = await listOrganisations(dataDir);
  return organisations.find((org) => org.id === id) ?? null;
}

/** Replace the organisation with the same id, or append a new one when `id` is absent; returns what was stored. */
export async function saveOrganisation(
  input: OrganisationInput,
  dataDir = defaultDataDir(),
): Promise<Organisation> {
  const organisations = await listOrganisations(dataDir);
  const id = input.id ?? Math.max(0, ...organisations.map((org) => org.id)) + 1;
  const isNew = input.id === undefined;
  if (!isNew && !organisations.some((org) => org.id === id)) {
    throw new Error(`Organisation ${id} does not exist`);
  }
  const saved: Organisation = {
    id,
    name: input.name,
    phone: input.phone,
    email: input.email,
    registeredAt: input.registeredAt,
  };
  const next = isNew ? [...organisations, saved] : organisations.map((org) => (org.id === id ? saved : org));
  await writeStoreFile(dataDir, ORGANISATIONS_FILE, next);
  return saved;
}

export async function getSettings(dataDir = defaultDataDir()): Promise<Settings> {
  const { path, value } = await readStoreFile(dataDir, SETTINGS_FILE);
  if (!isSettings(value)) {
    throw new Error(`${path} does not hold the bench settings`);
  }
  return value;
}

export async function saveSettings(settings: Settings, dataDir = defaultDataDir()): Promise<Settings> {
  const saved: Settings = {
    workspaceName: settings.workspaceName,
    contactEmail: settings.contactEmail,
    timeZone: settings.timeZone,
  };
  await writeStoreFile(dataDir, SETTINGS_FILE, saved);
  return saved;
}
