import { fileURLToPath } from "node:url";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

/**
 * Process-isolated acceptance lane for tests that own real tmux sockets,
 * daemons, PTYs, or concurrent CLI contenders. Running these serially keeps
 * their fixed lifecycle budgets meaningful under the canonical package gate.
 */
export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: [{ find: /^ws$/, replacement: fileURLToPath(import.meta.resolve("ws")) }],
  },
  test: {
    css: true,
    environment: "node",
    // No test may reach a live tmux server: private socket directory + guard.
    globalSetup: ["./test-support/tmux-isolation-global.ts"],
    setupFiles: ["./test-support/tmux-isolation-setup.ts"],
    maxWorkers: 1,
    include: ["src/**/*-live.test.ts", "src/lib/__tests__/headless-cli-entrypoint.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
