import { resolve } from "node:path";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";

export default defineConfig({
  plugins: [tailwindcss(), solid(), cssInjectedByJsPlugin()],
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.tsx"),
      formats: ["es"],
      fileName: () => "chat-solid.js",
    },
    rollupOptions: {
      external: [],
    },
    sourcemap: true,
    target: "es2022",
  },
  test: {
    environment: "happy-dom",
  },
});
