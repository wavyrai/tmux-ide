import { defineConfig } from "vitest/config";

/**
 * Hermetic Electron-host test lane.
 *
 * Tests whose names end in `-live.test.ts` own real tmux sockets, canonical
 * daemon records, child processes, PTYs, and WebSockets. They are deliberately
 * excluded here and run serially by vitest.live.config.ts after this worker
 * pool has retired.
 */
export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "src/**/*-live.test.ts"],
  },
});
