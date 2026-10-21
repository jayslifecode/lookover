import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  CONFIG_FILENAME,
  detectIndent,
  type LookoverConfig,
  LookoverError,
  normaliseHost,
  writeFileAtomic,
} from '@jayslifecode/lookover-core';

/** What commander hands the `run` action. */
export interface RunFlags {
  readonly headed?: boolean;
  readonly maxScreens?: string;
  readonly allowHost?: readonly string[];
  readonly confirmHost?: readonly string[];
  readonly yes?: boolean;
}

/** The flags, validated: hosts normalised and deduplicated, the screen budget a number. */
export interface RunOptions {
  readonly isHeaded: boolean;
  /** Overrides `config.maxScreens` for this run; `undefined` keeps the config's. */
  readonly maxScreens: number | undefined;
  readonly allowHosts: readonly string[];
  readonly confirmHosts: readonly string[];
  readonly isYes: boolean;
}

/** A repeatable host flag and what its values may look like. */
interface HostFlag {
  readonly name: string;
  /** Only `allowHosts` takes a pattern (a leading `*.`); a confirmed backend is one exact host. */
  readonly allowsWildcard: boolean;
  readonly hint: string;
}

const ALLOW_HOST: HostFlag = {
  name: '--allow-host',
  allowsWildcard: true,
  hint: 'Pass the host alone, without a scheme, port or path, e.g. --allow-host fonts.gstatic.com (a leading "*." matches every subdomain)',
};
const CONFIRM_HOST: HostFlag = {
  name: '--confirm-host',
  allowsWildcard: false,
  hint: 'Pass one backend host alone, without a scheme, port, path or "*", e.g. --confirm-host api.dev.example.com',
};

