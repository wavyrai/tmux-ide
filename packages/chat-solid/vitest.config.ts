import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "happy-dom",
    setupFiles: ["./__tests__/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/__tests__/**",
        "**/__mocks__/**",
        "src/index.tsx",
        "src/chat-solid.ts",
        "src/types.ts",
      ],
      // Thresholds pin the *floor* — set just below current numbers
      // so a regression fails CI but today's coverage passes. Bump
      // toward the audit target (80% lines) as new tests land.
      thresholds: {
        lines: 78, // target: 80
        functions: 75, // target: 80
        statements: 75, // target: 80
        branches: 60, // target: 75
      },
    },
  },
});
