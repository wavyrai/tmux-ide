/**
 * The detachable cockpit (M23.2) — tmux keeps the app itself alive.
 *
 * `tmux-ide app --detachable` (alias `--hosted`) doesn't run the app in the
 * invoking terminal: it ensures an internal `_tmux-ide-app` session exists
 * running the app full-screen, then attaches the terminal to it. ^q under
 * hosting DETACHES the client (the app keeps running); re-invocation from any
 * terminal — including a phone over ssh — reattaches the SAME cockpit with
 * scroll positions, dialogs, and workspace context intact. Ctrl-Q is bound at
 * tmux's root input table so it puts away only the client which pressed it.
 *
 * These are the PURE pieces of that contract: the entry decision, the tmux
 * argv builders, and the shell quoting for the host pane's command line. The
 * io (spawning tmux, resolving bun vs the compiled binary) stays in the CLI;
 * the app side reads {@link HOSTED_ENV} to keep direct pane-injected Ctrl-Q
 * from destroying the resident renderer.
 */

/** The internal host session. `_`-prefixed so every fleet surface (team --json,
 *  sidebar, home) and the snapshot/restore path already filter it out. */
export const APP_HOST_SESSION = "_tmux-ide-app";

/** The env marker the launcher sets on the hosted app process. The app consumes
 *  renderer-delivered Ctrl-Q when it sees `=1`; real client Ctrl-Q is handled
 *  by tmux before reaching the pane. The CLI also uses it as a recursion guard. */
export const HOSTED_ENV = "TMUX_IDE_HOSTED";

/** Hosted put-away is a tmux client action, never a renderer action. */
export const HOSTED_PUT_AWAY_KEY = "C-q" as const;

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
    COLORTERM: "truecolor",
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
  return [
    "exec",
    "env",
    "-u",
    "NO_COLOR",
    ...assigns,
    shellQuote(bin),
    ...argv.map(shellQuote),
  ].join(" ");
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
 * The client events that re-assert `window-size latest` on the host (M25.5).
 * Each hook's effect was MEASURED on tmux 3.7b in an isolated two-client rig
 * (220x60 local + 120x40 ssh-sim):
 *
 * - `client-attached` / `client-focus-in` / `client-session-changed`: tmux
 *   3.7b already re-adopts the event client's size natively on all of these
 *   (attach ~8ms, focus-in ~17ms, switch-client ~17ms — window-resized hook
 *   timestamps; detach of the latest client also re-adopts natively, ~13ms).
 *   The hooks are NOT what makes those paths work; they are the SELF-HEAL for
 *   the one measured way the host gets permanently stuck: any `resize-window`
 *   against it (a stray tool or user command) flips `window-size` to manual —
 *   after which NO client event re-adopts, ever (measured: a fresh 220x60
 *   attach left a manually-80x24 host at 80x24). Re-asserting the option is
 *   the heal (measured: instant re-adopt) — and it is safe to fire
 *   redundantly: setting `window-size latest` when it is already latest just
 *   recomputes the same size. Fire counts are bounded and linear (measured:
 *   10 rapid focus alternations → exactly 20 focus-in fires; 10 attach cycles
 *   → 10 attached + 10 session-changed fires — attach fires both — each a
 *   single in-server set-option, no storm).
 *
 * NO `client-detached` hook: measured on 3.7b it never fires as a SESSION
 * hook (the detaching client has already left the session when hooks are
 * resolved — 0 fires across 10 detach cycles while the same rig's global
 * hook logged every one), and the native detach re-adopt covers the path.
 *
 * Deliberately NOT `resize-window -a`: per the tmux manual, EVERY
 * resize-window form — -a included — "will automatically set window-size to
 * manual", i.e. it would cause the exact stuck state it is meant to fix. And
 * no `run-shell`: these are tmux-native commands executed in-server
 * (run-shell hooks serialize the server — prior measurement).
 */
export const HOST_RESIZE_HOOKS = [
  "client-attached",
  "client-focus-in",
  "client-session-changed",
] as const;

