/**
 * App-level end-to-end runner.
 *
 * Every test here owns a whole stack — a tmux server, a daemon, a Vite dev
 * server and a browser — so the runner is deliberately serial. Parallel workers
 * would multiply four heavyweight processes per test and turn a real timing
 * failure into an indistinguishable resource failure.
 */
import { defineConfig, devices } from "@playwright/test";

const headed = process.env.E2E_HEADED === "1";

export default defineConfig({
  testDir: ".",
  // Not `*.spec.ts`: vitest's default glob claims both `.test.` and `.spec.`,
  // and these tests must never be picked up by the unit runner.
  testMatch: "**/*.e2e.ts",
  outputDir: "artifacts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // A chain builds its own infrastructure before it can assert anything; the
  // per-fixture waits are individually bounded, and this is the outer bound.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  // Actions are bounded independently of the test.
  //
  // Playwright retries a click's actionability check until the TEST timeout, so
  // one element that never becomes stable or never stops being intercepted
  // consumes the entire budget in silence — no network traffic, no failing
  // assertion, just a three-minute stall and a bare "Test timeout exceeded".
  // Bounding actions turns that into a fast, named failure that says which
  // element and what intercepted it.
  reporter: process.env.CI
    ? [["list"], ["json", { outputFile: "artifacts/results.json" }]]
    : "list",
  use: {
    ...devices["Desktop Chrome"],
    headless: !headed,
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    viewport: { width: 1_400, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
});
