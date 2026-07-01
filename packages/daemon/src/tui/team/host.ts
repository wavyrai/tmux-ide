/**
 * Host shell for "tmux runs inside tmux-ide".
 *
 * `tmux-ide team` HOSTS tmux: it creates (or re-attaches) a dedicated tmux
 * session laid out as `[ switcher | main ]`. The LEFT pane runs the OpenTUI
 * switcher (the team cockpit) and the RIGHT pane is the live main area — a
 * plain shell placeholder for now; wiring it to mirror the selected session
 * is the next task.
 *
 * The command builders here are PURE (they return tmux argv arrays / a shell
 * string) so the layout can be asserted in tests without shelling out.
 */
import { runTmux } from "@tmux-ide/tmux-bridge";
import { shellEscape } from "../../lib/shell.ts";
import { IdeError } from "../../lib/errors.ts";

/**
 * Name of the host session. The leading underscore marks it reserved so it
 * can't collide with a real project literally named "tmux-ide", and the
 * switcher filters this exact name out of its session list.
 */
export const HOST_SESSION = "_tmux-ide";

/**
 * The DEDICATED tmux socket the host shell runs on (`tmux -L tmux-ide ...`).
 *
 * This is the whole point of the nested-tmux ergonomics: the host shell
 * (`[ switcher | main ]`) nests tmux inside tmux, and if it shared the user's
 * DEFAULT tmux server the two servers would fight over the global key tables
 * and prefix. So the host lives on its OWN server (this socket) with its own
 * prefix (C-a) and root focus keys, while the user's PROJECTS stay on the
 * DEFAULT socket, untouched. Every host CONTROL command goes through
 * `hostTmux()`; the nested `tmux attach` inside the main pane clears `$TMUX`
 * so it lands on the DEFAULT socket (the project), not this one.
 */
export const HOST_SOCKET = "tmux-ide";

/**
 * Prefix the given tmux argv with `-L <HOST_SOCKET>` so it runs against the
 * host server rather than the user's default one. All host-control commands
 * (layout, config, attach, kill) route through here.
 */
export function hostTmux(argv: string[]): string[] {
  return ["-L", HOST_SOCKET, ...argv];
}

/**
 * The two panes of the host layout, addressed by index within the session's
 * first window (matching tmux's default base indices). The switcher runs in
 * pane 0; pane 1 is the live main area the switcher drives.
 */
export const SWITCHER_PANE = `${HOST_SESSION}:0.0`;
export const MAIN_PANE = `${HOST_SESSION}:0.1`;

/** Default width, in columns, of the switcher pane. */
const DEFAULT_SWITCHER_WIDTH = 34;

/**
 * The shell command that runs the switcher in a tmux pane.
 *
 * The switcher is a bun `.tsx` that needs the repo-root `bunfig.toml` preload,
 * so it must be spawned FROM the repo root; the user's real invocation dir is
 * forwarded via `TMUX_IDE_CWD` so in-widget prompts still default to where the
 * user actually is. `TMUX_IDE_MAIN_PANE` tells the switcher which pane to drive
 * — its presence is also how the switcher knows it's running in host mode (vs.
 * standalone). All paths are shell-escaped.
 */
export function switcherPaneCommand(
  repoRoot: string,
  switcherScript: string,
  userCwd: string,
): string {
  return `cd ${shellEscape(repoRoot)} && TMUX_IDE_CWD=${shellEscape(userCwd)} TMUX_IDE_MAIN_PANE=${shellEscape(MAIN_PANE)} bun ${shellEscape(switcherScript)}`;
}

/**
 * tmux argv to make the MAIN pane show `target` LIVE via a nested `tmux attach`.
 *
 * The OUTER command runs on the HOST socket (`-L tmux-ide` via `hostTmux`) —
 * it respawns a pane that belongs to the host server. `respawn-pane -k` kills
 * whatever the main pane is running and starts a fresh command in it:
 * `TMUX= tmux attach -t <target>`. That INNER command clears the inherited
 * `$TMUX` so tmux (a) allows the nested attach instead of refusing with
 * "sessions should be nested with care" and (b) uses the DEFAULT socket — the
 * target is a PROJECT session, which lives on the default server, not the host
 * one. `-c <dir>` sets the pane's working directory so a later detach lands in
 * a sensible place.
 *
 * PURE (returns argv) so the incantation can be asserted without shelling out.
 */
export function mainRespawnCommand(mainPane: string, target: string, dir: string): string[] {
  return hostTmux([
    "respawn-pane",
    "-k",
    "-t",
    mainPane,
    "-c",
    dir,
    `TMUX= tmux attach -t ${shellEscape(target)}`,
  ]);
}

