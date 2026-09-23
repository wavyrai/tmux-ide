import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { resolveRuntimeNamespace } from "./runtime-namespace.ts";
import { resolveBundledTmux } from "./bundled-tmux.ts";

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
export function tmuxClientEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
  return environment;
}
