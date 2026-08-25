import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildTestdriveExecCommand,
  resolveCard5HostFocusControlEnvironment,
  resolvePrivateTestdriveRuntimeEnvironment,
  resolvePublicTestdriveEnvironment,
  resolveTestdriveCapabilityEnvironment,
  resolveTestdriveLaunch,
} from "./tui-testdrive-launch.mjs";

const CARD5_ENVIRONMENT = {
  TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_CAPABILITY: "1",
  TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_PATH: "/private/hf.sock",
  TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_ROOT: "/private",
  TMUX_IDE_PERFORMANCE_TRACE_LOG: "/trace/performance.jsonl",
  TMUX_IDE_PERFORMANCE_TRACE_DETAIL: "1",
  TMUX_IDE_PERFORMANCE_TRACE_INPUT_FINGERPRINT_KEY: "1".repeat(64),
};

const PRIVATE_RUNTIME = {
  stateHome: "/private/state",
  canonicalHome: "/private/canonical",
  standaloneRegistryDir: "/private/registry",
  standaloneDaemonInfoDir: "/private/daemon",
  cleanupToken: "testdrive:cleanup:1234",
  tmuxSocketName: null,
  tmuxSocketPath: "/private/t.sock",
};

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
  assert.equal("TMUX_IDE_RUNTIME_MODE" in environment, false);
  assert.equal("TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_CAPABILITY" in environment, false);
  assert.throws(
    () =>
      resolvePublicTestdriveEnvironment({
        ...environment,
        TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON: "1",
      }),
    /cannot use a canonical-daemon/u,
  );
});

test("Card5 control forwarding is exact, inseparable, and confined to the private target root", () => {
  assert.deepEqual(resolveCard5HostFocusControlEnvironment(CARD5_ENVIRONMENT, "/private"), {
    TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_CAPABILITY: "1",
    TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_PATH: "/private/hf.sock",
    TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_ROOT: "/private",
    TMUX_IDE_PERFORMANCE_TRACE_INPUT_FINGERPRINT_KEY: "1".repeat(64),
  });
  assert.deepEqual(resolveCard5HostFocusControlEnvironment({}, "/private"), {});
  for (const changed of [
    { TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_PATH: undefined },
    { TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_ROOT: undefined },
    { TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_CAPABILITY: undefined },
    { TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_CAPABILITY: "0" },
    { TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_PATH: "/outside/hf.sock" },
    { TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_PATH: "/private/other.sock" },
    { TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_ROOT: "/outside" },
    { TMUX_IDE_PERFORMANCE_TRACE_DETAIL: "0" },
    { TMUX_IDE_PERFORMANCE_TRACE_INPUT_FINGERPRINT_KEY: "f" },
  ])
    assert.throws(
      () =>
        resolveCard5HostFocusControlEnvironment({ ...CARD5_ENVIRONMENT, ...changed }, "/private"),
      /environment was invalid/u,
    );
});

