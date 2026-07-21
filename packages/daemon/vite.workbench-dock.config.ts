import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Standard Solid DOM library build; no universal/custom renderer is involved. */
export default defineConfig({
  plugins: [solid()],
  build: {
    lib: {
      entry: here("./src/ui/workbench-dock/web-entry.tsx"),
      formats: ["es"],
      fileName: () => "workbench-dock-web.js",
      cssFileName: "workbench-dock-web",
    },
    // Vite owns only this leaf. The normal daemon tsc build also emits runtime
    // modules under dist/ui/workbench-dock, so clearing the parent would break
    // imports from compiled TUI projection modules such as workbench-shell.js.
    outDir: here("./dist/ui/workbench-dock/web"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      external: [/^solid-js(?:\/.*)?$/u],
    },
  },
});
