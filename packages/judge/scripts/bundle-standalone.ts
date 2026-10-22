/*
 * Bundles the standalone replay runner (`src/standalone/runner.ts`, as tsc compiled it to
 * `dist/standalone/runner.js`) and everything it imports but Playwright into `dist/standalone-runner.js`,
 * the text every generated replay script embeds. The package's `build` script runs it after tsc:
 *
 *   node --experimental-strip-types scripts/bundle-standalone.ts
 *
 * The rules package reads its catalogues from `catalogue/*.json` next to its own file at run time; a
 * script has no such directory beside it, so the bundle carries the catalogues and hands them to that
 * one read (see `inlineCatalogues`).
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';

const PACKAGE_DIR = join(import.meta.dirname, '..');
const ENTRY = join(PACKAGE_DIR, 'dist', 'standalone', 'runner.js');
const OUTFILE = join(PACKAGE_DIR, 'dist', 'standalone-runner.js');
const RULES_ENTRY = fileURLToPath(import.meta.resolve('@jayslifecode/lookover-rules'));
const CATALOGUE_DIR = join(dirname(RULES_ENTRY), '..', 'catalogue');
const CATALOGUE_NAMESPACE = 'lookover-catalogue';
const FS_MODULE = /^(node:)?fs$/;
const JSON_EXTENSION = '.json';

interface Manifest {
  version: string;
}

/** A module standing in for `node:fs` in the rules package: its `readFileSync` serves the catalogues. */
async function catalogueModule(): Promise<string> {
  const names = (await readdir(CATALOGUE_DIR)).filter((name) => name.endsWith(JSON_EXTENSION)).toSorted();
  const files = await Promise.all(
    names.map(async (name) => [name, await readFile(join(CATALOGUE_DIR, name), 'utf8')] as const),
  );
  return [
    `const CATALOGUES = ${JSON.stringify(Object.fromEntries(files))};`,
    'export function readFileSync(path) {',
    "  const name = String(path).split('/').pop();",
    '  if (!Object.hasOwn(CATALOGUES, name)) {',
    "    throw new Error('The standalone runner carries no file ' + String(path));",
    '  }',
    '  return CATALOGUES[name];',
    '}',
    '',
  ].join('\n');
}

/** Resolves the rules package's `node:fs` to `catalogueModule`; every other import of it is left alone. */
const inlineCatalogues: Plugin = {
  name: 'inline-rules-catalogues',
  setup(builder) {
    builder.onResolve({ filter: FS_MODULE }, (args) =>
      args.importer === RULES_ENTRY ? { path: 'fs', namespace: CATALOGUE_NAMESPACE } : undefined,
    );
    builder.onLoad({ filter: /.*/, namespace: CATALOGUE_NAMESPACE }, async () => ({
      contents: await catalogueModule(),
      loader: 'js',
    }));
  },
};

const { version } = JSON.parse(await readFile(join(PACKAGE_DIR, 'package.json'), 'utf8')) as Manifest;

await build({
  entryPoints: [ENTRY],
  outfile: OUTFILE,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['playwright'],
  minify: false,
  banner: {
    js: `// Lookover ${version}: the standalone replay runner (Playwright is imported, not bundled).`,
  },
  define: { LOOKOVER_VERSION: JSON.stringify(version) },
  plugins: [inlineCatalogues],
  logLevel: 'warning',
});
