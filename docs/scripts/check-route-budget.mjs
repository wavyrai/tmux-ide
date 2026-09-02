import { gzipSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docsDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const nextDir = resolve(docsDir, ".next");
const manifestPath = resolve(nextDir, "server/app/(home)/page_client-reference-manifest.js");
const rawBudget = Number(process.env.TMUX_IDE_HOME_JS_RAW_BUDGET ?? 200 * 1024);
const gzipBudget = Number(process.env.TMUX_IDE_HOME_JS_GZIP_BUDGET ?? 70 * 1024);
const htmlGzipBudget = Number(process.env.TMUX_IDE_HOME_HTML_GZIP_BUDGET ?? 28 * 1024);
const demoGzipBudget = Number(process.env.TMUX_IDE_DEMO_GZIP_BUDGET ?? 8 * 1024);

const source = readFileSync(manifestPath, "utf8");
const assignment = source.indexOf(" = {");
if (assignment < 0) throw new Error(`Unrecognized client reference manifest: ${manifestPath}`);
const manifest = JSON.parse(source.slice(assignment + 3).replace(/;\s*$/u, ""));
const chunks = [
  ...new Set(Object.values(manifest.clientModules).flatMap((entry) => entry.chunks ?? [])),
].sort();

let rawBytes = 0;
let gzipBytes = 0;
for (const chunk of chunks) {
  const path = resolve(nextDir, chunk.replace(/^\/_next\//u, ""));
  const body = readFileSync(path);
  rawBytes += statSync(path).size;
  gzipBytes += gzipSync(body, { level: 9 }).length;
}

const prerender = JSON.parse(readFileSync(resolve(nextDir, "prerender-manifest.json"), "utf8"));
if (!("/" in prerender.routes)) throw new Error("Homepage is not statically prerendered");
if (rawBytes > rawBudget || gzipBytes > gzipBudget) {
  throw new Error(
    `Homepage client JS exceeds budget: ${rawBytes}/${rawBudget} raw bytes, ` +
      `${gzipBytes}/${gzipBudget} gzip bytes (${chunks.length} chunks)`,
  );
}

const html = readFileSync(resolve(nextDir, "server/app/index.html"));
const htmlGzipBytes = gzipSync(html, { level: 9 }).length;
if (htmlGzipBytes > htmlGzipBudget) {
  throw new Error(`Homepage HTML exceeds budget: ${htmlGzipBytes}/${htmlGzipBudget} gzip bytes`);
}

const demo = readFileSync(resolve(docsDir, "public/tui-demo.svg"));
const demoGzipBytes = gzipSync(demo, { level: 9 }).length;
if (demoGzipBytes > demoGzipBudget) {
  throw new Error(`TUI demo exceeds budget: ${demoGzipBytes}/${demoGzipBudget} gzip bytes`);
}

console.log(
  `Homepage client JS: ${rawBytes} raw bytes, ${gzipBytes} gzip bytes, ` +
    `${chunks.length} chunks; HTML ${htmlGzipBytes} gzip bytes; ` +
    `TUI demo ${demoGzipBytes} gzip bytes; static prerender confirmed.`,
);
