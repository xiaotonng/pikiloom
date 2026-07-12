import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["node_modules/**", "web/**", "packages/**"],
    setupFiles: ["./test/setup.ts"],
    // Several integration-style unit tests drive short-lived agent subprocesses.
    // Hosted CI can push them just past Vitest's 5 s default under worker load.
    testTimeout: 10_000,
  },
});
