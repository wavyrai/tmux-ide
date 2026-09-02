import { resolve } from "node:path";

const CARD5_KEY = /^[0-9a-f]{64}$/u;
const CLEANUP_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u;
const SOCKET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;

export function resolveCard5HostFocusControlEnvironment(environment, privateRoot) {
  const capability = environment.TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_CAPABILITY?.trim();
  const path = environment.TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_PATH?.trim();
  const root = environment.TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_ROOT?.trim();
  const supplied = [capability, path, root].filter(Boolean).length;
  if (supplied === 0) return Object.freeze({});
  if (
    supplied !== 3 ||
    capability !== "1" ||
    environment.TMUX_IDE_PERFORMANCE_TRACE_DETAIL !== "1" ||
    !environment.TMUX_IDE_PERFORMANCE_TRACE_LOG ||
    !CARD5_KEY.test(environment.TMUX_IDE_PERFORMANCE_TRACE_INPUT_FINGERPRINT_KEY ?? "") ||
    typeof privateRoot !== "string" ||
    !privateRoot.startsWith("/") ||
    root !== resolve(root) ||
    path !== resolve(path) ||
    root !== resolve(privateRoot) ||
    path !== resolve(root, "hf.sock")
  )
    throw new Error("Card5 host-focus control environment was invalid");
  return Object.freeze({
    TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_CAPABILITY: "1",
    TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_PATH: path,
    TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_ROOT: root,
    TMUX_IDE_PERFORMANCE_TRACE_INPUT_FINGERPRINT_KEY:
      environment.TMUX_IDE_PERFORMANCE_TRACE_INPUT_FINGERPRINT_KEY,
  });
}

export function resolveTestdriveCapabilityEnvironment({
  publicEntry,
  canonicalDaemon,
  environment,
  privateRoot,
  stateHome,
  canonicalHome,
  standaloneRegistryDir,
  standaloneDaemonInfoDir,
  cleanupToken,
  tmuxSocketName,
  tmuxSocketPath,
}) {
  if (typeof publicEntry !== "boolean" || typeof canonicalDaemon !== "boolean")
    throw new Error("testdrive child capability mode was invalid");
  const privateNamespace = publicEntry
    ? {}
    : resolvePrivateTestdriveRuntimeEnvironment({
        stateHome,
        registryDir: canonicalDaemon ? canonicalHome : standaloneRegistryDir,
        daemonInfoDir: canonicalDaemon ? canonicalHome : standaloneDaemonInfoDir,
        cleanupToken,
        tmuxSocketName,
        tmuxSocketPath,
      });
  return Object.freeze({
    ...privateNamespace,
    ...resolveCard5HostFocusControlEnvironment(environment, privateRoot),
  });
}

export function resolvePrivateTestdriveRuntimeEnvironment({
  stateHome,
  registryDir,
  daemonInfoDir,
  cleanupToken,
  tmuxSocketName,
  tmuxSocketPath,
}) {
  const home = typeof stateHome === "string" ? stateHome.trim() : "";
  const registry = typeof registryDir === "string" ? registryDir.trim() : "";
  const daemonInfo = typeof daemonInfoDir === "string" ? daemonInfoDir.trim() : "";
  const token = typeof cleanupToken === "string" ? cleanupToken.trim() : "";
  const socketName = typeof tmuxSocketName === "string" ? tmuxSocketName.trim() : "";
  const socketPath = typeof tmuxSocketPath === "string" ? tmuxSocketPath.trim() : "";
  if (
    !home ||
    home !== resolve(home) ||
    !registry ||
    registry !== resolve(registry) ||
    !daemonInfo ||
    daemonInfo !== resolve(daemonInfo) ||
    !CLEANUP_TOKEN.test(token) ||
    Boolean(socketName) === Boolean(socketPath) ||
    (socketName && (socketName === "default" || !SOCKET_NAME.test(socketName))) ||
    (socketPath && socketPath !== resolve(socketPath))
  )
    throw new Error("private testdrive runtime namespace was invalid");
  return Object.freeze({
    TMUX_IDE_RUNTIME_MODE: "testdrive",
    TMUX_IDE_HOME: home,
    TMUX_IDE_REGISTRY_DIR: registry,
    TMUX_IDE_DAEMON_INFO_DIR: daemonInfo,
    TMUX_IDE_CLEANUP_TOKEN: token,
    ...(socketPath
      ? { TMUX_IDE_TMUX_SOCKET_PATH: socketPath }
      : { TMUX_IDE_TMUX_SOCKET_NAME: socketName }),
  });
}

const PUBLIC_NAMESPACE_KEYS = Object.freeze([
  "HOME",
  "XDG_CONFIG_HOME",
  "TMUX_IDE_HOME",
  "TMUX_IDE_CONFIG",
  "TMUX_IDE_REGISTRY_DIR",
  "TMUX_IDE_SETTINGS_DIR",
  "TMUX_IDE_DAEMON_INFO_DIR",
  "TMUX_IDE_TMUX_SOCKET_PATH",
]);

export function resolvePublicTestdriveEnvironment(environment) {
  if (
    environment.TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON ||
    environment.TMUX_IDE_TESTDRIVE_CANONICAL_HOME
  )
    throw new Error("public entry cannot use a canonical-daemon testdrive override");
  const resolved = { TMUX: "" };
  for (const key of ["PATH", "TERM", "LANG", "LC_ALL", "TMPDIR"]) {
    const value = environment[key]?.trim();
    if (value) resolved[key] = value;
  }
  for (const key of PUBLIC_NAMESPACE_KEYS) {
    const value = environment[key]?.trim();
    if (!value) throw new Error(`public entry requires exact ${key}`);
    resolved[key] = value;
  }
  return Object.freeze(resolved);
}

export function resolveTestdriveLaunch({
  publicEntry,
  source,
  target,
  cwd,
  repoRoot,
  nodeBinary,
  compiledTui,
  sourceTui,
  publicCli,
}) {
  if (publicEntry) {
    if (source) throw new Error("--public-entry cannot be combined with --source");
    if (target) throw new Error("--public-entry cannot be combined with --target");
    if (!cwd) throw new Error("--public-entry requires an explicit --cwd");
    return Object.freeze({
      entry: "public-no-argument-cli",
      binary: nodeBinary,
      binaryArgs: Object.freeze([publicCli]),
      cwd: resolve(cwd),
      target: null,
    });
  }
  if (!target) throw new Error("test-drive app launch requires one target session");
  return Object.freeze({
    entry: source ? "source-app-target" : "compiled-app-target",
    binary: source ? "bun" : compiledTui,
    binaryArgs: Object.freeze(
      source ? [sourceTui, `--target=${target}`] : ["app", `--target=${target}`],
    ),
    cwd: source ? repoRoot : cwd,
    target,
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function buildTestdriveExecCommand({ clean, environment, binary, binaryArgs, stderrPath }) {
  const assignments = Object.entries(environment).map(
    ([key, value]) => `${key}=${shellQuote(value)}`,
  );
  return `exec ${clean ? `env -i ${assignments.join(" ")} ` : ""}${shellQuote(binary)} ${binaryArgs.map(shellQuote).join(" ")} 2>>${shellQuote(stderrPath)}`;
}
