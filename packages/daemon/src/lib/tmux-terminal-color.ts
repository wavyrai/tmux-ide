/** tmux `-e` options that advertise RGB and the stable pane colour contract. */
export const TMUX_TRUECOLOR_ENVIRONMENT_ARGS = [
  "-e",
  "COLORTERM=truecolor",
  "-e",
  "COLORFGBG=15;0",
] as const;

/**
 * tmux has no `new-session -e` spelling for removing an inherited variable:
 * `-e` accepts only `VARIABLE=value`. The first process of a new session must
 * therefore clear a hostile global `NO_COLOR` in its command environment.
 */
export const TMUX_TRUECOLOR_INTERACTIVE_SHELL_COMMAND =
  "exec env -u NO_COLOR COLORTERM=truecolor COLORFGBG='15;0' \"${SHELL:-/bin/sh}\" -l";

/** Exact session mutations required before tmux creates another child. */
export function tmuxTruecolorEnvironmentCommands(sessionName: string): readonly string[][] {
  return [
    ["set-environment", "-r", "-t", `=${sessionName}`, "NO_COLOR"],
    ["set-environment", "-t", `=${sessionName}`, "COLORTERM", "truecolor"],
    ["set-environment", "-t", `=${sessionName}`, "COLORFGBG", "15;0"],
  ];
}

/**
 * Existing tmux sessions keep their own environment snapshot. Normalize it
 * before creating a user pane so headless launchers cannot make interactive
 * agents monochrome. Existing processes are intentionally untouched.
 */
export function prepareTmuxTruecolorEnvironment(
  runTmux: (args: readonly string[]) => string,
  sessionName: string,
): void {
  // `-u` merely removes the session override, which exposes a dirty global
  // value again. `-r` records tmux's removal tombstone and strips the variable
  // from every child subsequently created in this session.
  for (const args of tmuxTruecolorEnvironmentCommands(sessionName)) runTmux(args);
}

/** Run a command from an existing shell without inheriting its NO_COLOR flag. */
export function truecolorShellCommand(command: string): string {
  return `env -u NO_COLOR COLORTERM=truecolor COLORFGBG='15;0' ${command}`;
}
