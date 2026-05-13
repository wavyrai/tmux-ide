import { defineConfig } from "vite";
import { resolve } from "node:path";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

/**
 * Goal-16 dashboard-solid Vite config.
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
    port: 3001,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./__tests__/setup.ts"],
  },
});
