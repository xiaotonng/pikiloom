import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `web/` is a standalone landing-page workspace with its own node_modules;
    // its third-party packages ship test files that vitest would otherwise pick
    // up and fail on. It is never part of the backend/dashboard test surface.
    exclude: ["node_modules/**", "web/**"],
    setupFiles: ["./test/setup.ts"],
  },
});
