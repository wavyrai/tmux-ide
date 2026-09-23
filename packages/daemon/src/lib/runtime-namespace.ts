/**
 * One authority bundle for every piece of process-local tmux-ide state.
 *
 * Production intentionally defaults to the user's canonical state and tmux
 * server. Tests, smoke runs and performance fixtures must opt into an
 * isolated namespace. Keeping the guard here makes accidental canonical I/O
 * impossible even when a new harness forgets one of the legacy env vars.
 */
import { homedir } from "node:os";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveDevelopmentInstance, type DevelopmentInstance } from "./development-instance.ts";
import { captureUnixSocketIdentity } from "./unix-socket-authority.ts";

export const RUNTIME_MODE_ENV = "TMUX_IDE_RUNTIME_MODE";
export const STATE_HOME_ENV = "TMUX_IDE_HOME";
export const REGISTRY_DIR_ENV = "TMUX_IDE_REGISTRY_DIR";
export const DAEMON_INFO_DIR_ENV = "TMUX_IDE_DAEMON_INFO_DIR";
export const TMUX_SOCKET_NAME_ENV = "TMUX_IDE_TMUX_SOCKET_NAME";
export const TMUX_SOCKET_PATH_ENV = "TMUX_IDE_TMUX_SOCKET_PATH";
export const CLEANUP_TOKEN_ENV = "TMUX_IDE_CLEANUP_TOKEN";

export type RuntimeMode =
  | "production"
  | "development"
  | "test"
  | "smoke"
  | "testdrive"
  | "performance";

export interface RuntimeNamespace {
  readonly mode: RuntimeMode;
  readonly development: DevelopmentInstance | null;
  readonly runtimeDir: string;
  readonly configPath: string;
  readonly settingsDir: string;
  readonly logsDir: string;
  readonly claudeDir: string;
  readonly claudeSettingsPath: string;
  readonly claudeHookPath: string;
  readonly opencodeDir: string;
  readonly stateHome: string;
  readonly registryDir: string;
  readonly daemonInfoDir: string;
  readonly controlSocketPath: string;
  readonly eventLogPath: string;
  readonly tmuxSocketExplicit?: boolean;
  readonly tmuxSocket:
    | { readonly kind: "name"; readonly name: string }
    | { readonly kind: "path"; readonly path: string };
  readonly cleanupToken: string | null;
  readonly namespaceId: string;
  readonly persistence: "durable" | "ephemeral";
  readonly isolated: boolean;
}

export interface RuntimeNamespaceResolutionOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly userHome?: string;
  readonly cwd?: string;
}

const ISOLATED_MODES = new Set<RuntimeMode>([
  "development",
  "test",
  "smoke",
  "testdrive",
  "performance",
]);
const SAFE_SOCKET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const SAFE_CLEANUP_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u;

