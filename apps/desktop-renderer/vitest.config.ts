import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  test: {
    css: true,
    environment: "node",
    // The app-level Playwright suite (`e2e/`) starts a tmux server, a daemon
    // and a browser per test. Vitest's default glob would claim those files
    // and run them without any of that, so they are excluded by directory
    // rather than by relying on their `.e2e.ts` suffix alone.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
});
