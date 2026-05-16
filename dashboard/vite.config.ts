import { defineConfig } from "vite";
import { resolve } from "node:path";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

/**
 * Dashboard Vite config (post-G16 Solid SPA).
 *
 * `dedupe: ['solid-js']` is load-bearing — when v2-solid-widgets or
 * chat-solid are consumed via workspace alias, vite must collapse them
 * onto the single `solid-js` instance the dashboard app imports.
 * Otherwise reactivity silently breaks across the silo boundary.
 */
export default defineConfig({
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
    dedupe: ["solid-js"],
  },
  server: {
    port: 3000,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    // No sourcemaps in the shipped bundle — *.map files were ~85% of
    // the npm tarball. Debug locally with `pnpm dev` instead.
    sourcemap: false,
    target: "es2022",
  },
  test: {
    environment: "happy-dom",
    globals: true,
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
        "src/main.tsx",
        "src/routes/**", // SPA route shells — body lives in feature modules
      ],
      // Thresholds pin the *floor* — set just below current numbers
      // so a regression fails CI but today's coverage passes. The
      // dashboard SPA was freshly ported in G16 and is still growing
      // its test surface; targets are deliberately lower than the
      // silos. Bump toward the audit target (60% lines) as more
      // components land.
      thresholds: {
        lines: 25, // target: 60
        functions: 35, // target: 60
        statements: 25, // target: 60
        branches: 20, // target: 50
      },
    },
  },
});
