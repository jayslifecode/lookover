import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { z } from 'zod';
import { LookoverError } from '../errors.js';
import { isMissingFile, writeFileAtomic } from '../util/fs.js';
import { configSchema, type LookoverConfig } from './schema.js';

export const CONFIG_FILENAME = 'lookover.config.json';

const DEFAULT_INDENT = '  ';
/** The start of the first line that has content after leading whitespace. */
const INDENTED_LINE = /^[ \t]+(?=\S)/m;

const INIT_HINT = 'Run `lookover init` in your project root';
const INVALID_HINT = 'Fix the fields above or run `lookover init` again';
const ACK_HINT =
  'Run `lookover init` and confirm the app\'s data is disposable, or set "interaction": "safe"';

function configPath(cwd: string): string {
  return resolve(cwd, CONFIG_FILENAME);
}

function invalidConfig(lines: readonly string[]): LookoverError {
  return new LookoverError(
    'E_CONFIG_INVALID',
    [`Invalid ${CONFIG_FILENAME}`, ...lines].join('\n'),
    INVALID_HINT,
  );
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
  return `  ${path}: ${issue.message}`;
}

async function readRaw(path: string, cwd: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      throw new LookoverError('E_CONFIG_NOT_FOUND', `Could not find ${CONFIG_FILENAME} in ${cwd}`, INIT_HINT);
    }
    throw error;
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw invalidConfig([`  (file): not valid JSON (${reason})`]);
  }
}

/**
 * The gate on full interaction: throws `E_ACK_REQUIRED` for an `interaction: "full"` config without
 * the disposable-data acknowledgement. `loadConfig` and `runReview` both apply it, so a config
 * built in code cannot skip it.
 */
export function assertAcknowledged(config: Pick<LookoverConfig, 'interaction' | 'acknowledgement'>): void {
  if (config.interaction === 'full' && config.acknowledgement?.disposableData !== true) {
    throw new LookoverError(
      'E_ACK_REQUIRED',
      'interaction is "full" but the disposable-data acknowledgement is missing',
      ACK_HINT,
    );
  }
}

export async function loadConfig(cwd: string): Promise<{ config: LookoverConfig; path: string }> {
  const path = configPath(cwd);
  const json = parseJson(await readRaw(path, cwd));
  const result = configSchema.safeParse(json);
  if (!result.success) {
    throw invalidConfig(result.error.issues.map(describeIssue));
  }
  assertAcknowledged(result.data);
  return { config: result.data, path };
}

/**
 * The indentation a JSON file is written with, for `JSON.stringify(value, null, indent)`: the first
 * line that starts with whitespace decides (a tab, or that many spaces). A file with no indented line,
 * such as `{}` or minified JSON, gets two spaces.
 */
export function detectIndent(raw: string): string {
  const leading = INDENTED_LINE.exec(raw)?.[0];
  if (leading === undefined) {
    return DEFAULT_INDENT;
  }
  return leading.includes('\t') ? '\t' : leading;
}

/** The indentation of the config file at `path`; two spaces when there is no file yet. */
async function existingIndent(path: string): Promise<string> {
  try {
    return detectIndent(await readFile(path, 'utf8'));
  } catch (error) {
    if (isMissingFile(error)) {
      return DEFAULT_INDENT;
    }
    throw error;
  }
}

/**
 * Writes `config` to `<cwd>/lookover.config.json`, atomically, and returns the file's path. A file
 * that is already there keeps its indentation and its permission bits.
 */
export async function writeConfig(cwd: string, config: LookoverConfig): Promise<string> {
  const path = configPath(cwd);
  const indent = await existingIndent(path);
  await writeFileAtomic(path, `${JSON.stringify(config, null, indent)}\n`);
  return path;
}
