/**
 * The chrome front door (M25.1) — the tiny, LEAF constants + argv builders the
 * unified app needs to get a session watched without importing the chrome/data
 * graph (app.tsx deliberately never imports the sync fleet-scan modules that
 * {@link ./updater.ts} pulls in; see the FleetSession note there).
 *
 * "Watched" means: stamped with {@link ADOPTED_OPTION} so the background
 * updater enumerates it (VERIFIED inert for a session that never ran `adopt` —
 * none of adopt's status-row/border options are set, so the updater's status/
 * chip var writes land on options nothing reads), and the updater itself
 * ensured up. The sync twin of that flow lives in `updater.ts`
 * (`startUpdaterIfNeeded`); the app uses these argvs with async execFile (the
 * render-loop law).
 */

/** Per-session marker option set on adopt so the updater can enumerate adopted
 *  sessions. (Owned here; re-exported by `updater.ts` for its callers.) */
export const ADOPTED_OPTION = "@tmux_ide_adopted";

/** The hidden internal session that hosts the updater loop. */
export const UPDATER_SESSION = "_tmux-ide-chrome";

/** PURE — stamp `session` watched (see the header: inert re: chrome painting). */
export function adoptMarkArgv(session: string): string[] {
  return ["set-option", "-t", session, ADOPTED_OPTION, "1"];
}

/** PURE — the existence probe for the updater session (`=` exact-match, so a
 *  user session that merely starts with the name can't shadow it). Exit 0 =
 *  running. */
export function updaterProbeArgv(): string[] {
  return ["has-session", "-t", `=${UPDATER_SESSION}`];
}

/** PURE — the argv that spawns the updater loop, detached. `exec` replaces the
 *  shell so the pane IS the loop; killing the session stops it. */
export function updaterSpawnArgv(): string[] {
  return ["new-session", "-d", "-s", UPDATER_SESSION, "exec tmux-ide chrome-updater"];
}
