/**
 * Front-door decision for bare `tmux-ide` / `tmux-ide start`: what does running
 * the command with no subcommand land on?
 *
 * Three outcomes:
 *  - `"project"` — a single-project config is present here (and `--team`
 *    wasn't passed): launch that project, exactly as always (backward compatible).
 *  - `"app"` — when there's no declarative project to launch, bare `tmux-ide`
 *    opens the unified visual app: the default starts-anywhere entry.
 *  - `"cockpit"` — the classic team cockpit: an explicit `--team`, or the
 *    global-config opt-out from the unified front door.
 *
 * `--team` ALWAYS means the classic cockpit (an explicit request for it), so it
 * overrides both a present project config and the front-door flip.
 */
export type EntryTarget = "project" | "cockpit" | "app";

export interface ResolveEntryOptions {
  /** Legacy compatibility fact retained for older callers. */
  hasIdeYml: boolean;
  /** Whether a workspace config is present in the target directory. */
  hasWorkspaceConfig?: boolean;
  /** Winning config kind when available. */
  configKind?: "workspace" | "legacy" | "none";
  /** Whether `--team` forced the cockpit. */
  teamFlag: boolean;
  /** The `app.frontDoor` config flag — choose the default no-project entry. */
  frontDoor: boolean;
}

/**
 * PURE — resolve the bare-invocation target. `--team` wins (always the classic
 * cockpit); otherwise a present project config launches the project; otherwise the
 * front-door flag decides between the unified app (default) and the classic
 * cockpit (explicit opt-out).
 */
export function resolveEntry(opts: ResolveEntryOptions): EntryTarget {
  if (opts.teamFlag) return "cockpit";
  if (opts.configKind === "workspace" || opts.configKind === "legacy") return "project";
  if (opts.hasWorkspaceConfig || opts.hasIdeYml) return "project";
  return opts.frontDoor ? "app" : "cockpit";
}