/**
 * PURE — the post-create/ensure session setup: status OFF so the app owns
 * every row (under `status on` the host steals the bottom row and the app
 * renders one short), and `window-size latest` pinned explicitly so the most
 * recently active client dictates the size — a smaller second client
 * letterboxes the larger one (tmux's own dot-fill), which is the documented
 * behavior.
 *
 * M25.5 additions (each measured on 3.7b — see {@link HOST_RESIZE_HOOKS}):
 *
 * - `focus-events on` (server option — the ONE non-session-scoped line, and
 *   the load-bearing one): it defaults OFF, so real terminals are never asked
 *   for focus reporting and `client-focus-in` never fires. With it on, coming
 *   BACK to a terminal that stayed attached re-adopts that client's size on
 *   the focus event alone (measured: focus-in → client-active →
 *   window-resized in ~17ms) — no keystroke needed. This is the user's exact
 *   "reopen it on my computer locally" moment when the local client never
 *   detached. Side effect is the widely-recommended one (panes that request
 *   focus, e.g. editors, start receiving it).
 * - the {@link HOST_RESIZE_HOOKS} self-heal hooks, session-scoped to the host
 *   (zero effect on user sessions).
 *
 * The whole list is idempotent — the CLI applies it on EVERY ensure, not just
 * create, so upgrading tmux-ide fixes an already-running cockpit on its next
 * `tmux-ide app` (and un-sticks a manually-resized host).
 *
 * No `=` exact-match prefix here: tmux (measured on 3.7b) rejects it on
 * `set-option` session targets ("no such session") even though has-session
 * and attach accept it. Plain names are safe in THIS builder only because
 * setup runs right after the exists-probe/create — the exact session exists,
 * and tmux prefers an exact match over a prefix match when one does.
 */
export function hostSetupArgvs(): string[][] {
  const heal = `set-option -w -t ${APP_HOST_SESSION}: window-size latest`;
  return [
    ["set-option", "-t", APP_HOST_SESSION, "status", "off"],
    ["set-option", "-w", "-t", `${APP_HOST_SESSION}:`, "window-size", "latest"],
    ["set-option", "-s", "focus-events", "on"],
    ...HOST_RESIZE_HOOKS.map((hook) => ["set-hook", "-t", APP_HOST_SESSION, hook, heal]),
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

/**
 * tmux 3.0 (the supported floor) cannot query one binding or format
 * `list-keys`, so inspect the bounded root-table listing in-process.
 */
export function hostRootBindingsArgv(): string[] {
  return ["list-keys", "-T", "root"];
}

/**
 * Install Ctrl-Q at tmux's input boundary. A bound `detach-client` and
 * `switch-client` execute with the key's exact client as their current client;
 * a command launched by the shared renderer pane does not have that identity.
 *
 * The outer session guard preserves ordinary Ctrl-Q input everywhere else.
 * A client which switched into the host returns to its own prior session; a
 * plain attachment, which has no prior session, detaches only itself.
 */
export function hostPutAwayBindingArgv(): string[] {
  return [
    "bind-key",
    "-T",
    "root",
    HOSTED_PUT_AWAY_KEY,
    "if-shell",
    "-F",
    `#{==:#{session_name},${APP_HOST_SESSION}}`,
    "if-shell -F '#{client_last_session}' 'switch-client -l' 'detach-client'",
    `send-keys ${HOSTED_PUT_AWAY_KEY}`,
  ];
}

export type HostedPutAwayBindingState = "absent" | "owned" | "conflict";

const HOSTED_PUT_AWAY_LISTING_COMMAND =
  `if-shell -F "#{==:#{session_name},${APP_HOST_SESSION}}" ` +
  `"if-shell -F '#{client_last_session}' 'switch-client -l' 'detach-client'" ` +
  `"send-keys ${HOSTED_PUT_AWAY_KEY}"`;

function rootCtrlQBindingCommands(rootBindings: string): readonly string[] {
  if (
    typeof rootBindings !== "string" ||
    rootBindings.includes("\0") ||
    Buffer.byteLength(rootBindings, "utf8") > 1024 * 1024
  ) {
    return ["invalid-root-binding-list"];
  }
  return rootBindings
    .split(/\r?\n/u)
    .map(
      (line) =>
        line.match(/^\s*bind-key\s+-T\s+root\s+C-q\s+(?<command>.+?)\s*$/u)?.groups?.command,
    )
    .filter((command): command is string => command !== undefined);
}

/**
 * Classify the existing root Ctrl-Q binding without evaluating or embedding a
 * user-authored tmux command. Anything other than our exact canonical shape is
 * a conflict and must remain untouched.
 */
export function hostedPutAwayBindingState(rootBindings: string): HostedPutAwayBindingState {
  const matches = rootCtrlQBindingCommands(rootBindings);
  if (matches.length === 0) return "absent";
  if (matches.length !== 1) return "conflict";
  return matches[0] === HOSTED_PUT_AWAY_LISTING_COMMAND ? "owned" : "conflict";
}
