#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
for (const script of ["build", "prepack", "pack:check"]) {
  if (pkg.scripts?.[script]?.includes("build:web")) {
    throw new Error(`${script} must not make the deferred Web GUI a release prerequisite`);
  }
}
if (pkg.files?.includes("apps/desktop-renderer/dist")) {
  throw new Error("OpenTUI npm package must not ship the deferred Web GUI bundle");
}
const prepublish = pkg.scripts?.prepublishOnly ?? "";
if (!prepublish.includes("release:opentui:check") || !prepublish.includes("prepublish-opentui")) {
  throw new Error("prepublishOnly must use the focused OpenTUI release boundary");
}
for (const deferred of ["pnpm check", "build:web", "product-test-rig", "macos-notifier"]) {
  if (prepublish.includes(deferred)) {
    throw new Error(`prepublishOnly unexpectedly requires deferred breadth: ${deferred}`);
  }
}

const cliSource = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");
if (!cliSource.includes("The Web GUI is not included in the OpenTUI beta")) {
  throw new Error("OpenTUI CLI must fail honestly when the deferred Web GUI is requested");
}
if (cliSource.includes("production-web-server.ts")) {
  throw new Error("OpenTUI CLI still imports the deferred production Web GUI server");
}

const output = execFileSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts", "--cache", "/tmp/tmux-ide-npm-cache"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
const report = JSON.parse(output)[0];
const files = new Set(report.files.map((entry) => entry.path));

for (const required of [
  "bin/cli.js",
  "scripts/postinstall.js",
  "scripts/build-tui.mjs",
  "scripts/opentui-release-check.mjs",
  "scripts/prepublish-opentui-check.mjs",
  "scripts/lib/npm-release-tag.mjs",
  "packages/daemon/src/tui/main.ts",
  "packages/daemon/src/tui/compiled.ts",
  "packages/daemon/src/lib/tui-binary.ts",
  "packages/daemon/src/tui/mirror/app.tsx",
  "packages/daemon/src/tui/mirror/runtime/application-root-v2.tsx",
]) {
  if (!files.has(required))
    throw new Error(`npm package is missing OpenTUI runtime file ${required}`);
}

const webAssets = [...files].filter((path) => path.startsWith("apps/desktop-renderer/dist/"));
if (webAssets.length > 0) {
  throw new Error(`OpenTUI npm package unexpectedly contains ${webAssets.length} Web GUI assets`);
}

const hostBinaries = [...files].filter((path) => /tmux-ide-tui(?:-|$)/u.test(path));
if (hostBinaries.length > 0) {
  throw new Error(`universal npm package leaked host TUI binaries: ${hostBinaries.join(", ")}`);
}

process.stdout.write(
  `[pack-tui-check] OpenTUI package contract (${report.files.length} files, ${report.size} bytes)\n`,
);
