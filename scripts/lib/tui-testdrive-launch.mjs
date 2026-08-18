import { resolve } from "node:path";

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
