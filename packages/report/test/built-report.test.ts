// @vitest-environment node
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES } from '@jayslifecode/lookover-rules';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

/*
 * The report must not reach out of the machine. It is built here, into a directory of its own (so the
 * test checks the current sources, whatever `dist/` holds), and the output is read statically: no place
 * that loads something names another origin, and the only absolute URLs at all are XML namespace names,
 * the documentation links in React's and Base UI's error messages, and the standards the rules catalogue
 * cites, which are text or links the reader may follow, and never fetched. A real browser counting
 * requests is the end-to-end suite's job.
 */

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const BUILD_TIMEOUT_MS = 120_000;
const TEXT_EXTENSIONS = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.map']);

/**
 * The absolute URLs the built report may contain: XML namespace names, which identify and never load
 * anything, and the error-page links React (`https://react.dev/errors/<code>`) and Base UI
 * (`https://base-ui.com/production-error?code=…`) put in their production error messages.
 */
const ALLOWED_URL_PREFIXES = ['http://www.w3.org/', 'https://react.dev/', 'https://base-ui.com/'];
/**
 * The standards the rules catalogue cites (`reference.url`), exactly: the finding panel shows each as a
 * link that opens in a new tab without a referrer.
 */
const REFERENCE_URLS: ReadonlySet<string> = new Set(
  RULES.flatMap((rule) => (rule.reference === null ? [] : [rule.reference.url])),
);
const ABSOLUTE_URL = /https?:\/\/[^\s"'`)<>\\]+/g;
/** A reference that leaves the page's own origin: a scheme with a host, or protocol-relative. */
const EXTERNAL_REFERENCE = /^\s*(?:(?:https?|wss?):)?\/\//i;

/** Every place in HTML, CSS or script text where a URL is loaded, with the URL it names. */
const LOADING_POSITIONS: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
  { kind: 'html src/href', pattern: /<[a-z][^>]*?\s(?:src|href)\s*=\s*(["']?)([^"'\s>]+)\1/gi },
  { kind: 'css url()', pattern: /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi },
  { kind: 'css @import', pattern: /@import\s+(?:url\(\s*)?(['"])([^'"]+)\1/gi },
  { kind: 'fetch()', pattern: /\bfetch\(\s*(["'`])([^"'`]*)\1/g },
  { kind: 'new EventSource()', pattern: /\bnew\s+EventSource\(\s*(["'`])([^"'`]*)\1/g },
  { kind: 'new WebSocket()', pattern: /\bnew\s+WebSocket\(\s*(["'`])([^"'`]*)\1/g },
];

/** The absolute URLs in `text` that are not on the allowed list. */
function unexpectedAbsoluteUrls(text: string): string[] {
  return [...text.matchAll(ABSOLUTE_URL)]
    .map(([url]) => url)
    .filter((url) => !REFERENCE_URLS.has(url))
    .filter((url) => !ALLOWED_URL_PREFIXES.some((prefix) => url.startsWith(prefix)));
}

/** Each loading position in `text` whose URL leaves the page's own origin, as `<kind>: <url>`. */
function externalLoads(text: string): string[] {
  return LOADING_POSITIONS.flatMap(({ kind, pattern }) =>
    [...text.matchAll(pattern)]
      .map(([, , url = '']) => url)
      .filter((url) => EXTERNAL_REFERENCE.test(url))
      .map((url) => `${kind}: ${url}`),
  );
}

let outDir: string;

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

async function builtTextFiles(): Promise<{ name: string; text: string }[]> {
  const files = (await filesUnder(outDir)).filter((file) => TEXT_EXTENSIONS.has(extname(file)));
  return Promise.all(
    files.map(async (file) => ({ name: relative(outDir, file), text: await readFile(file, 'utf8') })),
  );
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
  const files = await builtTextFiles();
  expect(files.map(({ name }) => name)).toContain('index.html');

  for (const { name, text } of files) {
    expect(unexpectedAbsoluteUrls(text), `absolute URLs in ${name}`).toEqual([]);
    expect(externalLoads(text), `external loads in ${name}`).toEqual([]);
  }
});

test('the origin check catches every way of loading from elsewhere, and lets error-message links be', () => {
  const loads = [
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope">',
    '<script type="module" src="//cdn.example.com/app.js"></script>',
    '<img src=https://images.example.com/a.png>',
    '@font-face{src:url(https://fonts.gstatic.com/a.woff2)}',
    '@import "https://cdn.example.com/a.css";',
    'fetch("https://api.example.com/x")',
    "new EventSource('http://localhost:9999/events')",
    'new WebSocket(`wss://socket.example.com`)',
  ];
  expect(loads.map((text) => externalLoads(text).length)).toEqual(loads.map(() => 1));
  // Six of them are http(s) URLs; the protocol-relative and the wss:// ones are caught as loads only.
  expect(unexpectedAbsoluteUrls(loads.join('\n'))).toHaveLength(6);
  // Only the catalogue's own references are let be, not the rest of their site.
  expect(unexpectedAbsoluteUrls('"https://www.w3.org/WAI/WCAG22/Understanding/other.html"')).toHaveLength(1);

  const harmless = [
    'var t=`https://react.dev/errors/`+e;',
    'var Ut=Ht(`https://base-ui.com/production-error`,`Base UI`)',
    'createElementNS("http://www.w3.org/2000/svg","svg")',
    '<script type="module" crossorigin src="./assets/index.js"></script>',
    'src:url(./manrope-latin-wght-normal.woff2) format("woff2-variations")',
    'fetch("/api/run",{signal:t})',
    'new EventSource("/api/events")',
    '{url:"https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html"}',
  ];
  for (const text of harmless) {
    expect(externalLoads(text), text).toEqual([]);
    expect(unexpectedAbsoluteUrls(text), text).toEqual([]);
  }
});

test('the page loads its scripts and styles from its own files, by relative path', async () => {
  const html = await readFile(join(outDir, 'index.html'), 'utf8');
  const references = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)]
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
    for (const [, , url = ''] of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      if (url.startsWith('data:') || url.startsWith('#')) continue;
      expect(existsSync(resolve(dirname(file), url)), url).toBe(true);
      fonts.push(url);
    }
  }
  expect(fonts.some((url) => /manrope.*\.woff2$/.test(url))).toBe(true);
  expect(fonts.some((url) => /jetbrains-mono.*\.woff2$/.test(url))).toBe(true);
});
