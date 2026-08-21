/**
 * One authority bundle for every piece of process-local tmux-ide state.
 *
 * Production intentionally defaults to the user's canonical state and tmux
 * server. Tests, smoke runs and performance fixtures must opt into an
 * isolated namespace. Keeping the guard here makes accidental canonical I/O
 * impossible even when a new harness forgets one of the legacy env vars.
 */
import { homedir } from "node:os";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const RUNTIME_MODE_ENV = "TMUX_IDE_RUNTIME_MODE";
export const STATE_HOME_ENV = "TMUX_IDE_HOME";
export const REGISTRY_DIR_ENV = "TMUX_IDE_REGISTRY_DIR";
export const DAEMON_INFO_DIR_ENV = "TMUX_IDE_DAEMON_INFO_DIR";
export const TMUX_SOCKET_NAME_ENV = "TMUX_IDE_TMUX_SOCKET_NAME";
export const TMUX_SOCKET_PATH_ENV = "TMUX_IDE_TMUX_SOCKET_PATH";
export const CLEANUP_TOKEN_ENV = "TMUX_IDE_CLEANUP_TOKEN";

export type RuntimeMode = "production" | "test" | "smoke" | "testdrive" | "performance";

export interface RuntimeNamespace {
  readonly mode: RuntimeMode;
  readonly stateHome: string;
  readonly registryDir: string;
  readonly daemonInfoDir: string;
  readonly controlSocketPath: string;
  readonly eventLogPath: string;
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

const ISOLATED_MODES = new Set<RuntimeMode>(["test", "smoke", "testdrive", "performance"]);
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

function pathIdentity(path: string): string {
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(existsSync(cursor) ? realpathSync(cursor) : cursor, ...suffix);
}

function isInsideOrEqual(path: string, parent: string): boolean {
  const child = pathIdentity(path);
  const root = pathIdentity(parent);
  const offset = relative(root, child);
  return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== "..");
}

function runtimeMode(env: NodeJS.ProcessEnv): RuntimeMode {
  const raw = nonEmpty(env, RUNTIME_MODE_ENV) ?? "production";
  if (!["production", "test", "smoke", "testdrive", "performance"].includes(raw)) {
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

  return Object.freeze({
    mode,
    stateHome,
    registryDir,
    daemonInfoDir,
    controlSocketPath: join(stateHome, "control.sock"),
    eventLogPath: join(stateHome, "events.jsonl"),
    tmuxSocket,
    cleanupToken,
    namespaceId: isolated ? cleanupToken! : "canonical",
    persistence: isolated ? "ephemeral" : "durable",
    isolated,
  });
}

export function runtimeNamespaceEnvironment(
  namespace: RuntimeNamespace,
): Readonly<Record<string, string>> {
  return Object.freeze({
    [RUNTIME_MODE_ENV]: namespace.mode,
    [STATE_HOME_ENV]: namespace.stateHome,
    [REGISTRY_DIR_ENV]: namespace.registryDir,
    [DAEMON_INFO_DIR_ENV]: namespace.daemonInfoDir,
    ...(namespace.tmuxSocket.kind === "name"
      ? { [TMUX_SOCKET_NAME_ENV]: namespace.tmuxSocket.name }
      : { [TMUX_SOCKET_PATH_ENV]: namespace.tmuxSocket.path }),
    ...(namespace.cleanupToken ? { [CLEANUP_TOKEN_ENV]: namespace.cleanupToken } : {}),
  });
}
