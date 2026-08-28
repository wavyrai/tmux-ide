/** tmux `-e` options that remove a hostile inherited opt-out and advertise RGB. */
export const TMUX_TRUECOLOR_ENVIRONMENT_ARGS = [
  "-e",
  "NO_COLOR",
  "-e",
  "COLORTERM=truecolor",
] as const;

/**
 * Existing tmux sessions keep their own environment snapshot. Normalize it
 * before creating a user pane so headless launchers cannot make interactive
 * agents monochrome. Existing processes are intentionally untouched.
 */
export function prepareTmuxTruecolorEnvironment(
  runTmux: (args: readonly string[]) => string,
  sessionName: string,
): void {
  runTmux(["set-environment", "-u", "-t", `=${sessionName}`, "NO_COLOR"]);
  runTmux(["set-environment", "-t", `=${sessionName}`, "COLORTERM", "truecolor"]);
}

/** Run a command from an existing shell without inheriting its NO_COLOR flag. */
export function truecolorShellCommand(command: string): string {
  return `env -u NO_COLOR COLORTERM=truecolor ${command}`;
}
