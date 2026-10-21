/*
 * Writes docs/rules.md from the catalogues in packages/rules/catalogue.
 *
 *   pnpm docs:rules                writes docs/rules.md
 *   pnpm docs:rules --check        exits 1, naming the file, when docs/rules.md differs from what would be written
 *   pnpm docs:rules --out <path>   writes (or, with --check, compares) <path> instead
 *
 * Or `node --experimental-strip-types <path>/packages/rules/scripts/generate-docs.ts` from any directory:
 * the default file is found from this file's location, not the cwd.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RULE_SOURCES, RULES, type Rule, SEVERITIES } from '../src/index.ts';

const DEFAULT_OUT = join(import.meta.dirname, '..', '..', '..', 'docs', 'rules.md');
const USAGE = 'Usage: generate-docs.ts [--check] [--out <path>]';
const EXIT_STALE = 1;
const EXIT_USAGE = 2;

const OPENING =
  'This file is generated from the catalogues in `packages/rules/catalogue` by `pnpm docs:rules`. ' +
  'Do not edit it by hand: change the catalogue and run the command again, and `pnpm check` fails ' +
  'while the two disagree. Every finding Lookover reports names one of these rules.';

const COLUMNS = ['id', 'severity', 'title', 'expected', 'reference'];
const NO_REFERENCE = '—';

interface Options {
  readonly check: boolean;
  readonly outPath: string;
}

class UsageError extends Error {}

function parseArgs(
  args: readonly string[],
  options: Options = { check: false, outPath: DEFAULT_OUT },
): Options {
  const [flag, ...rest] = args;
  if (flag === undefined) return options;
  // pnpm hands a bare `--` on to the script when `docs:rules` forwards its own arguments.
  if (flag === '--') return parseArgs(rest, options);
  if (flag === '--check') return parseArgs(rest, { ...options, check: true });
  if (flag === '--out') {
    const [path, ...afterPath] = rest;
    if (path === undefined || path.startsWith('--')) throw new UsageError('--out needs a path');
    return parseArgs(afterPath, { ...options, outPath: resolve(path) });
  }
  throw new UsageError(`Unknown argument ${flag}`);
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function bySeverityThenId(a: Rule, b: Rule): number {
  return SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || compareText(a.id, b.id);
}

function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function referenceCell(rule: Rule): string {
  if (rule.reference === null) return NO_REFERENCE;
  const { standard, criterion, url } = rule.reference;
  return `[${escapeCell(`${standard} · ${criterion}`)}](${url})`;
}

function renderRow(rule: Rule): string {
  const cells = [
    `\`${rule.id}\``,
    rule.severity,
    escapeCell(rule.title),
    escapeCell(rule.expected),
    referenceCell(rule),
  ];
  return `| ${cells.join(' | ')} |`;
}

function renderTable(rules: readonly Rule[]): string {
  const header = `| ${COLUMNS.join(' | ')} |`;
  const divider = `| ${COLUMNS.map(() => '---').join(' | ')} |`;
  return [header, divider, ...rules.map(renderRow)].join('\n');
}

function renderDocument(rules: readonly Rule[]): string {
  const sections = RULE_SOURCES.map((source) => ({
    heading: `${source.charAt(0).toUpperCase()}${source.slice(1)}`,
    rules: rules.filter((rule) => rule.source === source).toSorted(bySeverityThenId),
  }))
    .filter((section) => section.rules.length > 0)
    .map((section) => `## ${section.heading}\n\n${renderTable(section.rules)}`);
  return `${['# Rules', OPENING, ...sections].join('\n\n')}\n`;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function checkFile(path: string, generated: string): Promise<number> {
  const current = await readIfPresent(path);
  if (current === generated) {
    console.log(`${path} is up to date.`);
    return 0;
  }
  const problem = current === null ? 'does not exist' : 'is out of date with packages/rules/catalogue';
  console.error(`${path} ${problem}. Run \`pnpm docs:rules\` and commit the result.`);
  return EXIT_STALE;
}

async function main(args: readonly string[]): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(args);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n${USAGE}`);
    return EXIT_USAGE;
  }

  const generated = renderDocument(RULES);
  if (options.check) return checkFile(options.outPath, generated);

  await writeFile(options.outPath, generated);
  console.log(`Wrote ${options.outPath}`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
