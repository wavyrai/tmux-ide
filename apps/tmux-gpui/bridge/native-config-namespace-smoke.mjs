// Compare Rust's local config projection against the actual TypeScript authority.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, chmod } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolveRuntimeNamespace } from "../../../packages/daemon/src/lib/runtime-namespace.ts";
import { resolveDevelopmentInstance } from "../../../packages/daemon/src/lib/development-instance.ts";
import { stopFixtureChild } from "./fixture-child.mjs";
import { createServer } from "node:net";
let child, socket;
const [binary] = process.argv.slice(2);
assert(
  binary && isAbsolute(binary),
  "Usage: node --import tsx native-config-namespace-smoke.mjs ABS_CLIENT_TEST_BINARY",
);
const root = await realpath(await mkdtemp("/tmp/ncfg-"));
try {
  const home = join(root, "home"),
    cwd = root,
    worktree = join(root, "worktree");
  await mkdir(home, { mode: 0o700 });
  await mkdir(worktree, { mode: 0o700 });
  await mkdir(join(home, ".tmux-ide"), { mode: 0o700 });
  const cases = [];
  const add = (name, env) => {
    let expected = null;
    try {
      const p = resolveRuntimeNamespace({ env, userHome: home, cwd }).configPath;
      if (p) expected = resolve(cwd, p);
    } catch {
      /* Invalid namespaces must grant no config path. */
    }
    cases.push({ name, env, home, cwd, expected });
  };
  add("production default", {});
  add("production explicit mode", { TMUX_IDE_RUNTIME_MODE: "production" });
  add("production alternate state keeps canonical config", {
    TMUX_IDE_HOME: join(root, "alternate"),
  });
  add("relative explicit config", { TMUX_IDE_CONFIG: "a/../custom.json" });
  add("empty explicit config", { TMUX_IDE_CONFIG: "" });
  add("invalid mode with explicit config", {
    TMUX_IDE_RUNTIME_MODE: "invalid",
    TMUX_IDE_CONFIG: join(root, "explicit.json"),
  });
  const isolated = {
    TMUX_IDE_RUNTIME_MODE: "test",
    TMUX_IDE_HOME: join(root, "state"),
    TMUX_IDE_TMUX_SOCKET_NAME: "owned-parity",
    TMUX_IDE_CLEANUP_TOKEN: "owned-parity-token",
  };
  for (const mode of ["test", "smoke", "testdrive", "performance"])
    add(`isolated ${mode}`, { ...isolated, TMUX_IDE_RUNTIME_MODE: mode });
  for (const [key, value] of [
    ["TMUX_IDE_HOME", ""],
    ["TMUX_IDE_HOME", join(home, ".tmux-ide")],
    ["TMUX_IDE_REGISTRY_DIR", join(home, ".tmux-ide/registry")],
    ["TMUX_IDE_DAEMON_INFO_DIR", join(home, ".tmux-ide/daemon")],
    ["TMUX_IDE_TMUX_SOCKET_NAME", "default"],
    ["TMUX_IDE_TMUX_SOCKET_NAME", "bad/name"],
    ["TMUX_IDE_TMUX_SOCKET_PATH", join(root, "socket")],
    ["TMUX_IDE_CLEANUP_TOKEN", "short"],
    ["TMUX_IDE_CLEANUP_TOKEN", ""],
    ["TMUX_IDE_CLEANUP_TOKEN", "bad token"],
    ["TMUX_IDE_CONFIG", "relative.json"],
    ["TMUX_IDE_HOME", "relative-state"],
    ["TMUX_IDE_REGISTRY_DIR", ""],
    ["TMUX_IDE_DAEMON_INFO_DIR", ""],
  ])
    add(`isolated ${key} ${value}`, { ...isolated, [key]: value });
  await symlink(join(home, ".tmux-ide"), join(root, "canonical-alias"));
  add("canonical state alias", {
    ...isolated,
    TMUX_IDE_HOME: join(root, "canonical-alias/future"),
  });
  add("socket canonical alias", {
    ...isolated,
    TMUX_IDE_TMUX_SOCKET_NAME: "",
    TMUX_IDE_TMUX_SOCKET_PATH: join(root, "canonical-alias/tmux.sock"),
  });
  const socketDir = join(root, "socket-dir");
  await mkdir(socketDir, { mode: 0o700 });
  socket = createServer();
  socket.listen(join(socketDir, "owned.sock"));
  await once(socket, "listening");
  add("actual socket", {
    ...isolated,
    TMUX_IDE_TMUX_SOCKET_NAME: "",
    TMUX_IDE_TMUX_SOCKET_PATH: join(socketDir, "owned.sock"),
  });
  await symlink(socketDir, join(root, "socket-alias"));
  add("actual socket with symlink parent", {
    ...isolated,
    TMUX_IDE_TMUX_SOCKET_NAME: "",
    TMUX_IDE_TMUX_SOCKET_PATH: join(root, "socket-alias/owned.sock"),
  });
  const dev = resolveDevelopmentInstance({
    worktree,
    name: "native-parity",
    store: join(root, "store"),
    userHome: home,
  });
  const development = {
    TMUX_IDE_RUNTIME_MODE: "development",
    TMUX_IDE_DEVELOPMENT_WORKTREE: worktree,
    TMUX_IDE_DEVELOPMENT_STORE: dev.store,
    TMUX_IDE_DEVELOPMENT_NAME: dev.name,
    TMUX_IDE_DEVELOPMENT_ID: dev.id,
    TMUX_IDE_RUNTIME_DIR: dev.runtimeDir,
    TMUX_IDE_HOME: dev.stateHome,
    TMUX_IDE_REGISTRY_DIR: dev.stateHome,
    TMUX_IDE_DAEMON_INFO_DIR: dev.stateHome,
    TMUX_IDE_TMUX_SOCKET_PATH: join(dev.runtimeDir, "tmux.sock"),
    TMUX_IDE_CLEANUP_TOKEN: "owned-parity-dev",
  };
  add("valid development default", development);
  assert(cases.at(-1).expected, "owned development fixture must be valid");
  for (const [key, value] of [
    ["TMUX_IDE_DEVELOPMENT_ID", "dev-wrong"],
    ["TMUX_IDE_RUNTIME_DIR", join(root, "other-runtime")],
    ["TMUX_IDE_HOME", join(root, "other-state")],
    ["TMUX_IDE_DEVELOPMENT_NAME", "bad/name"],
    ["TMUX_IDE_REGISTRY_DIR", ""],
    ["TMUX_IDE_TMUX_SOCKET_PATH", join(root, "other.sock")],
    ["TMUX_IDE_CONFIG", join(dev.root, "settings/theme.json")],
    ["TMUX_IDE_CONFIG", join(home, "escape.json")],
    ["TMUX_IDE_CONFIG", "relative.json"],
    ["TMUX_IDE_SETTINGS_DIR", ""],
    ["TMUX_IDE_CLAUDE_DIR", home],
    ["TMUX_IDE_OPENCODE_DIR", home],
    ["TMUX_IDE_TUI_LOG", home],
    ["TMUX_IDE_TESTDRIVE_LEAK", "yes"],
    ["TMUX", `${join(dev.runtimeDir, "tmux.sock")},1,2`],
    ["TMUX", `${join(root, "foreign.sock")},1,2`],
    ["TMUX", "malformed"],
  ])
    add(`development ${key} ${value}`, { ...development, [key]: value });
  await mkdir(dev.store, { mode: 0o700 });
  await mkdir(dev.root, { recursive: true, mode: 0o700 });
  await symlink(home, join(dev.root, "escape"));
  add("development config symlink escape", {
    ...development,
    TMUX_IDE_CONFIG: join(dev.root, "escape/theme.json"),
  });
  // State changes before Rust runs must not invalidate earlier expected cases.
  // Use a different store for the permission-negative descriptor.
  const unsafeStore = join(root, "unsafe-store");
  await mkdir(unsafeStore, { mode: 0o755 });
  await chmod(unsafeStore, 0o755);
  add("development public store", { ...development, TMUX_IDE_DEVELOPMENT_STORE: unsafeStore });
  const path = join(root, "cases.json");
  await writeFile(path, JSON.stringify(cases));
  child = spawn(
    binary,
    ["--ignored", "--test-threads=1", "native_config_namespace_matches_typescript_reference"],
    {
      env: {
        ...process.env,
        TMUX_IDE_NAMESPACE_PARITY: "owned-fixtures",
        TMUX_IDE_NAMESPACE_CASES: path,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-16384);
    });
  const [code, signal] = await once(child, "close", { signal: AbortSignal.timeout(30000) });
  assert.equal(signal, null);
  assert.equal(code, 0, output);
  assert.match(output, /1 passed/);
  console.log(
    JSON.stringify({
      passed: true,
      cases: cases.length,
      valid: cases.filter((c) => c.expected).length,
      invalid: cases.filter((c) => !c.expected).length,
      realTypeScriptAuthority: true,
    }),
  );
} finally {
  try {
    await stopFixtureChild(child);
  } finally {
    if (socket?.listening) await new Promise((resolve) => socket.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
