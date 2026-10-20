/*
 * Restores the bench data to its seed: `pnpm --filter @jayslifecode/lookover-bench reset`, or
 * `node --experimental-strip-types <path>/bench/scripts/reset.ts` from any directory: the data
 * directory is found from this file's location, not the cwd.
 */
import { join } from 'node:path';
import { resetStore } from '../app/lib/store.ts';

const DATA_DIR = join(import.meta.dirname, '..', 'app', 'data');

await resetStore(DATA_DIR);
console.log(`Bench data reset from ${join(DATA_DIR, 'seed')}`);
