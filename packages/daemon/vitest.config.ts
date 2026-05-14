import { defineConfig } from "vitest/config";

/**
 * Vitest config for the daemon package. Scoped narrowly to tests that
 * have explicitly opted into Vitest — the rest of the daemon's tests
 * still target `bun:test` and are run via the package's `test` script.
 *
 * New tests that consume Zod 4 schemas, the contracts package, or the
 * shared toolchain should land here so we stay aligned with the
 * mission-level "tsc + vitest green" gate.
 */
export default defineConfig({
  test: {
    include: [
      "src/chat/tools/**/*.test.ts",
      "src/chat/checkpoint-engine.test.ts",
      "src/chat/turn-store.test.ts",
      "src/chat/session-store.test.ts",
      "src/chat/activity-log.test.ts",
      "src/chat/checkpoint-store.test.ts",
      "src/chat/legacy-to-v2.test.ts",
      "src/chat/event-emissions.test.ts",
      "src/chat/chat-integration.test.ts",
      "src/chat/plan-store.test.ts",
      "src/chat/__tests__/plan-routes.test.ts",
      "src/chat/provider-registry.test.ts",
      "src/chat/provider-store.test.ts",
      "src/terminal/__tests__/*.test.ts",
      "src/git/__tests__/*.test.ts",
      "src/lib/__tests__/*.test.ts",
      "src/lsp/__tests__/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
      // Scope coverage to the files exercised by this vitest harness.
      // The bun-driven test suite covers the rest of src/ and reports
      // separately — counting both under one threshold would double-
      // dip files that have no vitest harness yet.
      include: ["src/chat/**/*.ts", "src/terminal/**/*.ts", "src/git/**/*.ts"],
      exclude: ["**/*.test.ts", "**/__tests__/**", "**/__mocks__/**", "**/types.ts", "**/index.ts"],
      // Thresholds pin the *floor* — set just below current numbers
      // so a regression fails CI but today's coverage passes. Bump
      // toward the audit target (70%) as new tests land.
      thresholds: {
        lines: 65, // target: 70
        functions: 60, // target: 70
        statements: 60, // target: 70
        branches: 45, // target: 65
      },
    },
  },
});
