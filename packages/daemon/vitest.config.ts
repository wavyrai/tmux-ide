import { defineConfig } from "vitest/config";

/**
 * Vitest config for the daemon package. Scoped to the suites that have
 * opted into Vitest (Zod 4 schemas, the contracts package, the shared
 * toolchain). The remaining daemon tests target `bun:test`.
 */
export default defineConfig({
  test: {
    include: [
      "src/restore.test.ts",
      "src/doctor.test.ts",
      "src/terminal/__tests__/*.test.ts",
      "src/lib/app-config.test.ts",
      "src/lib/__tests__/*.test.ts",
      "src/tui/*.test.ts",
      "src/tui/detect/*.test.ts",
      "src/tui/team/*.test.ts",
      "src/tui/mirror/*.test.ts",
      "src/tui/chrome/*.test.ts",
      "src/tui/integrations/*.test.ts",
      "src/widgets/lib/grammar.test.ts",
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
