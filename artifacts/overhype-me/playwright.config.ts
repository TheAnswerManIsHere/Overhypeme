import { defineConfig } from "@playwright/test";

const baseURL = process.env["E2E_BASE_URL"]
  ?? (process.env["REPLIT_DEV_DOMAIN"] ? `https://${process.env["REPLIT_DEV_DOMAIN"]}` : "http://localhost:5173");

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        // Escape hatch for environments with a system-provided Chromium at a
        // fixed path (e.g. Claude Code's remote container, where downloading
        // browsers is disabled and the pinned Playwright build may not match
        // the preinstalled one). Unset → Playwright's own managed browser, as
        // before (Replit and CI both use that path).
        ...(process.env["E2E_CHROMIUM_PATH"]
          ? { launchOptions: { executablePath: process.env["E2E_CHROMIUM_PATH"] } }
          : {}),
      },
    },
  ],
});
