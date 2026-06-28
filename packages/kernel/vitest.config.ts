import { defineConfig } from 'vitest/config';

// Standalone config: NO root setupFiles, so the kernel suite is fully hermetic and
// independent of the pikiloom app's test harness.
export default defineConfig({
  test: {
    root: __dirname,
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
