import stylex from "@stylexjs/unplugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import existingConfig, { developmentHostBootstrap } from "../desktop-renderer/vite.config.ts";
export default defineConfig({
  plugins: [
    stylex.vite(),
    react().map(({ transformIndexHtml: _inlinePreamble, ...plugin }) => plugin),
    developmentHostBootstrap(),
  ],
  build: { target: "es2022" },
  resolve: {
    alias: { "@superlogical/shared": fileURLToPath(new URL("./shared", import.meta.url)) },
  },
  server: existingConfig.server,
});
