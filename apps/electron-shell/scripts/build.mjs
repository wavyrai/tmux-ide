import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(packageRoot, "dist");
const rendererDist = join(packageRoot, "..", "desktop-renderer", "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await Promise.all([
  build({
    entryPoints: [join(packageRoot, "src", "main.ts")],
    outfile: join(dist, "main.cjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["electron"],
    sourcemap: true,
    logLevel: "info",
  }),
  build({
    entryPoints: [join(packageRoot, "src", "preload.ts")],
    outfile: join(dist, "preload.cjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["electron"],
    sourcemap: true,
    logLevel: "info",
  }),
]);

await cp(rendererDist, join(dist, "renderer"), { recursive: true });

const rendererHtml = await readFile(join(dist, "renderer", "index.html"), "utf8");
if (/Content-Security-Policy/iu.test(rendererHtml)) {
  throw new Error(
    "packaged renderer must receive its exact CSP from the trusted protocol response",
  );
}

const rendererAssets = await readdir(join(dist, "renderer", "assets"));
if (rendererAssets.some((name) => name.endsWith(".map"))) {
  throw new Error("packaged renderer must not ship source maps");
}
for (const asset of rendererAssets.filter((name) => name.endsWith(".js"))) {
  const source = await readFile(join(dist, "renderer", "assets", asset), "utf8");
  for (const forbidden of [
    "/api/workspaces",
    "/api/resources/workspace-catalog",
    "/ws/events",
    "http://127.0.0.1",
    "http://localhost",
  ]) {
    if (source.includes(forbidden)) {
      throw new Error(`packaged renderer contains a daemon-network route: ${forbidden}`);
    }
  }
}
