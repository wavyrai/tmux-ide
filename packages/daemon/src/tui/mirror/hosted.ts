/**
 * The detachable cockpit (M23.2) — tmux keeps the app itself alive.
 *
 * `tmux-ide app --detachable` (alias `--hosted`) doesn't run the app in the
 * invoking terminal: it ensures an internal `_tmux-ide-app` session exists
 * running the app full-screen, then attaches the terminal to it. ^q under
 * hosting DETACHES the client (the app keeps running); re-invocation from any
 * terminal — including a phone over ssh — reattaches the SAME cockpit with
 * scroll positions, dialogs, and workspace context intact.
 *
 * These are the PURE pieces of that contract: the entry decision, the tmux
 * argv builders, and the shell quoting for the host pane's command line. The
 * io (spawning tmux, resolving bun vs the compiled binary) stays in the CLI;
 * the app side only reads {@link HOSTED_ENV} to flip ^q from quit to detach.
 */

/** The internal host session. `_`-prefixed so every fleet surface (team --json,
 *  sidebar, home) and the snapshot/restore path already filter it out. */
export const APP_HOST_SESSION = "_tmux-ide-app";

/** The env marker the launcher sets on the hosted app process. The app flips
 *  ^q from "quit" to "detach the client" when it sees `=1`; the CLI treats it
 *  as a recursion guard (a hosted app never re-hosts). */
export const HOSTED_ENV = "TMUX_IDE_HOSTED";

/** Everything the entry decision reads — flags, config, and the guard. */
export interface HostedEntryInput {
  /** `--detachable` (the primary flag). */
  flagDetachable: boolean;
  /** `--hosted` (the alias). */
  flagHosted: boolean;
  /** `app.detachable` from the typed config — makes bare `tmux-ide app` (and
   *  the frontDoor entry) hosted without the flag. */
  configDetachable: boolean;
  /** Whether WE are already the hosted app ({@link HOSTED_ENV} set). */
  hostedEnv: boolean;
}

/**
 * PURE — should this `tmux-ide app` invocation run hosted? Flags and config
 * both opt in; the env marker vetoes everything (the app inside the host
 * session must launch plain, or it would try to attach to itself).
 */
export function wantsHostedApp(input: HostedEntryInput): boolean {
  if (input.hostedEnv) return false;
  return input.flagDetachable || input.flagHosted || input.configDetachable;
}

/**
 * PURE — POSIX single-quote a word for a tmux `new-session` shell command
 * (tmux hands the string to `sh -c`). Single quotes pass everything literally;
 * an embedded `'` closes, escapes, and reopens.
 */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * PURE — the env vars the host pane's app process needs, assembled for the
 * command line rather than tmux's session environment: the tmux server may
 * have been started elsewhere with a different environment, so nothing can be
 * assumed to inherit. PATH rides along for the same reason (the `bun` launch
 * mode resolves the binary by name).
 */
export function hostedEnvVars(base: {
  /** The user's real invocation dir (in-app prompts default here). */
  cwd: string;
  /** The node-runnable CLI path (`TMUX_IDE_CLI`) for in-app subprocesses. */
  cli: string;
  /** The invoking shell's PATH. */
  path?: string;
  /** `TMUX_IDE_HOME` / `TMUX_IDE_CONFIG` / `TMUX_IDE_TUI_BIN` pass-throughs
   *  (set in test rigs; must reach the hosted app or it reads real state). */
  home?: string;
  config?: string;
  tuiBin?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    [HOSTED_ENV]: "1",
    TMUX_IDE_CWD: base.cwd,
    TMUX_IDE_CLI: base.cli,
  };
  if (base.path) env.PATH = base.path;
  if (base.home) env.TMUX_IDE_HOME = base.home;
  if (base.config) env.TMUX_IDE_CONFIG = base.config;
  if (base.tuiBin) env.TMUX_IDE_TUI_BIN = base.tuiBin;
  return env;
}

/**
 * PURE — the shell command the host pane runs: `exec env K=V… bin args…`,
 * every value quoted. `exec` replaces the pane's shell with the app so a quit
 * (the palette verb) ends the pane — and with it the single-window session.
 */
export function hostedCommandLine(
  bin: string,
  argv: readonly string[],
  env: Record<string, string>,
): string {
  const assigns = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return ["exec", "env", ...assigns, shellQuote(bin), ...argv.map(shellQuote)].join(" ");
}

/** PURE — exact-match existence probe (`=` prefix: `has-session -t` would
 *  otherwise PREFIX-match, e.g. a user session named `_tmux-ide-app-notes`). */
export function hostExistsArgv(): string[] {
  return ["has-session", "-t", `=${APP_HOST_SESSION}`];
}

/** PURE — create the detached host session running the app command line. */
export function hostCreateArgv(opts: { cwd: string; commandLine: string }): string[] {
  return ["new-session", "-d", "-s", APP_HOST_SESSION, "-c", opts.cwd, opts.commandLine];
}

/**
 * PURE — the post-create session setup: status OFF so the app owns every row
 * (under `status on` the host steals the bottom row and the app renders one
 * short), and `window-size latest` pinned explicitly so the most recently
 * active client dictates the size — a smaller second client letterboxes the
 * larger one (tmux's own dot-fill), which is the documented behavior.
 *
 * No `=` exact-match prefix here: tmux (measured on 3.7b) rejects it on
 * `set-option` session targets ("no such session") even though has-session
 * and attach accept it. Plain names are safe in THIS builder only because
 * setup runs right after create — the exact session exists, and tmux prefers
 * an exact match over a prefix match when one does.
 */
export function hostSetupArgvs(): string[][] {
  return [
    ["set-option", "-t", APP_HOST_SESSION, "status", "off"],
    ["set-option", "-w", "-t", `${APP_HOST_SESSION}:`, "window-size", "latest"],
  ];
}

/**
 * PURE — how the invoking terminal reaches the cockpit: inside tmux the
 * client is already attached to a server, so `switch-client` moves it (a
 * nested `attach` would complain and double-render); a plain terminal
 * attaches. Both exact-match the host name.
 */
export function hostAttachArgv(insideTmux: boolean): string[] {
  return insideTmux
    ? ["switch-client", "-t", `=${APP_HOST_SESSION}`]
    : ["attach-session", "-t", `=${APP_HOST_SESSION}`];
}
