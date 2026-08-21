/**
 * THE tmux-ide state home — `TMUX_IDE_HOME` when set (tests / per-run
 * overrides), else `~/.tmux-ide`. The same resolution the welcome marker,
 * update cache, and app state each grew locally; new state files should
 * resolve through here so none of them can drift from the override again.
 */
import { resolveRuntimeNamespace } from "./runtime-namespace.ts";

/** Absolute path to the state home directory (not created here). */
export function stateHome(): string {
  return resolveRuntimeNamespace().stateHome;
}
