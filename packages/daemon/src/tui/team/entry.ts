/**
 * Front-door decision for bare `tmux-ide` / `tmux-ide start`: what does running
 * the command with no subcommand land on?
 *
 * Three outcomes:
 *  - `"project"` — a single-project `ide.yml` is present here (and `--team`
 *    wasn't passed): launch that project, exactly as always (backward compatible).
 *  - `"app"` — the M22.6 front-door flip: when there's no project to launch and
 *    the user opted in (`app.frontDoor`), bare `tmux-ide` opens the unified app
 *    (`tmux-ide app`) — the VS-Code-style "starts anywhere" entry.
 *  - `"cockpit"` — the classic team cockpit: the default no-project entry while
 *    the flip is off, and always the target of an explicit `--team`.
 *
 * `--team` ALWAYS means the classic cockpit (an explicit request for it), so it
 * overrides both a present `ide.yml` and the front-door flip.
 */
export type EntryTarget = "project" | "cockpit" | "app";

export interface ResolveEntryOptions {
  /** Whether an `ide.yml` is present in the target directory. */
  hasIdeYml: boolean;
  /** Whether `--team` forced the cockpit. */
  teamFlag: boolean;
  /** The `app.frontDoor` config flag — flip the default no-project entry to the app. */
  frontDoor: boolean;
}

/**
 * PURE — resolve the bare-invocation target. `--team` wins (always the classic
 * cockpit); otherwise a present `ide.yml` launches the project; otherwise the
 * front-door flag decides between the unified app (opted in) and the classic
 * cockpit (default).
 */
export function resolveEntry(opts: ResolveEntryOptions): EntryTarget {
  if (opts.teamFlag) return "cockpit";
  if (opts.hasIdeYml) return "project";
  return opts.frontDoor ? "app" : "cockpit";
}