const POSITIVE_INTEGER = /^[1-9]\d*$/;
/** A scheme, path, query, fragment, credentials or whitespace: what a URL has and a host name does not. */
const NOT_IN_A_HOST = /[\s/?#@]/;
/** Several hosts in one value: each flag takes one host, repeated for more. */
const HOST_LIST_SEPARATOR = ',';
const WILDCARD = '*';
const WILDCARD_PREFIX = '*.';
const CONFIRMED_HOSTS_KEY = 'confirmedBackendHosts';
const CONFIG_CHANGED_HINT = `Fix ${CONFIG_FILENAME} or run \`lookover init\` again, then re-run`;

/** Commander's collector for a repeatable flag such as `--confirm-host a --confirm-host b`. */
export function collectRepeated(value: string, previous: readonly string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

export function parseRunFlags(flags: RunFlags): RunOptions {
  return {
    isHeaded: flags.headed === true,
    maxScreens: parseMaxScreens(flags.maxScreens),
    allowHosts: parseHosts(ALLOW_HOST, flags.allowHost ?? []),
    confirmHosts: parseHosts(CONFIRM_HOST, flags.confirmHost ?? []),
    isYes: flags.yes === true,
  };
}

/**
 * The config this run uses: `--allow-host` added to `allowHosts` and `--confirm-host` to
 * `confirmedBackendHosts` (so those backends count as confirmed from the start), and `--max-screens`
 * in place of `maxScreens`. A new object; `config` is not changed, and only the confirmed hosts are
 * ever written back (see `saveConfirmedHosts`).
 */
export function configForRun(config: LookoverConfig, options: RunOptions): LookoverConfig {
  return {
    ...config,
    allowHosts: mergeHosts(config.allowHosts, options.allowHosts),
    confirmedBackendHosts: mergeHosts(config.confirmedBackendHosts, options.confirmHosts),
    maxScreens: options.maxScreens ?? config.maxScreens,
  };
}

/** Every host of every list, once, compared as the network policy compares them; the first spelling is kept. */
export function mergeHosts(...lists: readonly (readonly string[])[]): string[] {
  const merged = new Map<string, string>();
  for (const host of lists.flat()) {
    const key = normaliseHost(host);
    if (!merged.has(key)) {
      merged.set(key, host);
    }
  }
  return [...merged.values()];
}

/**
 * Adds the `hosts` that `config` (as loaded, without this run's overrides) does not list yet to
 * `confirmedBackendHosts` in lookover.config.json, and resolves with those. Only that key of the file
 * changes: the file is read again as JSON and every other key is kept as written (defaults are not
 * filled in, unknown keys such as `$schema` stay), then written back atomically with the file's own
 * indentation and permission bits. When `config` already lists every host, the file is not touched
 * and the result is empty.
 */
export async function saveConfirmedHosts(
  cwd: string,
  config: LookoverConfig,
  hosts: readonly string[],
): Promise<string[]> {
  const known = new Set(config.confirmedBackendHosts.map(normaliseHost));
  const added = mergeHosts(hosts).filter((host) => !known.has(normaliseHost(host)));
  if (added.length === 0) {
    return [];
  }
  const path = resolve(cwd, CONFIG_FILENAME);
  const raw = await readFile(path, 'utf8');
  const fields = parseConfigFields(raw);
  const confirmed = mergeHosts(listedHosts(fields), added);
  const updated = { ...fields, [CONFIRMED_HOSTS_KEY]: confirmed };
  await writeFileAtomic(path, `${JSON.stringify(updated, null, detectIndent(raw))}\n`);
  return added;
}

/** The config file's top-level object, as written. */
function parseConfigFields(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configChanged('is no longer valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw configChanged('no longer holds a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** `confirmedBackendHosts` as the file lists it; none when the key is absent. */
function listedHosts(fields: Record<string, unknown>): string[] {
  const listed = fields[CONFIRMED_HOSTS_KEY];
  if (listed === undefined) {
    return [];
  }
  if (!Array.isArray(listed) || !listed.every((host) => typeof host === 'string')) {
    throw configChanged(`has a ${CONFIRMED_HOSTS_KEY} that is not a list of host names`);
  }
  return listed;
}

/** The file was valid when the run loaded it, so it was changed during the run. */
function configChanged(problem: string): LookoverError {
  return new LookoverError(
    'E_CONFIG_INVALID',
    `Could not save the confirmed backend hosts: ${CONFIG_FILENAME} ${problem}`,
    CONFIG_CHANGED_HINT,
  );
}

function parseMaxScreens(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!POSITIVE_INTEGER.test(value.trim())) {
    throw new LookoverError(
      'E_USAGE',
      `--max-screens "${value}" is not a positive whole number`,
      'For example: --max-screens 20',
    );
  }
  return Number(value.trim());
}

function parseHosts(flag: HostFlag, values: readonly string[]): string[] {
  return mergeHosts(values.map((value) => parseHost(flag, value)));
}

function parseHost(flag: HostFlag, value: string): string {
  if (value.includes(HOST_LIST_SEPARATOR)) {
    throw new LookoverError(
      'E_USAGE',
      `${flag.name} "${value}" is not a host name: the flag takes one host`,
      repeatedFlagHint(flag, value),
    );
  }
  const host = normaliseHost(value);
  if (host === '' || NOT_IN_A_HOST.test(host) || hasPort(host) || !hasValidWildcard(host, flag)) {
    throw new LookoverError('E_USAGE', `${flag.name} "${value}" is not a host name`, flag.hint);
  }
  return host;
}

/** For `a.test,b.test`: the same hosts as one flag each. */
function repeatedFlagHint(flag: HostFlag, value: string): string {
  const hosts = value
    .split(HOST_LIST_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (hosts.length < 2) {
    return flag.hint;
  }
  return `Repeat the flag once per host: ${hosts.map((host) => `${flag.name} ${host}`).join(' ')}`;
}

/** `host:port` has exactly one colon; an IPv6 address has several. */
function hasPort(host: string): boolean {
  return host.split(':').length === 2;
}

function hasValidWildcard(host: string, flag: HostFlag): boolean {
  if (!host.includes(WILDCARD)) {
    return true;
  }
  return flag.allowsWildcard && host.startsWith(WILDCARD_PREFIX) && !host.slice(1).includes(WILDCARD);
}