/**
 * Ordered tmux argv arrays that build AND configure the host layout from
 * scratch. Every argv runs on the host socket (`-L tmux-ide`, via `hostTmux`).
 *
 * Layout:
 *   1. new-session -d — the session, its first pane running the switcher,
 *      started in the repo root.
 *   2. split-window -h — the main pane (a shell) started in the user's cwd,
 *      to the RIGHT of the switcher.
 *   3. resize-pane -x — pin the switcher pane to `switcherWidth` columns.
 *   4. select-pane — focus back on the switcher.
 *
 * Config (host server only — safe because it's a SEPARATE server from the one
 * hosting the user's projects):
 *   5. prefix = C-a. The host server's prefix is C-a; project sessions on the
 *      default socket keep the stock C-b, so there's no prefix war. prefix2 is
 *      cleared to None so C-b is NOT swallowed by the host — it passes straight
 *      through to the nested project session attached in the main pane.
 *   6. Root (no-prefix) focus keys, bound ONLY on the host server so they can't
 *      shadow app keys in the user's real sessions: M-h → switcher (pane 0),
 *      M-l → main (pane 1). Alt+h/Alt+l are directional and rarely used by
 *      terminal apps, so they're safe to grab at the root.
 *   7. Pane-border labels (status top + a format showing each pane's title),
 *      then the switcher/main pane titles, so the border reads "switcher" /
 *      "main". Setting a title via `select-pane -T` also focuses that pane, so
 *      a final select-pane restores focus to the switcher.
 *   8. A short status-left so the host bar reads "tmux-ide".
 *
 * Panes are addressed by index within the session's first window (switcher = 0,
 * main = 1), matching tmux's default base indices.
 */
export function hostLayoutCommands(opts: {
  session: string;
  repoRoot: string;
  switcherScript: string;
  userCwd: string;
  switcherWidth: number;
}): string[][] {
  const { session, repoRoot, switcherScript, userCwd, switcherWidth } = opts;
  const switcher = `${session}:0.0`;
  const main = `${session}:0.1`;
  const switcherCmd = switcherPaneCommand(repoRoot, switcherScript, userCwd);

  return [
    // layout
    ["new-session", "-d", "-s", session, "-c", repoRoot, switcherCmd],
    ["split-window", "-h", "-t", switcher, "-c", userCwd],
    ["resize-pane", "-t", switcher, "-x", String(switcherWidth)],
    ["select-pane", "-t", switcher],
    // prefix — C-a on the host, C-b passes through to nested projects
    ["set-option", "-g", "prefix", "C-a"],
    ["set-option", "-g", "prefix2", "None"],
    // root focus toggle — Alt+h/Alt+l, host server only
    ["bind-key", "-n", "M-h", "select-pane", "-t", "0.0"],
    ["bind-key", "-n", "M-l", "select-pane", "-t", "0.1"],
    // pane border labels
    ["set-option", "-g", "pane-border-status", "top"],
    ["set-option", "-g", "pane-border-format", " #{pane_title} "],
    ["select-pane", "-t", switcher, "-T", "switcher"],
    ["select-pane", "-t", main, "-T", "main"],
    ["select-pane", "-t", switcher],
    // status bar identity
    ["set-option", "-g", "status-left", " tmux-ide "],
  ].map(hostTmux);
}

/**
 * Whether the host session exists on the HOST socket.
 *
 * The tmux-bridge `hasSession` helper always targets the default socket, so
 * host existence is checked with raw `-L tmux-ide has-session` argv instead;
 * any error (no server yet, or session absent) means "not there".
 */
function hostSessionExists(): boolean {
  try {
    runTmux(hostTmux(["has-session", "-t", HOST_SESSION]));
    return true;
  } catch {
    return false;
  }
}

/**
 * Create-or-attach the host shell — on its OWN tmux socket (`-L tmux-ide`).
 *
 * If the host session already exists we simply re-attach to it. Otherwise we
 * build and configure the layout command-by-command and then attach. A build
 * failure kills the half-built session and surfaces a clear error rather than
 * leaving a broken session behind or failing silently. All operations here run
 * against the host server; the user's default-socket projects are never
 * touched.
 */
export function launchHostShell(opts: {
  repoRoot: string;
  switcherScript: string;
  userCwd: string;
  switcherWidth?: number;
}): void {
  if (hostSessionExists()) {
    runTmux(hostTmux(["attach", "-t", HOST_SESSION]), { stdio: "inherit" });
    return;
  }

  const commands = hostLayoutCommands({
    session: HOST_SESSION,
    repoRoot: opts.repoRoot,
    switcherScript: opts.switcherScript,
    userCwd: opts.userCwd,
    switcherWidth: opts.switcherWidth ?? DEFAULT_SWITCHER_WIDTH,
  });

  try {
    for (const argv of commands) {
      runTmux(argv);
    }
  } catch (error) {
    // Don't strand a partially-built session — tear it down so a retry starts
    // clean, then surface why the shell couldn't start.
    try {
      runTmux(hostTmux(["kill-session", "-t", HOST_SESSION]));
    } catch {
      // best-effort cleanup — the session may never have come up
    }
    throw new IdeError(
      `Could not start the tmux-ide host shell: ${(error as Error).message}`,
      { code: "HOST_SHELL_FAILED", cause: error as Error },
    );
  }

  runTmux(hostTmux(["attach", "-t", HOST_SESSION]), { stdio: "inherit" });
}
