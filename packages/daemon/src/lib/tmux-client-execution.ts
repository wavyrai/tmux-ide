import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { resolveRuntimeNamespace } from "./runtime-namespace.ts";
import {
  resolveBundledTmux,
  bundledTmuxResourceEnvironment,
  withBundledTmuxResources,
} from "./bundled-tmux.ts";

export function resolveTmuxExecutable(): string {
  if (resolveRuntimeNamespace().development) return resolveBundledTmux()!;
  const configured = process.env.TMUX_IDE_TMUX_BIN;
  if (!configured) {
    const bundled = resolveBundledTmux();
    if (bundled) return bundled;
  }
  const candidates = configured
    ? [configured]
    : (process.env.PATH ?? "")
        .split(delimiter)
        // Empty and relative PATH entries mean the daemon/project cwd. They
        // are never executable authority for a privileged tmux mutation.
        .filter((entry) => entry.length > 0 && isAbsolute(entry))
        .map((entry) => join(entry, "tmux"));
  for (const candidate of candidates) {
    try {
      if (!isAbsolute(candidate)) continue;
      accessSync(candidate, constants.X_OK);
      const canonical = realpathSync(candidate);
      if (statSync(canonical).isFile()) return canonical;
    } catch {
      // Continue to the next daemon-start candidate.
    }
  }
  throw new Error("tmux_executable_unavailable");
}

const SAFE_TERMINAL_VALUE = /^(?:xterm|screen|tmux|rxvt|vt100|ansi)[A-Za-z0-9+._-]{0,58}$/u;
const SAFE_LOCALE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/u;

/**
 * The pinned tmux client receives only presentation metadata. Everything else
 * is denied by omission: PATH/HOME/SHELL, TMUX/TMUX_PANE/TMUX_TMPDIR, shell
 * startup hooks, dynamic-loader variables, Node options, and project secrets
 * cannot redirect authority or inject code into this daemon-owned execution.
 */
export function tmuxClientEnvironment(
  source: NodeJS.ProcessEnv,
  executable?: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    TERM: SAFE_TERMINAL_VALUE.test(source.TERM ?? "") ? source.TERM : "xterm-256color",
    // A pinned runner may be the first tmux client and therefore create the
    // server. Never let a headless parent (`TERM=dumb`, `NO_COLOR=1`) become
    // the global environment inherited by every later interactive child.
    COLORTERM: "truecolor",
  };
  for (const name of ["LANG", "LC_ALL", "LC_CTYPE"] as const) {
    const value = source[name];
    if (value && SAFE_LOCALE_VALUE.test(value)) environment[name] = value;
  }
  return { ...environment, ...bundledTmuxResourceEnvironment(executable) };
}

/**
 * The socket an ordinary tmux client reaches, or null inside tmux (where the
 * server exists by definition). Ordinary clients pass no -S or -L in
 * production, so this is tmux's own rule: $TMUX, else the default socket.
 */
export function ordinaryTargetSocket(environment: NodeJS.ProcessEnv): string | null {
  if (environment.TMUX) return null;
  const uid = process.getuid?.() ?? 0;
  return join(environment.TMUX_TMPDIR || "/tmp", `tmux-${uid}`, "default");
}

const answering = new Set<string>();

/**
 * Does a server answer on this socket? A socket file alone is not enough: a
 * server that crashed leaves one behind. `probe` asks with `list-sessions`,
 * which never starts a server. A running server is remembered for the process.
 */
export function serverAnswers(socket: string, probe: string): boolean {
  if (answering.has(socket)) return true;
  try {
    if (!statSync(socket).isSocket()) return false;
  } catch {
    return false;
  }
  try {
    execFileSync(probe, ["-S", socket, "list-sessions", "-F", "#{pid}"], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 3000,
      env: withBundledTmuxResources(probe, process.env),
    });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    // A refused connection is a stale socket. Anything else (a protocol
    // mismatch, a timeout) means something is there: keep the PATH client.
    if (/no server running|error connecting|connection refused|no such file/iu.test(stderr))
      return false;
  }
  answering.add(socket);
  return true;
}

export interface OrdinaryTmuxClientOptions {
  /** Whether a server answers on this socket. Defaults to {@link serverAnswers}. */
  readonly serverRunning?: (socket: string) => boolean;
  /** The validated bundled executable, or null. */
  readonly bundled?: () => string | null;
}

/**
 * Ordinary CLI commands retain PATH selection for a running server. When no
 * server runs, the next command starts one, so bundled tmux goes first: a
 * Homebrew client must not start a reduced-feature server (#766).
 * TMUX_IDE_TMUX_BIN always wins.
 */
export function resolveOrdinaryTmuxClient(
  environment: NodeJS.ProcessEnv,
  cwd?: string | URL,
  options: OrdinaryTmuxClientOptions = {},
): {
  executable: string;
  environment: NodeJS.ProcessEnv;
} {
  const bundled =
    options.bundled ??
    (() =>
      resolveBundledTmux([
        ...(environment.TMUX_IDE_CLI ? [environment.TMUX_IDE_CLI] : []),
        fileURLToPath(import.meta.url),
      ]));
  const configured = environment.TMUX_IDE_TMUX_BIN;
  if (!configured) {
    const socket = ordinaryTargetSocket(environment);
    if (socket !== null) {
      let starter: string | null = null;
      try {
        starter = bundled();
      } catch {
        // An invalid bundle falls back to the PATH client below.
      }
      const running = options.serverRunning ?? ((at: string) => serverAnswers(at, starter!));
      if (starter && !running(socket))
        return { executable: starter, environment: withBundledTmuxResources(starter, environment) };
    }
  }
  const candidates = configured
    ? [configured]
    : (environment.PATH ?? "/usr/bin:/bin")
        .split(delimiter)
        .map((entry) =>
          resolve(cwd instanceof URL ? fileURLToPath(cwd) : (cwd ?? process.cwd()), entry, "tmux"),
        );
  let executable: string | undefined;
  for (const candidate of candidates) {
    try {
      if (!isAbsolute(candidate)) continue;
      accessSync(candidate, constants.X_OK);
      const canonical = realpathSync(candidate);
      if (statSync(canonical).isFile()) {
        executable = canonical;
        break;
      }
    } catch {
      /* Try the next ordinary PATH candidate. */
    }
  }
  if (!executable && !configured) executable = bundled() ?? undefined;
  if (!executable) throw new Error("tmux_executable_unavailable");
  return { executable, environment: withBundledTmuxResources(executable, environment) };
}
