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
import { mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const entry = resolve(repoRoot, "packages/daemon/src/tui/main.ts");
const defaultOutDir = resolve(repoRoot, "packages/daemon/dist/tui");

if (!existsSync(entry)) {
  throw new Error(`[build-tui] entry not found: ${entry}`);
}

const targetArg = process.argv.indexOf("--target");
const target =
  targetArg !== -1 ? process.argv[targetArg + 1] : `bun-${process.platform}-${process.arch}`;

const outfileArg = process.argv.indexOf("--outfile");
const outfile =
  outfileArg !== -1
    ? resolve(process.argv[outfileArg + 1])
    : resolve(defaultOutDir, "tmux-ide-tui");

mkdirSync(dirname(outfile), { recursive: true });

const start = Date.now();
const result = await Bun.build({
  entrypoints: [entry],
  target: "bun",
  compile: { outfile, target },
  plugins: [createSolidTransformPlugin()],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("[build-tui] compile failed");
}

const bytes = statSync(outfile).size;
const mb = (bytes / 1024 / 1024).toFixed(1);
console.log(`[build-tui] wrote ${outfile} (${mb} MB, target ${target}, ${Date.now() - start}ms)`);
