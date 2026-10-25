import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/** Above the suite's own limit on the `lookover run` process (360 s), so a hung run is reported as one. */
const E2E_TIMEOUT_MS = 420_000;
const TEARDOWN_TIMEOUT_MS = 30_000;
/** The bench suite runs first; the report's files (`report*.test.ts`) after it, by name. */
const BENCH_SUITE = /\/bench\.test\.ts$/;

class BenchFirst extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const rank = (file: TestSpecification) => (BENCH_SUITE.test(file.moduleId) ? 0 : 1);
    return files.toSorted((a, b) => rank(a) - rank(b) || a.moduleId.localeCompare(b.moduleId));
  }
}

/**
 * The end-to-end suite: the built CLI against the bench app, which global setup serves on port 3123, then
 * the built report, served by the real report server over the report package's fixture run.
 */
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    globalSetup: ['test/e2e/global-setup.ts'],
    testTimeout: E2E_TIMEOUT_MS,
    hookTimeout: E2E_TIMEOUT_MS,
    teardownTimeout: TEARDOWN_TIMEOUT_MS,
    // One bench server and one data directory: test files must not run side by side.
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { sequencer: BenchFirst },
  },
});
