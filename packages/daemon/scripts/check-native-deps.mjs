#!/usr/bin/env node
/**
 * Cross-platform native-deps smoke test.
 *
 * The daemon ships three modules that load native code at runtime:
 *
 *   - `better-sqlite3` — N-API binding, prebuilds via prebuild-install
 *     with a node-gyp fallback. Loads `build/Release/better_sqlite3.node`.
 *   - `node-pty`       — prebuilds via the package's own
 *     `scripts/prebuild.js`, falls back to `node-gyp rebuild`. Loads
 *     `build/Release/pty.node`.
 *   - `@vscode/ripgrep`— ships per-platform optional sub-packages
 *     (`@vscode/ripgrep-linux-x64`, `-win32-x64`, …) and resolves to
 *     the matching binary via `rgPath`.
 *
 * Any of the three can fail at install time when the host doesn't
 * have a Python toolchain, when prebuilds are unavailable for the
 * current Node ABI, or — for ripgrep — when the matching optional
 * sub-package wasn't installed (pnpm's strict resolver can skip
 * optional deps for some platforms).
 *
 * This script catches those failures early. It imports each module,
 * exercises a minimal sanity path, and exits non-zero on any error
 * with a structured summary so CI can surface which dep regressed.
 *
 * Intentionally has no production dependencies — wired into
 * `pnpm check` so a clean `pnpm install` on Linux / Windows / macOS
 * is enough to validate the daemon's runtime story.
 */

import { existsSync, statSync } from "node:fs";

const results = [];

async function check(name, fn) {
  try {
    const msg = await fn();
    results.push({ name, ok: true, message: msg });
  } catch (err) {
    const message =
      err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
    results.push({ name, ok: false, message });
  }
}

await check("better-sqlite3", async () => {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(":memory:");
  try {
    const row = db.prepare("SELECT 1 AS one").get();
    if (!row || row.one !== 1) {
      throw new Error(`unexpected query result: ${JSON.stringify(row)}`);
    }
    return "loaded + in-memory query OK";
  } finally {
    db.close();
  }
});

await check("node-pty", async () => {
  const mod = await import("node-pty");
  // node-pty's `spawn` export wraps the native `pty.node` binding.
  // Accessing it triggers the bindings.gyp load path; we don't
  // actually fork a process because that's heavy + flaky in CI.
  if (typeof mod.spawn !== "function") {
    throw new Error("`spawn` export missing");
  }
  return "loaded; spawn() reachable";
});

await check("@vscode/ripgrep", async () => {
  const { rgPath } = await import("@vscode/ripgrep");
  if (typeof rgPath !== "string" || rgPath.length === 0) {
    throw new Error("rgPath is empty");
  }
  if (!existsSync(rgPath)) {
    throw new Error(
      `rgPath points at a missing binary (${rgPath}); the optional ` +
        `platform sub-package was not installed`,
    );
  }
  const stat = statSync(rgPath);
  if (!stat.isFile()) {
    throw new Error(`rgPath is not a regular file: ${rgPath}`);
  }
  return `binary present at ${rgPath} (${(stat.size / 1024).toFixed(0)} KiB)`;
});

let allOk = true;
for (const r of results) {
  const marker = r.ok ? "✓" : "✗";
  const line = `  ${marker} ${r.name.padEnd(20)} — ${r.message}`;
  if (r.ok) {
    console.log(line);
  } else {
    allOk = false;
    console.error(line);
  }
}

if (!allOk) {
  console.error(
    "\n[check-native-deps] one or more native modules failed to load.\n" +
      "  - Confirm `pnpm install` completed without prebuild fallback errors.\n" +
      "  - On Linux: install `python3`, `make`, `g++` if a prebuild was unavailable.\n" +
      "  - On Windows: install the windows-build-tools (or VS2019+ with C++ desktop).\n" +
      "  - For @vscode/ripgrep: confirm the matching `@vscode/ripgrep-<os>-<arch>` " +
      "optional dep installed (pnpm sometimes skips them under strict resolver settings).",
  );
  process.exit(1);
}

console.log(
  `\n[check-native-deps] all ${results.length} native deps loaded on ${process.platform}/${process.arch}.`,
);
