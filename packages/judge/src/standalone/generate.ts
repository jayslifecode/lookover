import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Finding, redactDeep } from '@jayslifecode/lookover-core';

/** The most the bundled runner may weigh, which keeps every generated script about this size. */
export const MAX_BUNDLE_BYTES = 1_500_000;

export interface StandaloneScriptOptions {
  /** The base URL the script replays on unless `LOOKOVER_BASE_URL` names another: the config's. */
  baseUrl: string;
}

/** The Playwright the script imports, which the bundle leaves out: the version core pins. */
const PLAYWRIGHT_VERSION = '1.64.1';
/** Built by the package's `build` script; `dist/` sits beside `src/`, so one URL works from either. */
const RUNNER_URL = new URL('../../dist/standalone-runner.js', import.meta.url);
/** What a comment line in the header must not hold, so a value from the page cannot end the comment. */
const LINE_BREAKS = /[\r\n\u2028\u2029]+/g;

/**
 * A standalone ES module that replays `finding` with Playwright alone: a header comment (what it is,
 * how to install what it needs and run it, its environment variables), `const finding = <the finding,
 * redacted, as stored>;`, the bundled runner (`dist/standalone-runner.js`) and the call to its `main`.
 * Throws when the runner has not been built.
 */
export function generateStandaloneScript(finding: Finding, options: StandaloneScriptOptions): string {
  const stored = redactDeep(finding);
  return [
    ...headerLines(stored, options.baseUrl).map((line) => `// ${line}`.trimEnd()),
    `const finding = ${JSON.stringify(stored, null, 2)};`,
    '',
    readRunner(),
    mainCall(options.baseUrl),
    '',
  ].join('\n');
}

function headerLines(finding: Finding, baseUrl: string): string[] {
  const { url, viewport } = placeOf(finding);
  return [
    `Lookover replay of finding ${finding.id}: ${finding.rule.id}, ${finding.title}`,
    `Seen at ${url} (${viewport}).`,
    '',
    'This script measures the finding again in a fresh Chromium, as the Lookover judge does, and needs',
    'nothing of Lookover: only Playwright and its Chromium. In the directory that holds it:',
    '',
    `  npm i playwright@${PLAYWRIGHT_VERSION}`,
    '  npx playwright install chromium',
    '  node <this file>',
    '',
    'Environment variables:',
    `  LOOKOVER_BASE_URL=<url>  replay on this origin instead, the same paths (default ${baseUrl})`,
    '  HEADED=1                 show the browser window',
    '  TIMES=<n>                measure it in <n> fresh browser contexts (default 1)',
    '  STORAGE_STATE=<path>     start from this Playwright storage state, for a page behind a login',
    '',
    'It prints one line per attempt, then "reproduced <n>/<of>", and exits 0 only when every attempt',
    'reproduced the finding.',
  ].map((line) => line.replace(LINE_BREAKS, ' '));
}

function placeOf(finding: Finding): { url: string; viewport: string } {
  const place =
    finding.shape === 'step'
      ? { url: finding.trace.url, viewport: finding.trace.viewport }
      : finding.occurrences[0];
  if (place === undefined) return { url: 'nowhere', viewport: 'no viewport' };
  const { name, width, height } = place.viewport;
  return { url: place.url, viewport: `${name} ${width}×${height}` };
}

function mainCall(baseUrl: string): string {
  return (
    `await main(finding, { baseUrl: process.env.LOOKOVER_BASE_URL ?? ${JSON.stringify(baseUrl)}, ` +
    "headless: process.env.HEADED !== '1', times: Number(process.env.TIMES ?? 1), " +
    'storageState: process.env.STORAGE_STATE });'
  );
}

function readRunner(): string {
  try {
    return readFileSync(RUNNER_URL, 'utf8');
  } catch (error) {
    throw new Error(
      `The standalone runner is not built (${fileURLToPath(RUNNER_URL)}): run pnpm --filter @jayslifecode/lookover-judge build`,
      { cause: error },
    );
  }
}
