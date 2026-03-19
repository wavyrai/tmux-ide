import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

await Bun.build({
  entrypoints: ["src/widgets/explorer/index.tsx"],
  outdir: "dist/widgets/explorer",
  target: "bun",
  format: "esm",
  conditions: ["browser"],
  plugins: [createSolidTransformPlugin()],
  external: ["@opentui/core", "@opentui/solid", "@parcel/watcher", "ignore"],
});

console.log("Widgets built successfully");
