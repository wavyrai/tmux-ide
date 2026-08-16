import { defineConfig } from "vitest/config";

/**
 * Process-isolated acceptance lane for the Electron host's real tmux, daemon,
 * PTY, and WebSocket tests. A single worker preserves ownership of the
 * process-global canonical-daemon environment and keeps lifecycle budgets
 * deterministic without weakening their assertions.
 */
export default defineConfig({
  test: {
    environment: "node",
    maxWorkers: 1,
    include: ["src/**/*-live.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
