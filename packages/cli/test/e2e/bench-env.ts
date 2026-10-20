import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the end-to-end suite finds the repository, the bench app and its own scratch output. */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const BENCH_APP_DIR = join(REPO_ROOT, 'bench', 'app');
export const BENCH_DATA_FILES: readonly string[] = [
  join(BENCH_APP_DIR, 'data', 'organisations.json'),
  join(BENCH_APP_DIR, 'data', 'settings.json'),
];
export const BENCH_PACKAGE = '@jayslifecode/lookover-bench';

/** The bench app's fixed port (`next dev -p 3123`). */
export const BENCH_PORT = 3123;
export const BENCH_URL = `http://localhost:${BENCH_PORT}`;

/** The bench server's log and the run's transcript, kept for a failed CI run (git-ignored). */
export const E2E_OUTPUT_DIR = fileURLToPath(new URL('../../.e2e/', import.meta.url));
