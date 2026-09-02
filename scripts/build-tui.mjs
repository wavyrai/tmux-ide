#!/usr/bin/env bun
/**
 * Compiles the TUI dispatcher (`packages/daemon/src/tui/main.ts`) into a single
 * standalone `tmux-ide-tui` executable via `bun build --compile`.
 *
 * Why this exists: the cockpit/picker/sidebar/widget surfaces are OpenTUI/Solid
 * `.tsx` that only run from a dev checkout (bun + bunfig preload for the JSX
 * transform). This script produces a self-contained binary so those surfaces
 * work on a clean `npm i -g tmux-ide` with no bun runtime present. The binary
 * embeds the native OpenTUI dylib (Bun asset embedding) and pre-transforms JSX
 * at build time, so nothing external is needed at runtime.
 *
 * Output: `packages/daemon/dist/tui/tmux-ide-tui` (gitignored; the CLI probes
 * for it as the installed-mode fallback — see widgets/resolve.ts). Requires bun
 * to build; it is NOT built by the default `pnpm build` (which must stay
 * node-only for CI) — run `pnpm build:tui` on a machine with bun.
 *
 * Cross-compile: pass `--target bun-<os>-<arch>` (e.g. bun-linux-x64) to build
 * for another platform. Defaults to the host target. Pass `--outfile <path>` to
 * write somewhere other than the default dist path (the release workflow uses
 * this to emit per-platform artifacts side by side).
 */

import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseSourceState } from "./lib/release-source-state.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const entry = resolve(repoRoot, "packages/daemon/src/tui/main.ts");
const defaultOutDir = resolve(repoRoot, "packages/daemon/dist/tui");
const packageVersion = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).version;

const sourceCommit = (
  process.env.TMUX_IDE_RELEASE_COMMIT ??
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim()
).trim();
if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sourceCommit)) {
  throw new Error(`[build-tui] invalid release commit: ${sourceCommit}`);
}
const sourceState = releaseSourceState(
  execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repoRoot,
    encoding: "utf8",
  }),
);

if (!existsSync(entry)) {
  throw new Error(`[build-tui] entry not found: ${entry}`);
}

const targetArg = process.argv.indexOf("--target");
const target =
  targetArg !== -1 ? process.argv[targetArg + 1] : `bun-${process.platform}-${process.arch}`;
const platformTag = target.replace(/^bun-/u, "");

const outfileArg = process.argv.indexOf("--outfile");
const outfile =
  outfileArg !== -1
    ? resolve(process.argv[outfileArg + 1])
    : resolve(defaultOutDir, "tmux-ide-tui");

mkdirSync(dirname(outfile), { recursive: true });

const start = Date.now();
const parserWorkerSource = fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"));
const workerAssetPlugin = {
  name: "tmux-ide-opentui-worker-asset",
  setup(build) {
    build.onResolve({ filter: /^tmux-ide:opentui-parser-worker$/ }, () => ({
      path: parserWorkerSource,
      namespace: "tmux-ide-opentui-worker-asset",
    }));
    build.onLoad(
      { filter: /.*/, namespace: "tmux-ide-opentui-worker-asset" },
      async ({ path }) => ({
        contents: new Uint8Array(await Bun.file(path).arrayBuffer()),
        loader: "file",
      }),
    );
  },
};

// OpenTUI 0.5 owns its runtime asset graph. Its Bun entry embeds the parser
// worker, web-tree-sitter WASM, language parsers, queries, and native library
// through supported `import ... with { type: "file" }` boundaries. Keeping that
// graph intact lets future OpenTUI asset additions flow into the standalone
// executable automatically. The one explicit worker asset above bridges Bun's
// current inability to discover the import behind OpenTUI's runtime resolver;
// its contents come directly from OpenTUI rather than a forked bundle.
const result = await Bun.build({
  entrypoints: [entry],
  target: "bun",
  compile: { outfile, target },
  // This executable is the production runtime; source-mode development keeps
  // readable symbols. Minifying the embedded JS cuts cold-start IO and module
  // evaluation (the dominant first-frame cost) without changing OpenTUI's
  // native asset or the lazy surface dispatcher.
  minify: true,
  define: {
    TMUX_IDE_BUILD_VERSION: JSON.stringify(packageVersion),
    TMUX_IDE_BUILD_COMMIT: JSON.stringify(sourceCommit),
    TMUX_IDE_BUILD_PLATFORM: JSON.stringify(platformTag),
    TMUX_IDE_BUILD_SOURCE_STATE: JSON.stringify(sourceState),
  },
  plugins: [workerAssetPlugin, createSolidTransformPlugin()],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("[build-tui] compile failed");
}

const bytes = statSync(outfile).size;
const mb = (bytes / 1024 / 1024).toFixed(1);
console.log(
  `[build-tui] wrote ${outfile} (${mb} MB, version ${packageVersion}, commit ${sourceCommit.slice(0, 12)}, source ${sourceState}, target ${target}, ${Date.now() - start}ms)`,
);