function nonEmpty(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function absolutePath(value: string, cwd: string, key: string): string {
  const path = isAbsolute(value) ? value : resolve(cwd, value);
  if (!isAbsolute(path)) throw new TypeError(`${key} must resolve to an absolute path`);
  return path;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function pathIdentity(path: string): string {
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (!pathEntryExists(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  if (pathEntryExists(cursor) && lstatSync(cursor).isSocket()) {
    return resolve(captureUnixSocketIdentity(cursor).path, ...suffix);
  }
  return resolve(pathEntryExists(cursor) ? realpathSync(cursor) : cursor, ...suffix);
}

function isInsideOrEqual(path: string, parent: string): boolean {
  const child = pathIdentity(path);
  const root = pathIdentity(parent);
  const offset = relative(root, child);
  return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== "..");
}

function runtimeMode(env: NodeJS.ProcessEnv): RuntimeMode {
  const raw = nonEmpty(env, RUNTIME_MODE_ENV) ?? "production";
  if (!["production", "development", "test", "smoke", "testdrive", "performance"].includes(raw)) {
    throw new TypeError(`${RUNTIME_MODE_ENV} has an unsupported value`);
  }
  return raw as RuntimeMode;
}

export function resolveRuntimeNamespace(
  options: RuntimeNamespaceResolutionOptions = {},
): RuntimeNamespace {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const mode = runtimeMode(env);
  const isolated = ISOLATED_MODES.has(mode);
  const canonicalHome = join(userHome, ".tmux-ide");
  const configuredHome = nonEmpty(env, STATE_HOME_ENV);
  let development: DevelopmentInstance | null = null;
  if (mode === "development") {
    if (
      !env.TMUX_IDE_DEVELOPMENT_WORKTREE ||
      !env.TMUX_IDE_DEVELOPMENT_STORE ||
      !env.TMUX_IDE_DEVELOPMENT_ID ||
      !env.TMUX_IDE_RUNTIME_DIR
    )
      throw new TypeError("development requires a complete identity/runtime descriptor");
    development = resolveDevelopmentInstance({
      worktree: env.TMUX_IDE_DEVELOPMENT_WORKTREE,
      name: env.TMUX_IDE_DEVELOPMENT_NAME ?? "",
      store: env.TMUX_IDE_DEVELOPMENT_STORE,
      userHome,
    });
    if (
      development.id !== env.TMUX_IDE_DEVELOPMENT_ID ||
      env.TMUX_IDE_RUNTIME_DIR !== development.runtimeDir
    )
      throw new TypeError("development identity/runtime mismatch");
    if (configuredHome !== development.stateHome)
      throw new TypeError("development state home mismatch");
    for (const key of [REGISTRY_DIR_ENV, DAEMON_INFO_DIR_ENV])
      if (env[key] !== development.stateHome)
        throw new TypeError(`development requires exact ${key}`);
    if (
      env[TMUX_SOCKET_PATH_ENV] !== join(development.runtimeDir, "tmux.sock") ||
      nonEmpty(env, TMUX_SOCKET_NAME_ENV)
    )
      throw new TypeError("development requires its exact private tmux socket");
    for (const key of Object.keys(env)) {
      if (!env[key]) continue;
      if (/^TMUX_IDE_(TESTDRIVE|CARD5|PERFORMANCE)_/.test(key))
        throw new TypeError(`development rejects inherited ${key}`);
    }
  }

  if (isolated && !configuredHome) {
    throw new TypeError(`${mode} runtime requires an explicit ${STATE_HOME_ENV}`);
  }

  const stateHome = absolutePath(configuredHome ?? canonicalHome, cwd, STATE_HOME_ENV);
  const registryDir = absolutePath(
    nonEmpty(env, REGISTRY_DIR_ENV) ?? stateHome,
    cwd,
    REGISTRY_DIR_ENV,
  );
  const daemonInfoDir = absolutePath(
    // Preserve the long-standing registry override as the compatibility
    // authority for daemon publication when no dedicated directory is set.
    // This also keeps an explicitly empty DAEMON_INFO_DIR equivalent to
    // "unset" instead of silently escaping a caller's isolated registry.
    nonEmpty(env, DAEMON_INFO_DIR_ENV) ?? registryDir,
    cwd,
    DAEMON_INFO_DIR_ENV,
  );
  const tmuxSocketName = nonEmpty(env, TMUX_SOCKET_NAME_ENV);
  const tmuxSocketPath = nonEmpty(env, TMUX_SOCKET_PATH_ENV);
  const cleanupToken = nonEmpty(env, CLEANUP_TOKEN_ENV) ?? null;

  if (tmuxSocketName && tmuxSocketPath) {
    throw new TypeError(
      `configure only one of ${TMUX_SOCKET_NAME_ENV} and ${TMUX_SOCKET_PATH_ENV}`,
    );
  }
  if (tmuxSocketName && !SAFE_SOCKET_NAME.test(tmuxSocketName)) {
    throw new TypeError(`${TMUX_SOCKET_NAME_ENV} is invalid`);
  }
  const tmuxSocket = tmuxSocketPath
    ? ({ kind: "path", path: absolutePath(tmuxSocketPath, cwd, TMUX_SOCKET_PATH_ENV) } as const)
    : ({ kind: "name", name: tmuxSocketName ?? "default" } as const);
  if (isolated && tmuxSocket.kind === "name" && tmuxSocket.name === "default") {
    throw new TypeError(`${mode} runtime requires a non-default ${TMUX_SOCKET_NAME_ENV}`);
  }
  if (isolated && isInsideOrEqual(stateHome, canonicalHome)) {
    throw new TypeError(`${mode} runtime cannot use the canonical tmux-ide state home`);
  }
  if (
    isolated &&
    (isInsideOrEqual(registryDir, canonicalHome) || isInsideOrEqual(daemonInfoDir, canonicalHome))
  ) {
    throw new TypeError(`${mode} runtime cannot use canonical registry or daemon state`);
  }
  if (isolated && tmuxSocket.kind === "path" && isInsideOrEqual(tmuxSocket.path, canonicalHome)) {
    throw new TypeError(`${mode} runtime cannot use a tmux socket inside canonical state`);
  }
  if (isolated && cleanupToken === null) {
    throw new TypeError(`${mode} runtime requires an explicit ${CLEANUP_TOKEN_ENV}`);
  }
  if (cleanupToken !== null && !SAFE_CLEANUP_TOKEN.test(cleanupToken)) {
    throw new TypeError(`${CLEANUP_TOKEN_ENV} is invalid`);
  }

  const scoped = (key: string, fallback: string): string => {
    const value =
      (key === "TMUX_IDE_CONFIG" || key === "TMUX_IDE_SETTINGS_DIR"
        ? env[key]
        : nonEmpty(env, key)) ?? fallback;
    if (development && (!isAbsolute(value) || !isInsideOrEqual(value, development.root)))
      throw new TypeError(`development ${key} escapes instance`);
    return value;
  };
  const runtimeDir = development?.runtimeDir ?? stateHome;
  const configPath = scoped(
    "TMUX_IDE_CONFIG",
    join(isolated ? stateHome : canonicalHome, "config.json"),
  );
  const settingsDir = scoped("TMUX_IDE_SETTINGS_DIR", isolated ? stateHome : canonicalHome);
  const integrationRoot = development ? join(stateHome, "integrations") : userHome;
  const claudeDir = scoped("TMUX_IDE_CLAUDE_DIR", join(integrationRoot, ".claude"));
  const claudeSettingsPath = scoped("TMUX_IDE_CLAUDE_SETTINGS", join(claudeDir, "settings.json"));
  const claudeHookPath = scoped(
    "TMUX_IDE_CLAUDE_HOOK_PATH",
    development
      ? join(stateHome, "hooks", "claude-state.sh")
      : join(userHome, ".tmux-ide", "hooks", "claude-state.sh"),
  );
  const opencodeDir = scoped(
    "TMUX_IDE_OPENCODE_DIR",
    development
      ? join(integrationRoot, "opencode", "plugin")
      : join(nonEmpty(env, "XDG_CONFIG_HOME") ?? join(userHome, ".config"), "opencode", "plugin"),
  );
  if (development) {
    for (const key of [
      "TMUX_IDE_TUI_LOG",
      "TMUX_IDE_TUI_PERF_LOG",
      "TMUX_IDE_SESSION_RUNTIME_TRACE_LOG",
      "TMUX_IDE_TEMPLATES_DIR",
      "TMUX_IDE_CODEX_SESSIONS",
      "TMUX_IDE_CURSOR_CHATS",
      "TMUX_IDE_HOME_OVERRIDE",
    ])
      if (nonEmpty(env, key)) scoped(key, "");
    if (env.TMUX) {
      const socket = /^(.*),[0-9]+,[0-9]+$/u.exec(env.TMUX)?.[1];
      if (!socket || pathIdentity(socket) !== pathIdentity(join(runtimeDir, "tmux.sock")))
        throw new TypeError("development rejects inherited foreign TMUX authority");
    }
  }
  return Object.freeze({
    mode,
    development,
    runtimeDir,
    configPath,
    settingsDir,
    logsDir: development ? join(development.root, "logs") : join(stateHome, "logs"),
    claudeDir,
    claudeSettingsPath,
    claudeHookPath,
    opencodeDir,
    stateHome,
    registryDir,
    daemonInfoDir,
    controlSocketPath: join(runtimeDir, "control.sock"),
    eventLogPath: join(stateHome, "events.jsonl"),
    tmuxSocket,
    tmuxSocketExplicit: Boolean(tmuxSocketName || tmuxSocketPath),
    cleanupToken,
    namespaceId: development?.id ?? (isolated ? cleanupToken! : "canonical"),
    persistence: isolated && !development ? "ephemeral" : "durable",
    isolated,
  });
}

export function runtimeNamespaceEnvironment(
  namespace: RuntimeNamespace,
): Readonly<Record<string, string>> {
  return Object.freeze({
    [RUNTIME_MODE_ENV]: namespace.mode,
    ...(namespace.development
      ? {
          TMUX_IDE_DEVELOPMENT_WORKTREE: namespace.development.worktree,
          TMUX_IDE_DEVELOPMENT_NAME: namespace.development.name,
          TMUX_IDE_DEVELOPMENT_STORE: namespace.development.store,
          TMUX_IDE_DEVELOPMENT_ID: namespace.development.id,
          TMUX_IDE_RUNTIME_DIR: namespace.runtimeDir,
          TMUX_IDE_CONFIG: namespace.configPath,
          TMUX_IDE_SETTINGS_DIR: namespace.settingsDir,
          TMUX_IDE_CLAUDE_DIR: namespace.claudeDir,
          TMUX_IDE_CLAUDE_SETTINGS: namespace.claudeSettingsPath,
          TMUX_IDE_OPENCODE_DIR: namespace.opencodeDir,
        }
      : {}),
    [STATE_HOME_ENV]: namespace.stateHome,
    [REGISTRY_DIR_ENV]: namespace.registryDir,
    [DAEMON_INFO_DIR_ENV]: namespace.daemonInfoDir,
    ...(namespace.tmuxSocketExplicit === false
      ? {}
      : namespace.tmuxSocket.kind === "name"
        ? { [TMUX_SOCKET_NAME_ENV]: namespace.tmuxSocket.name }
        : { [TMUX_SOCKET_PATH_ENV]: namespace.tmuxSocket.path }),
    ...(namespace.cleanupToken ? { [CLEANUP_TOKEN_ENV]: namespace.cleanupToken } : {}),
  });
}

/** Manager boundary: create an environment descriptor; ownership/state creation is D04. */
export function developmentNamespaceEnvironment(
  instance: DevelopmentInstance,
  cleanupToken: string,
): Readonly<Record<string, string>> {
  const env = {
    TMUX_IDE_RUNTIME_MODE: "development",
    TMUX_IDE_DEVELOPMENT_WORKTREE: instance.worktree,
    TMUX_IDE_DEVELOPMENT_NAME: instance.name,
    TMUX_IDE_DEVELOPMENT_STORE: instance.store,
    TMUX_IDE_DEVELOPMENT_ID: instance.id,
    TMUX_IDE_RUNTIME_DIR: instance.runtimeDir,
    TMUX_IDE_HOME: instance.stateHome,
    TMUX_IDE_REGISTRY_DIR: instance.stateHome,
    TMUX_IDE_DAEMON_INFO_DIR: instance.stateHome,
    TMUX_IDE_TMUX_SOCKET_PATH: join(instance.runtimeDir, "tmux.sock"),
    TMUX_IDE_CLEANUP_TOKEN: cleanupToken,
  };
  return runtimeNamespaceEnvironment(resolveRuntimeNamespace({ env }));
}

/** Retain shell HOME, clear inherited tmux-ide authority before applying one bundle. */
export function developmentChildEnvironment(
  namespace: RuntimeNamespace,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!namespace.development) throw new Error("Expected a development namespace");
  const env = Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => !key.startsWith("TMUX_IDE_") && key !== "TMUX" && key !== "TMUX_PANE",
    ),
  );
  return { ...env, ...runtimeNamespaceEnvironment(namespace) };
}

