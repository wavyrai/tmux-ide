import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Post-G16 cutover: the v1 React shell is gone, so the legacy specs
  // (project-tabs / context-bar / status-bar / etc) target routes that
  // no longer exist. They're parked behind testIgnore until they're
  // ported to the Solid surface. `smoke.spec.ts` is the live gate —
  // it runs via playwright.smoke.config.ts in smoke.yml against the
  // prod Vite build.
  testIgnore: [
    "smoke.spec.ts",
    "command-palette.spec.ts",
    "context-bar.spec.ts",
    "full-screen-terminal.spec.ts",
    "notifications.spec.ts",
    "plans.spec.ts",
    "project-tabs.spec.ts",
    "project-terminal.spec.ts",
    "responsive.spec.ts",
    "settings.spec.ts",
    "status-bar.spec.ts",
    "task-panel.spec.ts",
    "terminal.spec.ts",
    "toasts.spec.ts",
    "views.spec.ts",
    "workspace-tabs.spec.ts",
  ],
  timeout: 45_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      // bin/cli.js is the canonical entry point per CLAUDE.md and
      // imports from dist/, so `pnpm build` is a prerequisite for e2e.
      command: "node bin/cli.js server --port 6070",
      url: "http://127.0.0.1:6070/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "VITE_API_PORT=6070 pnpm --filter @tmux-ide/dashboard dev",
      url: "http://127.0.0.1:3000/",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
