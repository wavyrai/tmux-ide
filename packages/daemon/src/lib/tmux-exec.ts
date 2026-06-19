// Shared synchronous tmux invocation primitive with an injectable executor for
// tests. Used by both widgets/lib/pane-comms (single-session queries) and
// lib/agent-discovery (all-session scan). The async/spawn-based helpers live
// elsewhere; this is the lightweight execFileSync path the TUI/discovery use.
import { execFileSync } from "node:child_process";

export type TmuxExecutor = (cmd: string, args: string[], options?: object) => string;

let _executor: TmuxExecutor = (cmd, args, options) =>
  execFileSync(cmd, args, { encoding: "utf-8", ...options }).toString();

/** Swap the tmux executor (tests). Returns a restore function. */
export function _setExecutor(fn: TmuxExecutor): () => void {
  const prev = _executor;
  _executor = fn;
  return () => {
    _executor = prev;
  };
}

/**
 * Low-level: invoke tmux with explicit child_process options (e.g. custom
 * stdio/encoding) and no error handling. Callers own the try/catch. Goes
 * through the same injectable executor so tests can intercept it.
 */
export function runTmux(args: string[], options?: object): string {
  return _executor("tmux", args, options);
}

/** Run a tmux command, returning trimmed stdout. Returns "" when no server. */
export function tmux(...args: string[]): string {
  try {
    return _executor("tmux", args, { stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string })?.stderr?.toString() ?? "";
    if (stderr.includes("no server running") || stderr.includes("can't find session")) {
      return "";
    }
    throw error;
  }
}
