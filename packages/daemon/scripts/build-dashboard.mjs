#!/usr/bin/env node
/**
 * Build the Solid dashboard SPA and copy its production bundle into
 * the daemon package's own `dist/` so the npm tarball ships a
 * self-contained server + UI.
 *
 * Layout after running:
 *
 *   packages/daemon/
 *     dist/
 *       command-center/
 *         static.js     ← serveDashboard()
 *       dashboard/
 *         dist/
 *           index.html
 *           assets/...  ← Vite-hashed JS + CSS bundles
 *
 * `static.ts#resolveDashboardOut` walks up from `dist/command-center/`
 * looking for a sibling `dashboard/dist`. The walk finds the daemon's
 * own bundled copy first (depth 1) when the package is npm-installed,
 * and the workspace root copy (depth >5) when running in dev.
 *
 * Invoke directly (`node scripts/build-dashboard.mjs`) or via the
 * daemon's `build` / `prepack` lifecycle scripts.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = resolve(HERE, "..");

/** Walk up looking for the workspace marker. Bails at filesystem root. */
function findWorkspaceRoot(start) {
  let current = start;
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not find pnpm-workspace.yaml above ${start}`);
}

const WORKSPACE_ROOT = findWorkspaceRoot(DAEMON_ROOT);
const DASHBOARD_SRC = join(WORKSPACE_ROOT, "dashboard");
const DASHBOARD_BUILD = join(DASHBOARD_SRC, "dist");
const DAEMON_BUNDLE_DEST = join(DAEMON_ROOT, "dist", "dashboard", "dist");

if (!existsSync(DASHBOARD_SRC)) {
  console.error(`[build-dashboard] dashboard/ not found at ${DASHBOARD_SRC}`);
  process.exit(1);
}

console.log("[build-dashboard] workspace root:", WORKSPACE_ROOT);
console.log("[build-dashboard] building @tmux-ide/dashboard…");

// Run the dashboard's vite build via pnpm. The filter form works from
// anywhere inside the workspace; we pass `--dir <workspace>` so the
// command stays robust when invoked by `pnpm run prepack` from
// `packages/daemon/`.
const buildResult = spawnSync(
  "pnpm",
  ["--filter", "@tmux-ide/dashboard", "build"],
  { stdio: "inherit", cwd: WORKSPACE_ROOT, env: process.env },
);
if (buildResult.status !== 0) {
  console.error(
    `[build-dashboard] dashboard build failed (exit code ${buildResult.status})`,
  );
  process.exit(buildResult.status ?? 1);
}

if (!existsSync(DASHBOARD_BUILD)) {
  console.error(
    `[build-dashboard] expected dashboard build output at ${DASHBOARD_BUILD} but it doesn't exist`,
  );
  process.exit(1);
}

// Drop any stale bundle from a previous run so removed/renamed
// hashed assets don't accumulate in the tarball.
if (existsSync(DAEMON_BUNDLE_DEST)) {
  rmSync(DAEMON_BUNDLE_DEST, { recursive: true, force: true });
}
mkdirSync(DAEMON_BUNDLE_DEST, { recursive: true });

let fileCount = 0;
let byteCount = 0;
function copyRecursive(src, dest) {
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyRecursive(from, to);
    } else if (entry.isFile()) {
      copyFileSync(from, to);
      fileCount += 1;
      byteCount += statSync(from).size;
    }
  }
}

copyRecursive(DASHBOARD_BUILD, DAEMON_BUNDLE_DEST);

console.log(
  `[build-dashboard] copied ${fileCount} files (${(byteCount / 1024).toFixed(1)} KiB) →`,
  relative(WORKSPACE_ROOT, DAEMON_BUNDLE_DEST),
);
