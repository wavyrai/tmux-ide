#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const checks = [
  {
    boundary: "OpenTUI release lint",
    command: "pnpm",
    args: [
      "exec",
      "eslint",
      "bin/cli.ts",
      "packages/daemon/src/tui/compiled.ts",
      "packages/daemon/src/tui/compiled.test.ts",
      "scripts/opentui-release-check.mjs",
      "scripts/pack-check-run.mjs",
      "scripts/pack-tui-check.mjs",
      "scripts/prepublish-opentui-check.mjs",
      "scripts/lib/npm-release-tag.mjs",
      "scripts/lib/npm-release-tag.test.mjs",
      "scripts/lib/packed-opentui-frame.mjs",
      "scripts/lib/packed-opentui-frame.test.mjs",
    ],
  },
  {
    boundary: "OpenTUI release formatting",
    command: "pnpm",
    args: [
      "exec",
      "prettier",
      "--check",
      ".github/workflows/release.yml",
      "package.json",
      "bin/cli.ts",
      "packages/daemon/src/tui/compiled.ts",
      "packages/daemon/src/tui/compiled.test.ts",
      "scripts/opentui-release-check.mjs",
      "scripts/pack-check-run.mjs",
      "scripts/pack-tui-check.mjs",
      "scripts/prepublish-opentui-check.mjs",
      "scripts/lib/npm-release-tag.mjs",
      "scripts/lib/npm-release-tag.test.mjs",
      "scripts/lib/packed-opentui-frame.mjs",
      "scripts/lib/packed-opentui-frame.test.mjs",
    ],
  },
  {
    boundary: "OpenTUI journey predicate tests",
    command: "node",
    args: ["--test", "scripts/lib/packed-opentui-frame.test.mjs"],
  },
  {
    boundary: "OpenTUI daemon typecheck",
    command: "pnpm",
    args: ["--filter", "@tmux-ide/daemon", "run", "typecheck"],
  },
  {
    boundary: "OpenTUI install/runtime unit tests",
    command: "pnpm",
    args: [
      "exec",
      "vitest",
      "run",
      "packages/daemon/src/tui/compiled.test.ts",
      "packages/daemon/src/lib/__tests__/tui-binary.test.ts",
    ],
  },
  {
    boundary: "OpenTUI app control unit tests",
    command: "pnpm",
    args: [
      "exec",
      "vitest",
      "run",
      "packages/daemon/src/tui/mirror/runtime/application-root-v2-input.test.ts",
      "packages/daemon/src/tui/mirror/runtime/application-shell-binding.test.ts",
      "packages/daemon/src/tui/mirror/runtime/application-session-focus-owner.test.ts",
      "packages/daemon/src/tui/mirror/runtime/application-terminal-interaction-controller.test.ts",
    ],
  },
  {
    boundary: "OpenTUI beta renderer tests",
    command: "bun",
    args: [
      "test",
      "--preload",
      "@opentui/solid/preload",
      "--preload",
      "./packages/daemon/test-support/opentui-renderer-preload.ts",
      "./packages/daemon/src/tui/mirror/runtime/application-terminal-workspace-renderer.test.tsx",
      "./packages/daemon/src/tui/mirror/runtime/application-shell-view-renderer.test.tsx",
    ],
  },
  {
    boundary: "OpenTUI canonical daemon election tests",
    command: "bun",
    args: ["test", "./packages/daemon/src/lib/canonical-daemon.test.ts"],
  },
  {
    boundary: "OpenTUI package contents",
    command: "pnpm",
    args: ["pack:check"],
  },
  {
    boundary: "OpenTUI installed-package journey",
    command: "pnpm",
    args: ["test:pack-installed"],
  },
];

for (const check of checks) {
  process.stdout.write(`\n[release:opentui] ${check.boundary}\n`);
  const result = spawnSync(check.command, check.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(`${check.boundary} could not start: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(
      `${check.boundary} failed (${result.signal ? `signal ${result.signal}` : `exit ${result.status}`})`,
    );
  }
}

process.stdout.write("\n[release:opentui] focused release gate passed\n");
