import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";

/**
 * Vitest config for the daemon package. Scoped to the suites that have
 * opted into Vitest (Zod 4 schemas, the contracts package, the shared
 * toolchain). The remaining daemon tests target `bun:test`.
 */
export default defineConfig({
  plugins: [solid()],
  // vite-plugin-solid adds the `browser` export condition in test mode so DOM
  // host tests compile with the client Solid runtime. Pin ws to its Node ESM
  // entry so embedded-daemon tests retain WebSocketServer under that condition.
  resolve: {
    alias: [{ find: /^ws$/, replacement: fileURLToPath(import.meta.resolve("ws")) }],
  },
  test: {
    css: true,
    environment: "node",
    include: [
      "src/restore.test.ts",
      "src/doctor.test.ts",
      "src/terminal/__tests__/*.test.ts",
      "src/lib/app-config.test.ts",
      "src/lib/cli-action-bridge.test.ts",
      "src/lib/__tests__/*.test.ts",
      "src/command-center/actions/*.test.ts",
      "src/command-center/workspace-pane-create-auth.test.ts",
      "src/control/*.test.ts",
      "src/tui/*.test.ts",
      "src/tui/detect/*.test.ts",
      "src/tui/team/*.test.ts",
      "src/tui/mirror/*.test.ts",
      "src/tui/mirror/workspace/**/*.test.ts",
      "src/tui/chrome/*.test.ts",
      "src/tui/integrations/*.test.ts",
      "src/widgets/lib/grammar.test.ts",
      "src/ui/pane-frame/**/*.test.ts",
      "src/ui/pane-frame/**/*.test.tsx",
      "src/ui/workbench-dock/**/*.test.ts",
      "src/ui/workbench-dock/**/*.test.tsx",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/terminal/**/*.ts"],
      exclude: ["**/*.test.ts", "**/__tests__/**", "**/__mocks__/**", "**/types.ts", "**/index.ts"],
      thresholds: {
        lines: 40,
        functions: 35,
        statements: 40,
        branches: 30,
      },
    },
  },
});
