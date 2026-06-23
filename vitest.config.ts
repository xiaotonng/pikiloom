import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["node_modules/**", "web/**"],
    setupFiles: ["./test/setup.ts"],
  },
});
