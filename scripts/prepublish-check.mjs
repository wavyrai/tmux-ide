/**
 * Belt-and-braces prepublish guard.
 *
 * `prepublishOnly` already runs `pnpm check` + a fresh dashboard
 * build. This script adds the static-file freshness asserts those
 * lifecycle steps don't — specifically, that the two git-tracked
 * build outputs (`bin/cli.js` and `dashboard/dist/`) are actually
 * newer than the sources they're built from. The maintainer can
 * forget to rebuild + stage either one before tagging; this script
 * fails loudly when that happens.
 *
 * Not wired into `prepublishOnly` itself yet — it's a separate
 * `pnpm prepublish:check` rung the release runbook calls before
 * tagging.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

function newestMtime(dir, ignore = new Set(["node_modules", "dist", "out", ".next", ".turbo"])) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignore.has(entry.name)) continue;
    const path = join(dir, entry.name);
    const stat = statSync(path);
    if (stat.isDirectory()) newest = Math.max(newest, newestMtime(path, ignore));
    else newest = Math.max(newest, stat.mtimeMs);
  }
  return newest;
}

run("pnpm", ["run", "lint:workspace"]);
run("pnpm", ["run", "typecheck"]);
run("pnpm", ["run", "test:unit"]);
run("pnpm", ["run", "build:dashboard"]);

// ---------------------------------------------------------------
// bin/cli.js freshness — the esbuild output ships in the tarball;
// `prepublishOnly` does not rebuild it (only `pnpm build:cli` does),
// so a stale `bin/cli.js` is the #1 way the maintainer accidentally
// publishes pre-edit CLI behaviour.
// ---------------------------------------------------------------
const cliJsPath = join(process.cwd(), "bin", "cli.js");
const cliTsPath = join(process.cwd(), "bin", "cli.ts");
if (!existsSync(cliJsPath)) {
  throw new Error("bin/cli.js is missing — run: pnpm build:cli && git add bin/cli.js");
}
if (!existsSync(cliTsPath)) {
  throw new Error("bin/cli.ts is missing — repository appears corrupted");
}
const cliJsMtime = statSync(cliJsPath).mtimeMs;
const cliTsMtime = statSync(cliTsPath).mtimeMs;
if (cliJsMtime < cliTsMtime) {
  throw new Error(
    "bin/cli.js is older than bin/cli.ts — run: pnpm build:cli && git add bin/cli.js",
  );
}

// ---------------------------------------------------------------
// dashboard/dist freshness — Vite output. Must exist and must be
// at least as fresh as `dashboard/src/`. (Post-G16 the output dir
// is `dist/`, not `out/` — older audit text referenced the latter.)
// ---------------------------------------------------------------
const dashboardDist = join(process.cwd(), "dashboard", "dist");
const dashboardIndex = join(dashboardDist, "index.html");
if (!existsSync(dashboardDist) || !existsSync(dashboardIndex)) {
  throw new Error(
    "dashboard/dist/index.html is missing after dashboard build — " +
      "run: pnpm --filter @tmux-ide/dashboard build",
  );
}
const dashboardSrc = join(process.cwd(), "dashboard", "src");
if (!existsSync(dashboardSrc)) {
  throw new Error("dashboard/src is missing — repository appears corrupted");
}
const dashboardSrcMtime = newestMtime(dashboardSrc);
const dashboardDistMtime = newestMtime(dashboardDist);
if (dashboardDistMtime < dashboardSrcMtime) {
  throw new Error(
    "dashboard/dist is older than dashboard/src — " +
      "run: pnpm --filter @tmux-ide/dashboard build",
  );
}