/** Direct legacy tmux adapters must explicitly carry the resolved socket in development. */
export function runtimeTmuxArgs(args: readonly string[]): string[] {
  const namespace = resolveRuntimeNamespace();
  if (!namespace.development) return [...args];
  // This adapter accepts a command plus command-local options, not global flags.
  // In particular capture-pane -S is valid, while global -f/-S/-L are not.
  if (!args[0] || args[0].startsWith("-"))
    throw new Error("Conflicting development tmux global options");
  if (namespace.tmuxSocket.kind !== "path") throw new Error("Missing development tmux socket");
  return ["-S", namespace.tmuxSocket.path, ...args];
}

/** Validate concrete file/asset destinations too, including existing symlink leaves. */
export function runtimeOwnedPath(path: string): string {
  const namespace = resolveRuntimeNamespace();
  if (
    namespace.development &&
    !isInsideOrEqual(path, namespace.development.root) &&
    !isInsideOrEqual(path, namespace.runtimeDir)
  )
    throw new TypeError("development path escapes instance authority");
  return path;
}

export function assertQualifiedDevelopmentLaunch(): void {
  if (resolveRuntimeNamespace().development)
    throw new Error(
      "Development launch requires exact build artifacts (D03); installed CLI fallback is disabled",
    );
}

/** Caller intent differs from the default used when starting a new owner. */
export function resolveTmuxServerIntent(options: RuntimeNamespaceResolutionOptions = {}): {
  readonly source: "explicit" | "current";
  readonly selector: RuntimeNamespace["tmuxSocket"];
} | null {
  const env = options.env ?? process.env;
  const namespace = resolveRuntimeNamespace(options);
  if (
    namespace.isolated ||
    nonEmpty(env, TMUX_SOCKET_NAME_ENV) ||
    nonEmpty(env, TMUX_SOCKET_PATH_ENV)
  )
    return { source: "explicit", selector: namespace.tmuxSocket };
  const current = /^(.*),[0-9]+,[0-9]+$/u.exec(env.TMUX ?? "")?.[1];
  return current ? { source: "current", selector: { kind: "path", path: current } } : null;
}
