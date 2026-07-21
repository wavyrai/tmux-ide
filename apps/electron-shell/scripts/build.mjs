import { cp, mkdir, readFile, rm } from "node:fs/promises";
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
for (const directive of [
  "default-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
]) {
  if (!rendererHtml.includes(directive)) {
    throw new Error(`desktop renderer CSP is missing: ${directive}`);
  }
}
if (/unsafe-(?:inline|eval)/u.test(rendererHtml)) {
  throw new Error("desktop renderer CSP must not permit unsafe-inline or unsafe-eval");
}
