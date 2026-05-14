import { resolve } from "node:path";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";

/**
 * `solid-js` (+ `solid-js/web` / `solid-js/store`) MUST stay external.
 *
 * The package exports two kinds of consumers: standalone `mount*`
 * factories that call `render()` internally — these tolerate an
 * inlined solid-js because they create an isolated root — AND
 * `WidgetHost`, a Solid component intended to be rendered inside a
 * host app's reactive context. When solid-js is bundled into this
 * dist, `WidgetHost`'s `onMount` / `createEffect` / `onCleanup`
 * register against the package's bundled solid-js instance, not the
 * dashboard's. The dashboard's render pipeline never flushes those
 * hooks, so `mount(container, opts)` is never invoked and the host
 * divs render empty — the regression that produced the
 * empty-Plans / empty-Skills surfaces.
 *
 * Externalizing forces consumers to provide solid-js. The dashboard
 * already does, with `dedupe: ['solid-js']` ensuring a single
 * instance across the workspace.
 */
export default defineConfig({
  plugins: [solid(), cssInjectedByJsPlugin()],
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.tsx"),
      formats: ["es"],
      fileName: () => "v2-solid-widgets.js",
    },
    rollupOptions: {
      external: ["solid-js", "solid-js/web", "solid-js/store"],
    },
    sourcemap: true,
    target: "es2022",
  },
});
