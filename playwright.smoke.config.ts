import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the T3 smoke job (.github/workflows/smoke.yml).
 *
 * Differences from the default `playwright.config.ts`:
 *   - testMatch is scoped to `e2e/smoke.spec.ts` only.
 *   - `webServer` is intentionally omitted — the workflow boots the
 *     daemon (command-center) and dashboard (next start) manually so
 *     the smoke runs against the same prod-mode bundle a user would
 *     load, not the dev server.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /smoke\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
});
