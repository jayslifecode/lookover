import { fileURLToPath } from 'node:url';

/*
 * What the CLI needs to serve the report: where the built files are. The report is built with
 * `base: './'`, so the files can be served from any path. The HTTP contract is in `./api`
 * (`@jayslifecode/lookover-report/api`).
 */

/** The built report (`vite build` output): `<package>/dist`. */
export const REPORT_DIST_DIR = fileURLToPath(new URL('../dist', import.meta.url));

/** The report's page, served for `/`. */
export const REPORT_INDEX_FILE = fileURLToPath(new URL('../dist/index.html', import.meta.url));
