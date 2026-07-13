/**
 * Belt-and-braces prepublish guard.
 *
 * `prepublishOnly` already runs `pnpm check`. This script adds the
 * static-file freshness assert that lifecycle step doesn't —
 * specifically, that the git-tracked build output `bin/cli.js` is
 * actually newer than the source it's built from. The maintainer can
 * forget to rebuild + stage it before tagging; this script fails
 * loudly when that happens.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { join } from "node:path";

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

run("pnpm", ["run", "lint:workspace"]);
run("pnpm", ["run", "typecheck"]);
run("pnpm", ["run", "test:unit"]);

// ---------------------------------------------------------------
// bin/cli.js freshness — the esbuild output ships in the tarball.
// `prepublishOnly` now runs `pnpm build:cli` first, but this assert
// stays as defense-in-depth: a stale `bin/cli.js` is the #1 way the
// maintainer accidentally publishes pre-edit CLI behaviour.
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
// Native macOS notification sender — release.yml builds this on a macOS 26
// runner and injects it into packages/daemon/dist before npm publish. npm and
// Homebrew consume the same tarball, so a missing bundle would silently put
// users back on an unbranded AppleScript fallback.
// ---------------------------------------------------------------
const notifierRoot = join(
  process.cwd(),
  "packages",
  "daemon",
  "dist",
  "native",
  "TmuxIdeNotifier.app",
  "Contents",
);
for (const relative of [
  "Info.plist",
  join("Resources", "Assets.car"),
  join("Resources", "AppIcon.icns"),
]) {
  const path = join(notifierRoot, relative);
  if (!existsSync(path)) {
    throw new Error(
      `native macOS notifier is incomplete (${relative} missing) — run pnpm build:macos-notifier on macOS`,
    );
  }
}
const notifierExecutable = join(notifierRoot, "MacOS", "tmux-ide-notifier");
try {
  accessSync(notifierExecutable, constants.X_OK);
} catch {
  throw new Error(
    "native macOS notifier executable is missing or not executable — run pnpm build:macos-notifier on macOS",
  );
}
