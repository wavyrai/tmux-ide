#!/usr/bin/env node
/**
 * Cross-platform native-deps smoke test.
 *
 * The daemon ships ONE module that loads native code at runtime:
 *
 *   - `node-pty` — prebuilds via the package's own `scripts/prebuild.js`,
 *     falls back to `node-gyp rebuild`. Loads `build/Release/pty.node`.
 *     Used by the server surface's PTY bridge.
 *
 * (The v2.6.0 trim removed better-sqlite3 and @vscode/ripgrep along with
 * the dashboard/search stack they served.)
 *
 * Native installs can fail when the host lacks a Python toolchain or when
 * prebuilds are unavailable for the current Node ABI. This script catches
 * that early: it imports the module, exercises a minimal sanity path, and
 * exits non-zero with a structured summary so CI can surface a regression.
 *
 * Intentionally has no production dependencies — wired into `pnpm check`
 * so a clean `pnpm install` on Linux / Windows / macOS is enough to
 * validate the daemon's runtime story.
 */

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
    "\n[check-native-deps] a native module failed to load.\n" +
      "  - Confirm `pnpm install` completed without prebuild fallback errors.\n" +
      "  - On Linux: install `python3`, `make`, `g++` if a prebuild was unavailable.\n" +
      "  - On Windows: install the windows-build-tools (or VS2019+ with C++ desktop).",
  );
  process.exit(1);
}

console.log(
  `\n[check-native-deps] all ${results.length} native deps loaded on ${process.platform}/${process.arch}.`,
);
