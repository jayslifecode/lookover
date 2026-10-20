import { defineConfig } from 'vitest/config';

const E2E_TIMEOUT_MS = 180_000;
const TEARDOWN_TIMEOUT_MS = 30_000;

/** The end-to-end suite: the built CLI against the bench app, which global setup serves on port 3123. */
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
  },
});
