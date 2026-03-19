import { build } from "esbuild";
import { solidPlugin } from "esbuild-plugin-solid";

await build({
  entryPoints: ["src/widgets/explorer/index.tsx"],
  outdir: "dist/widgets/explorer",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  plugins: [solidPlugin()],
  external: ["@opentui/core", "@opentui/solid", "solid-js"],
});

console.log("Widgets built successfully");