test("private canonical and standalone children receive one complete runtime namespace", () => {
  for (const canonicalDaemon of [false, true])
    for (const source of [false, true]) {
      const launch = resolveTestdriveLaunch({ ...base, publicEntry: false, source });
      assert.equal(launch.entry, source ? "source-app-target" : "compiled-app-target");
      assert.deepEqual(
        resolveTestdriveCapabilityEnvironment({
          publicEntry: false,
          canonicalDaemon,
          environment: CARD5_ENVIRONMENT,
          privateRoot: "/private",
          ...PRIVATE_RUNTIME,
        }),
        {
          TMUX_IDE_RUNTIME_MODE: "testdrive",
          TMUX_IDE_HOME: "/private/state",
          TMUX_IDE_REGISTRY_DIR: canonicalDaemon ? "/private/canonical" : "/private/registry",
          TMUX_IDE_DAEMON_INFO_DIR: canonicalDaemon ? "/private/canonical" : "/private/daemon",
          TMUX_IDE_CLEANUP_TOKEN: "testdrive:cleanup:1234",
          TMUX_IDE_TMUX_SOCKET_PATH: "/private/t.sock",
          ...resolveCard5HostFocusControlEnvironment(CARD5_ENVIRONMENT, "/private"),
        },
      );
    }
  const publicCapabilities = resolveTestdriveCapabilityEnvironment({
    publicEntry: true,
    canonicalDaemon: false,
    environment: CARD5_ENVIRONMENT,
    privateRoot: "/private",
  });
  assert.equal("TMUX_IDE_RUNTIME_MODE" in publicCapabilities, false);
  assert.equal("TMUX_IDE_HOME" in publicCapabilities, false);
  assert.equal("TMUX_IDE_CLEANUP_TOKEN" in publicCapabilities, false);
  assert.equal("TMUX_IDE_TMUX_SOCKET_PATH" in publicCapabilities, false);
  assert.equal("TMUX_IDE_TMUX_SOCKET_NAME" in publicCapabilities, false);
  assert.equal(publicCapabilities.TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_CAPABILITY, "1");
  assert.deepEqual(
    resolveTestdriveCapabilityEnvironment({
      publicEntry: true,
      canonicalDaemon: false,
      environment: {},
      privateRoot: "/private",
    }),
    {},
  );
});

test("private runtime namespace requires an exact token and one nondefault socket selector", () => {
  const directRuntime = {
    stateHome: PRIVATE_RUNTIME.stateHome,
    registryDir: PRIVATE_RUNTIME.standaloneRegistryDir,
    daemonInfoDir: PRIVATE_RUNTIME.standaloneDaemonInfoDir,
    cleanupToken: PRIVATE_RUNTIME.cleanupToken,
    tmuxSocketName: PRIVATE_RUNTIME.tmuxSocketName,
    tmuxSocketPath: PRIVATE_RUNTIME.tmuxSocketPath,
  };
  assert.deepEqual(resolvePrivateTestdriveRuntimeEnvironment(directRuntime), {
    TMUX_IDE_RUNTIME_MODE: "testdrive",
    TMUX_IDE_HOME: "/private/state",
    TMUX_IDE_REGISTRY_DIR: "/private/registry",
    TMUX_IDE_DAEMON_INFO_DIR: "/private/daemon",
    TMUX_IDE_CLEANUP_TOKEN: "testdrive:cleanup:1234",
    TMUX_IDE_TMUX_SOCKET_PATH: "/private/t.sock",
  });
  assert.deepEqual(
    resolvePrivateTestdriveRuntimeEnvironment({
      ...directRuntime,
      tmuxSocketPath: null,
      tmuxSocketName: "testdrive-private",
    }),
    {
      TMUX_IDE_RUNTIME_MODE: "testdrive",
      TMUX_IDE_HOME: "/private/state",
      TMUX_IDE_REGISTRY_DIR: "/private/registry",
      TMUX_IDE_DAEMON_INFO_DIR: "/private/daemon",
      TMUX_IDE_CLEANUP_TOKEN: "testdrive:cleanup:1234",
      TMUX_IDE_TMUX_SOCKET_NAME: "testdrive-private",
    },
  );
  for (const changed of [
    { stateHome: null },
    { stateHome: "relative" },
    { registryDir: null },
    { registryDir: "relative" },
    { daemonInfoDir: null },
    { daemonInfoDir: "relative" },
    { cleanupToken: null },
    { cleanupToken: "short" },
    { tmuxSocketPath: null, tmuxSocketName: null },
    { tmuxSocketName: "also-set" },
    { tmuxSocketPath: null, tmuxSocketName: "default" },
    { tmuxSocketPath: "relative", tmuxSocketName: null },
  ])
    assert.throws(
      () => resolvePrivateTestdriveRuntimeEnvironment({ ...directRuntime, ...changed }),
      /private testdrive runtime namespace was invalid/u,
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
