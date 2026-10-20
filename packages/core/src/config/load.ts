import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { z } from 'zod';
import { LookoverError } from '../errors.js';
import { configSchema, type LookoverConfig } from './schema.js';

export const CONFIG_FILENAME = 'lookover.config.json';

const INIT_HINT = 'Run `lookover init` in your project root';
const INVALID_HINT = 'Fix the fields above or run `lookover init` again';
const ACK_HINT =
  'Run `lookover init` and confirm the app\'s data is disposable, or set "interaction": "safe"';

function configPath(cwd: string): string {
  return resolve(cwd, CONFIG_FILENAME);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
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
    if (isNotFound(error)) {
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

function assertAcknowledged(config: LookoverConfig): void {
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

export async function writeConfig(cwd: string, config: LookoverConfig): Promise<string> {
  const path = configPath(cwd);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return path;
}
