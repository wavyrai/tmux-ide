/** Engine-owned tmux facts used to enroll a session in chrome observation. */
export const ADOPTED_OPTION = "@tmux_ide_adopted";

/** Hidden internal session that hosts the updater loop. */
export const UPDATER_SESSION = "_tmux-ide-chrome";

export function adoptMarkArgv(session: string): string[] {
  return ["set-option", "-t", session, ADOPTED_OPTION, "1"];
}

export function updaterProbeArgv(): string[] {
  return ["has-session", "-t", `=${UPDATER_SESSION}`];
}

export function updaterSpawnArgv(): string[] {
  return ["new-session", "-d", "-s", UPDATER_SESSION, "exec tmux-ide chrome-updater"];
}
