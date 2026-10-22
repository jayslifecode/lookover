// @vitest-environment node
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

/*
 * The report must not reach out of the machine: it is built here, into a directory of its own, and every
 * URL in the output is checked. Building in the test means it checks the current sources, whatever
 * `dist/` holds.
 */

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const BUILD_TIMEOUT_MS = 120_000;
const TEXT_EXTENSIONS = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.map']);
/** The only absolute URLs allowed: XML namespace names, which identify and never load anything. */
const XML_NAMESPACE = /^http:\/\/www\.w3\.org\//;
const ABSOLUTE_URL = /https?:\/\/[^\s"'`)<>\\]+/g;
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const HTML_REFERENCE = /\s(?:src|href)="([^"]+)"/g;

let outDir: string;

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'lookover-report-build-'));
  // Vitest runs with NODE_ENV=test, which would make this a development build; build as `vite build` does.
  vi.stubEnv('NODE_ENV', 'production');
  try {
    await build({
      root: PACKAGE_DIR,
      configFile: join(PACKAGE_DIR, 'vite.config.ts'),
      mode: 'production',
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    vi.unstubAllEnvs();
  }
}, BUILD_TIMEOUT_MS);

afterAll(async () => {
  if (outDir !== undefined) await rm(outDir, { recursive: true, force: true });
});

test('the built report references no external origin', async () => {
  const files = await filesUnder(outDir);
  const textFiles = files.filter((file) => TEXT_EXTENSIONS.has(extname(file)));
  expect(textFiles.length).toBeGreaterThan(0);

  for (const file of textFiles) {
    const text = await readFile(file, 'utf8');
    const external = [...text.matchAll(ABSOLUTE_URL)]
      .map(([url]) => url)
      .filter((url) => !XML_NAMESPACE.test(url));
    expect(external, relative(outDir, file)).toEqual([]);
  }
});

test('the page loads its scripts and styles from its own files, by relative path', async () => {
  const html = await readFile(join(outDir, 'index.html'), 'utf8');
  const references = [...html.matchAll(HTML_REFERENCE)]
    .map(([, url]) => url ?? '')
    .filter((url) => url !== 'data:,');
  expect(references.length).toBeGreaterThanOrEqual(2);
  for (const url of references) {
    expect(url, url).toMatch(/^\.\//);
    expect(existsSync(resolve(outDir, url)), url).toBe(true);
  }
});

test('the fonts are self-hosted: every url() in the styles is a file of the build', async () => {
  const styles = (await filesUnder(outDir)).filter((file) => extname(file) === '.css');
  const fonts: string[] = [];
  for (const file of styles) {
    const css = await readFile(file, 'utf8');
    for (const [, , url = ''] of css.matchAll(CSS_URL)) {
      if (url.startsWith('data:') || url.startsWith('#')) continue;
      expect(existsSync(resolve(dirname(file), url)), url).toBe(true);
      fonts.push(url);
    }
  }
  expect(fonts.some((url) => /manrope.*\.woff2$/.test(url))).toBe(true);
  expect(fonts.some((url) => /jetbrains-mono.*\.woff2$/.test(url))).toBe(true);
});
