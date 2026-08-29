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
      "packages/daemon/src/tui/main.ts",
      "packages/daemon/src/tui/compiled.ts",
      "packages/daemon/src/tui/compiled.test.ts",
      "packages/daemon/src/tui/mirror/hosted.ts",
      "packages/daemon/src/tui/mirror/hosted.test.ts",
      "packages/daemon/src/tui/mirror/hosted-client-routing-live.test.ts",
      "packages/daemon/src/tui/mirror/hosted-host-death-live.test.ts",
      "packages/daemon/src/tui/mirror/hosted-reattach-live.test.ts",
      "packages/daemon/src/tui/mirror/input-lifecycle.ts",
      "packages/daemon/src/tui/mirror/input-lifecycle.test.ts",
      "packages/daemon/src/tui/mirror/runtime/application-lifecycle.ts",
      "packages/daemon/src/tui/mirror/runtime/application-lifecycle.test.ts",
      "packages/daemon/src/tui/mirror/runtime/host-local-tmux-adapter.ts",
      "packages/daemon/src/tui/mirror/runtime/host-local-tmux-adapter.test.ts",
      "packages/daemon/src/tui/mirror/runtime/hosted-tty-size-bridge.ts",
      "packages/daemon/src/tui/mirror/runtime/hosted-tty-size-bridge.test.ts",
      "packages/daemon/src/tui/mirror/runtime/production-data-path.test.ts",
      "packages/daemon/src/tui/mirror/runtime/terminal-dimensions-owner.ts",
      "scripts/opentui-release-check.mjs",
      "scripts/build-tui.mjs",
      "scripts/pack-check-run.mjs",
      "scripts/pack-tui-check.mjs",
      "scripts/prepublish-opentui-check.mjs",
      "scripts/lib/npm-release-tag.mjs",
      "scripts/lib/npm-release-tag.test.mjs",
      "scripts/lib/release-source-state.mjs",
      "scripts/lib/release-source-state.test.mjs",
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
      "packages/daemon/src/tui/main.ts",
      "packages/daemon/src/tui/compiled.ts",
      "packages/daemon/src/tui/compiled.test.ts",
      "packages/daemon/src/tui/mirror/hosted.ts",
      "packages/daemon/src/tui/mirror/hosted.test.ts",
      "packages/daemon/src/tui/mirror/hosted-client-routing-live.test.ts",
      "packages/daemon/src/tui/mirror/hosted-host-death-live.test.ts",
      "packages/daemon/src/tui/mirror/hosted-reattach-live.test.ts",
      "packages/daemon/src/tui/mirror/input-lifecycle.ts",
      "packages/daemon/src/tui/mirror/input-lifecycle.test.ts",
      "packages/daemon/src/tui/mirror/runtime/application-lifecycle.ts",
      "packages/daemon/src/tui/mirror/runtime/application-lifecycle.test.ts",
      "packages/daemon/src/tui/mirror/runtime/application-root.tsx",
      "packages/daemon/src/tui/mirror/runtime/application-root-v2.tsx",
      "packages/daemon/src/tui/mirror/runtime/host-local-tmux-adapter.ts",
      "packages/daemon/src/tui/mirror/runtime/host-local-tmux-adapter.test.ts",
      "packages/daemon/src/tui/mirror/runtime/hosted-tty-size-bridge.ts",
      "packages/daemon/src/tui/mirror/runtime/hosted-tty-size-bridge.test.ts",
      "packages/daemon/src/tui/mirror/runtime/production-data-path.test.ts",
      "packages/daemon/src/tui/mirror/runtime/terminal-dimensions-owner.ts",
      "packages/daemon/test-support/hosted-reattach-fixture.tsx",
      "scripts/opentui-release-check.mjs",
      "scripts/build-tui.mjs",
      "scripts/pack-check-run.mjs",
      "scripts/pack-tui-check.mjs",
      "scripts/prepublish-opentui-check.mjs",
      "scripts/lib/npm-release-tag.mjs",
      "scripts/lib/npm-release-tag.test.mjs",
      "scripts/lib/release-source-state.mjs",
      "scripts/lib/release-source-state.test.mjs",
      "scripts/lib/packed-opentui-frame.mjs",
      "scripts/lib/packed-opentui-frame.test.mjs",
    ],
  },
  {
    boundary: "OpenTUI journey predicate tests",
    command: "node",
    args: [
      "--test",
      "scripts/lib/packed-opentui-frame.test.mjs",
      "scripts/lib/release-source-state.test.mjs",
    ],
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
      "packages/daemon/src/tui/mirror/runtime/application-generation-starter.test.ts",
      "packages/daemon/src/tui/mirror/runtime/application-palette-command-owner.test.ts",
      "packages/daemon/src/tui/mirror/runtime/application-shell-binding.test.ts",
      "packages/daemon/src/tui/mirror/runtime/application-session-focus-owner.test.ts",
      "packages/daemon/src/tui/mirror/runtime/application-terminal-interaction-controller.test.ts",
    ],
  },
  {
    boundary: "OpenTUI hosted lifecycle unit tests",
    command: "pnpm",
    args: [
      "--filter",
      "@tmux-ide/daemon",
      "exec",
      "vitest",
      "run",
      "src/tui/mirror/hosted.test.ts",
      "src/tui/mirror/input-lifecycle.test.ts",
      "src/tui/mirror/runtime/application-lifecycle.test.ts",
      "src/tui/mirror/runtime/host-local-tmux-adapter.test.ts",
      "src/tui/mirror/runtime/hosted-tty-size-bridge.test.ts",
      "src/tui/mirror/runtime/production-data-path.test.ts",
    ],
  },
  {
    boundary: "OpenTUI hosted viewer lifecycle proofs",
    command: "pnpm",
    args: [
      "--filter",
      "@tmux-ide/daemon",
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.live.config.ts",
      "src/tui/mirror/hosted-client-routing-live.test.ts",
      "src/tui/mirror/hosted-host-death-live.test.ts",
      "src/tui/mirror/hosted-reattach-live.test.ts",
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
