import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capturePackedInstallEnvironment,
  privatePackedInstallEnvironment,
} from "./packed-install-environment.mjs";

test("ambient namespace, package manager and loader overrides cannot escape the private install", () => {
  const dangerous = [
    "ZDOTDIR",
    "ENV",
    "BASH_ENV",
    "TMUX_IDE_HOME",
    "TMUX_IDE_DAEMON_INFO_DIR",
    "TMUX_IDE_REGISTRY_DIR",
    "TMUX_IDE_SETTINGS_DIR",
    "TMUX_IDE_RUNTIME_MODE",
    "TMUX_IDE_CLAUDE_SETTINGS",
    "TMUX_IDE_PACK_FETCH_MODE",
    "TMUX_IDE_PACK_EVIDENCE_DIR",
    "TMUX",
    "TMUX_PANE",
    "TMUX_TMPDIR",
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "NODE_OPTIONS",
    "NODE_PATH",
    "BUN_OPTIONS",
    "BUN_INSTALL",
    "npm_config_global",
    "NPM_CONFIG_USERCONFIG",
    "NpM_cOnFiG_pReFiX",
    "npm_config_script_shell",
  ];
  const input = {
    ...Object.fromEntries(dangerous.map((key) => [key, "/foreign"])),
    PATH: "/pinned/bin",
    LANG: "C.UTF-8",
  };
  const base = capturePackedInstallEnvironment(input);
  assert.deepEqual(base, { PATH: "/pinned/bin", LANG: "C.UTF-8" });
  const child = privatePackedInstallEnvironment(base, {
    home: "/private/fixture/home",
    cache: "/private/fixture/cache",
  });
  assert.equal(child.ZDOTDIR, "/private/fixture/home");
  assert.equal(child.ENV, undefined);
  assert.equal(child.BASH_ENV, undefined);
  assert.equal(child.HOME, "/private/fixture/home");
  assert.equal(child.npm_config_prefix, "/private/fixture/home/npm-prefix");
  assert.equal(child.npm_config_global, "false");
  assert.equal(child.npm_config_userconfig, "/private/fixture/home/.npmrc");
  assert.equal(child.NODE_OPTIONS, undefined);
  assert.equal(child.TMUX_IDE_DAEMON_INFO_DIR, undefined);
  assert.equal(input.HOME, "/foreign");
});

test("explicit per-child fetch and namespace selectors survive after ambient capture", () => {
  const base = capturePackedInstallEnvironment({
    TMUX_IDE_TUI_BIN: "/foreign",
    NODE_OPTIONS: "--require=/foreign",
    PATH: "/pinned/bin",
  });
  const selected = {
    TMUX_IDE_HOME: "/private/fixture/state",
    TMUX_IDE_TMUX_SOCKET_PATH: "/private/fixture/tmux.sock",
    NODE_OPTIONS: "--import=/private/fixture/fetch.mjs",
    TMUX_IDE_PACK_FETCH_MODE: "offline",
  };
  const child = privatePackedInstallEnvironment(base, {
    home: "/private/fixture/home",
    cache: "/private/fixture/cache",
    overrides: selected,
  });
  for (const [key, value] of Object.entries(selected)) assert.equal(child[key], value);
  assert.equal(child.TMUX_IDE_TUI_BIN, undefined);
  assert.equal(base.NODE_OPTIONS, undefined);
});

test("separate install lanes do not share HOME, manager cache/config or state selectors", () => {
  const base = capturePackedInstallEnvironment({ PATH: "/pinned/bin" });
  const a = privatePackedInstallEnvironment(base, {
    home: "/fixture/a",
    cache: "/fixture/cache-a",
    overrides: { TMUX_IDE_HOME: "/fixture/a/state" },
  });
  const b = privatePackedInstallEnvironment(base, {
    home: "/fixture/b",
    cache: "/fixture/cache-b",
    overrides: { TMUX_IDE_HOME: "/fixture/b/state" },
  });
  for (const key of [
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "npm_config_cache",
    "npm_config_userconfig",
    "npm_config_prefix",
    "TMUX_IDE_HOME",
  ])
    assert.notEqual(a[key], b[key]);
  assert.throws(
    () => privatePackedInstallEnvironment(base, { home: "relative", cache: "/fixture/cache" }),
    /absolute/,
  );
});
