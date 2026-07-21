import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Standard Solid DOM library build; terminal/custom renderers stay external. */
export default defineConfig({
  plugins: [solid()],
  build: {
    lib: {
      entry: here("./src/ui/pane-frame/web-entry.tsx"),
      formats: ["es"],
      fileName: () => "pane-frame-web.js",
      cssFileName: "pane-frame-web",
    },
    outDir: here("./dist/ui/pane-frame/web"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      external: [/^solid-js(?:\/.*)?$/u, /^@tmux-ide\/contracts$/u],
    },
  },
});
