import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildTestdriveExecCommand,
  resolvePublicTestdriveEnvironment,
  resolveTestdriveLaunch,
} from "./tui-testdrive-launch.mjs";

const base = {
  source: false,
  target: "fleet",
  cwd: "/private/configless",
  repoRoot: "/repo",
  nodeBinary: "/node",
  compiledTui: "/repo/tmux-ide-tui",
  sourceTui: "/repo/app.tsx",
  publicCli: "/repo/bin/cli.js",
};

test("public launch executes the user CLI with no positional arguments from the exact cwd", () => {
  assert.deepEqual(resolveTestdriveLaunch({ ...base, publicEntry: true, target: null }), {
    entry: "public-no-argument-cli",
    binary: "/node",
    binaryArgs: ["/repo/bin/cli.js"],
    cwd: "/private/configless",
    target: null,
  });
});

test("public launch rejects target/source aliases and an implicit cwd", () => {
  assert.throws(
    () => resolveTestdriveLaunch({ ...base, publicEntry: true }),
    /cannot be combined with --target/u,
  );
  assert.throws(
    () => resolveTestdriveLaunch({ ...base, publicEntry: true, target: null, source: true }),
    /cannot be combined with --source/u,
  );
  assert.throws(
    () => resolveTestdriveLaunch({ ...base, publicEntry: true, target: null, cwd: null }),
    /requires an explicit --cwd/u,
  );
});

test("public launcher preserves the exact audited ProductRig namespace", () => {
  const environment = resolvePublicTestdriveEnvironment({
    HOME: "/private/home",
    XDG_CONFIG_HOME: "/private/home/.config",
    TMUX_IDE_HOME: "/private/state",
    TMUX_IDE_CONFIG: "/private/state/config.json",
    TMUX_IDE_REGISTRY_DIR: "/private/registry",
    TMUX_IDE_SETTINGS_DIR: "/private/settings",
    TMUX_IDE_DAEMON_INFO_DIR: "/private/daemon",
    TMUX_IDE_TMUX_SOCKET_PATH: "/private/t.sock",
    PATH: "/usr/bin:/bin",
    TERM: "xterm-256color",
    TMUX_IDE_HOSTILE_FIXTURE: "must-not-survive",
  });
  assert.deepEqual(environment, {
    TMUX: "",
    HOME: "/private/home",
    XDG_CONFIG_HOME: "/private/home/.config",
    TMUX_IDE_HOME: "/private/state",
    TMUX_IDE_CONFIG: "/private/state/config.json",
    TMUX_IDE_REGISTRY_DIR: "/private/registry",
    TMUX_IDE_SETTINGS_DIR: "/private/settings",
    TMUX_IDE_DAEMON_INFO_DIR: "/private/daemon",
    TMUX_IDE_TMUX_SOCKET_PATH: "/private/t.sock",
    PATH: "/usr/bin:/bin",
    TERM: "xterm-256color",
  });
  assert.equal("TMUX_IDE_HOSTILE_FIXTURE" in environment, false);
  assert.throws(
    () =>
      resolvePublicTestdriveEnvironment({
        ...environment,
        TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON: "1",
      }),
    /cannot use a canonical-daemon/u,
  );
});

test("clean public exec quotes the raw environment exactly once", () => {
  const root = mkdtempSync(join(tmpdir(), "tmux-ide-public-env-"));
  try {
    const expected = String.raw`one ' quote and a \\ slash`;
    const command = buildTestdriveExecCommand({
      clean: true,
      environment: { EXACT_VALUE: expected },
      binary: "/usr/bin/env",
      binaryArgs: [],
      stderrPath: join(root, String.raw`stderr-'\-value.log`),
    });
    const result = spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: { HOSTILE_VALUE: "must-not-survive", PATH: process.env.PATH },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.split("\n").includes(`EXACT_VALUE=${expected}`));
    assert.doesNotMatch(result.stdout, /HOSTILE_VALUE/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("testdrive CLI rejects a public target before starting any host", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/tui-testdrive.mjs", "start", "--public-entry", "--target", "private"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--public-entry cannot be combined with --target/u);
});

test("targeted host launch preserves tmux injection while public clean env stays detached", () => {
  const source = readFileSync(new URL("../tui-testdrive.mjs", import.meta.url), "utf8");
  const environment = source.slice(
    source.indexOf("const environment = ["),
    source.indexOf(
      "const command = buildTestdriveExecCommand",
      source.indexOf("const environment = ["),
    ),
  );
  assert.doesNotMatch(environment, /!publicEnvironment[^\n]*\["TMUX="\]/u);
  assert.match(environment, /TMUX_IDE_TMUX_SOCKET_PATH/u);
  assert.equal(
    resolvePublicTestdriveEnvironment({
      HOME: "/private/home",
      XDG_CONFIG_HOME: "/private/home/.config",
      TMUX_IDE_HOME: "/private/state",
      TMUX_IDE_CONFIG: "/private/state/config.json",
      TMUX_IDE_REGISTRY_DIR: "/private/registry",
      TMUX_IDE_SETTINGS_DIR: "/private/settings",
      TMUX_IDE_DAEMON_INFO_DIR: "/private/daemon",
      TMUX_IDE_TMUX_SOCKET_PATH: "/private/target.sock",
    }).TMUX,
    "",
  );
});
