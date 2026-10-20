import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LookoverError } from '../errors.js';
import type { RunContext } from '../run/run-context.js';
import { isMissingFile, writeFileAtomic } from '../util/fs.js';
import { redact, redactDeep } from '../util/redact.js';
import type { AppMap, Screen } from './types.js';

/** The map's file name, in the run directory and in the lookover directory (the project's latest). */
export const APP_MAP_FILE = 'app-map.json';
const SUPPORTED_VERSION = 1;
const REBUILD_HINT = 'Delete the file and run again to rebuild the map';

export interface AppMapDiff {
  /** Screen keys (`route|viewport name`) present only in the newer map. */
  addedScreens: string[];
  /** Screen keys present only in the older map. */
  removedScreens: string[];
  /**
   * Screens in both maps whose element selectors differ; `screenId` is the newer map's. Selectors are
   * reported in their redacted form.
   */
  changedScreens: { screenId: string; addedElements: string[]; removedElements: string[] }[];
}

/**
 * Writes the map, redacted, to `<run dir>/app-map.json` and to `<lookover dir>/app-map.json`
 * (the project's latest), each atomically, so a reader never sees a partial map. Both files hold the
 * same bytes. `map` itself is not modified.
 */
export async function writeAppMap(
  ctx: RunContext,
  map: AppMap,
): Promise<{ runPath: string; latestPath: string }> {
  const runPath = resolve(ctx.dir, APP_MAP_FILE);
  const latestPath = resolve(ctx.lookoverDir, APP_MAP_FILE);
  const content = `${JSON.stringify(redactDeep(map), null, 2)}\n`;
  await writeFileAtomic(runPath, content);
  await writeFileAtomic(latestPath, content);
  return { runPath, latestPath };
}

/** Returns the project's latest map, or `null` when no run has written one yet. */
export async function readLatestAppMap(lookoverDir: string): Promise<AppMap | null> {
  const path = resolve(lookoverDir, APP_MAP_FILE);
  const raw = await readIfPresent(path);
  if (raw === null) return null;
  return parseAppMap(raw, path);
}

/** Compares two maps screen by screen, on redacted selectors. Neither input is modified. */
export function diffAppMaps(prev: AppMap, next: AppMap): AppMapDiff {
  const before = indexScreens(prev);
  const after = indexScreens(next);
  const beforeKeys = [...before.keys()].toSorted();
  const afterKeys = [...after.keys()].toSorted();
  return {
    addedScreens: afterKeys.filter((key) => !before.has(key)),
    removedScreens: beforeKeys.filter((key) => !after.has(key)),
    changedScreens: afterKeys.flatMap((key) => {
      const current = after.get(key);
      const earlier = before.get(key);
      if (current === undefined || earlier === undefined) return [];
      const addedElements = difference(current.selectors, earlier.selectors);
      const removedElements = difference(earlier.selectors, current.selectors);
      if (addedElements.length === 0 && removedElements.length === 0) return [];
      return [{ screenId: current.screenId, addedElements, removedElements }];
    }),
  };
}

interface ScreenSummary {
  screenId: string;
  selectors: ReadonlySet<string>;
}

/**
 * One entry per `route|viewport name`. Several instances of a dynamic route (`/orgs/1`, `/orgs/2`)
 * share a key: their selectors are merged and the smallest id (string order) is kept, so the result
 * does not depend on capture order. The union masks a removal on one instance while another instance
 * still has the selector. Selectors are redacted, as `writeAppMap` stores them, so a persisted map
 * and a raw in-memory one compare equal (redaction is idempotent).
 */
function indexScreens(map: AppMap): ReadonlyMap<string, ScreenSummary> {
  const index = new Map<string, ScreenSummary>();
  for (const screen of map.screens) {
    const key = screenKey(screen);
    const known = index.get(key);
    index.set(key, {
      screenId: known === undefined || screen.id < known.screenId ? screen.id : known.screenId,
      selectors: new Set([
        ...(known?.selectors ?? []),
        ...screen.elements.map((element) => redact(element.selector)),
      ]),
    });
  }
  return index;
}

function screenKey(screen: Screen): string {
  return `${screen.route}|${screen.viewport.name}`;
}

function difference(source: ReadonlySet<string>, other: ReadonlySet<string>): string[] {
  return [...source].filter((value) => !other.has(value)).toSorted();
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function parseAppMap(raw: string, path: string): AppMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new LookoverError(
      'E_RUN_FAILED',
      `Could not read the app map at ${path}: not valid JSON (${reason})`,
      REBUILD_HINT,
    );
  }
  if (!hasSupportedVersion(parsed)) {
    throw new LookoverError(
      'E_RUN_FAILED',
      `Could not read the app map at ${path}: expected "version": ${SUPPORTED_VERSION}`,
      REBUILD_HINT,
    );
  }
  // Only the version is checked: this file is written by `writeAppMap`, not by users.
  return parsed as AppMap;
}

function hasSupportedVersion(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && 'version' in value && value.version === SUPPORTED_VERSION
  );
}
