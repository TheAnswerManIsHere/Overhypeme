import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    // The e2e/ directory contains Playwright specs (run via `pnpm run e2e`),
    // not vitest tests; exclude them so `vitest run` doesn't pick them up.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@workspace/redact": path.resolve(import.meta.dirname, "../../lib/redact/src/index.ts"),
    },
  },
});
