import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { RULES, SEVERITIES, type Severity } from '../src/index.ts';

const SCRIPT = fileURLToPath(new URL('../scripts/generate-docs.ts', import.meta.url));
const COMMITTED_DOC = fileURLToPath(new URL('../../../docs/rules.md', import.meta.url));
const TABLE_HEADER = '| id | severity | title | expected | reference |';

interface GeneratorResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the generator the way `pnpm docs` does, as a real subprocess. */
function runGenerator(args: readonly string[]): Promise<GeneratorResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--experimental-strip-types', SCRIPT, ...args],
      { encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** The rule ids of one table, in the order the document lists them. */
function idsIn(section: string): string[] {
  return section
    .split('\n')
    .map((line) => /^\| `([^`]+)` \|/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
}

let workDir: string;
let outPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'lookover-rules-docs-'));
  outPath = join(workDir, 'rules.md');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('generating docs/rules.md', () => {
  test('renders one table per source with every rule, sorted by severity then id', async () => {
    const result = await runGenerator(['--out', outPath]);
    expect(result.code).toBe(0);

    const text = await readFile(outPath, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const [opening, ...sections] = text.split('\n## ');
    expect(opening).toContain('packages/rules/catalogue');
    expect(opening).toContain('pnpm docs:rules');
    expect(opening).toContain('by hand');

    expect(sections.map((section) => section.split('\n')[0])).toEqual(['Interaction', 'Observers']);
    expect(text.split(TABLE_HEADER)).toHaveLength(3);

    const severityRank = (severity: Severity) => SEVERITIES.indexOf(severity);
    for (const [index, source] of (['interaction', 'observers'] as const).entries()) {
      const expectedIds = RULES.filter((rule) => rule.source === source)
        .toSorted(
          (a, b) =>
            severityRank(a.severity) - severityRank(b.severity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .map((rule) => rule.id);
      expect(idsIn(sections[index] ?? '')).toEqual(expectedIds);
    }
    expect(idsIn(text)).toHaveLength(RULES.length);
  });

  test('a row shows the severity, the title, what is expected and a linked reference', async () => {
    await runGenerator(['--out', outPath]);
    const rows = (await readFile(outPath, 'utf8')).split('\n');

    const focusRow = rows.find((row) => row.startsWith('| `interaction.focus-visible-missing`'));
    expect(focusRow).toContain('| high | Keyboard focus is not visible |');
    expect(focusRow).toContain(
      '[WCAG 2.2 · 2.4.7 Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)',
    );

    const pageErrorRow = rows.find((row) => row.startsWith('| `observers.page-error`'));
    expect(pageErrorRow).toMatch(/\| — \|$/);
  });

  test('the committed docs/rules.md is what the catalogue generates', async () => {
    const result = await runGenerator(['--check']);
    expect(result.code, result.stderr).toBe(0);
    expect(await readFile(COMMITTED_DOC, 'utf8')).toContain(TABLE_HEADER);
  });
});

describe('--check', () => {
  test('passes on a freshly generated file', async () => {
    await runGenerator(['--out', outPath]);
    const result = await runGenerator(['--check', '--out', outPath]);
    expect(result.code).toBe(0);
  });

  test('exits 1 and names the file when docs/rules.md is stale', async () => {
    await runGenerator(['--out', outPath]);
    const fresh = await readFile(outPath, 'utf8');
    await writeFile(outPath, fresh.replace('Keyboard focus is not visible', 'Keyboard focus is invisible'));

    const result = await runGenerator(['--check', '--out', outPath]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(outPath);
    expect(await readFile(outPath, 'utf8')).toContain('Keyboard focus is invisible');
  });

  test('exits 1 and names the file when it does not exist', async () => {
    const result = await runGenerator(['--check', '--out', outPath]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(outPath);
  });
});

describe('usage', () => {
  test('an unknown flag exits 2 and says how to use the script', async () => {
    const result = await runGenerator(['--nope']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--nope');
    expect(result.stderr).toContain('Usage');
  });

  test('--out without a path exits 2', async () => {
    const result = await runGenerator(['--out']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--out');
  });
});
