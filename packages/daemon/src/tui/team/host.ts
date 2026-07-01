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
import { attachSession, hasSession, killSession, runTmux } from "@tmux-ide/tmux-bridge";
import { shellEscape } from "../../lib/shell.ts";
import { IdeError } from "../../lib/errors.ts";

/**
 * Name of the host session. The leading underscore marks it reserved so it
 * can't collide with a real project literally named "tmux-ide", and the
 * switcher filters this exact name out of its session list.
 */
export const HOST_SESSION = "_tmux-ide";

/** Default width, in columns, of the switcher pane. */
const DEFAULT_SWITCHER_WIDTH = 34;

/**
 * The shell command that runs the switcher in a tmux pane.
 *
 * The switcher is a bun `.tsx` that needs the repo-root `bunfig.toml` preload,
 * so it must be spawned FROM the repo root; the user's real invocation dir is
 * forwarded via `TMUX_IDE_CWD` so in-widget prompts still default to where the
 * user actually is. All three paths are shell-escaped.
 */
export function switcherPaneCommand(
  repoRoot: string,
  switcherScript: string,
  userCwd: string,
): string {
  return `cd ${shellEscape(repoRoot)} && TMUX_IDE_CWD=${shellEscape(userCwd)} bun ${shellEscape(switcherScript)}`;
}

/**
 * Ordered tmux argv arrays that build the host layout from scratch:
 *
 *   1. new-session -d — the session, its first pane running the switcher,
 *      started in the repo root.
 *   2. split-window -h — the main pane (a shell) started in the user's cwd,
 *      to the RIGHT of the switcher.
 *   3. resize-pane -x — pin the switcher pane to `switcherWidth` columns.
 *   4. select-pane — focus back on the switcher.
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
  const switcherCmd = switcherPaneCommand(repoRoot, switcherScript, userCwd);

  return [
    ["new-session", "-d", "-s", session, "-c", repoRoot, switcherCmd],
    ["split-window", "-h", "-t", switcher, "-c", userCwd],
    ["resize-pane", "-t", switcher, "-x", String(switcherWidth)],
    ["select-pane", "-t", switcher],
  ];
}

/**
 * Create-or-attach the host shell.
 *
 * If the host session already exists we simply re-attach to it. Otherwise we
 * build the layout command-by-command and then attach. A build failure kills
 * the half-built session and surfaces a clear error rather than leaving a
 * broken session behind or failing silently.
 */
export function launchHostShell(opts: {
  repoRoot: string;
  switcherScript: string;
  userCwd: string;
  switcherWidth?: number;
}): void {
  if (hasSession(HOST_SESSION)) {
    attachSession(HOST_SESSION);
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
    killSession(HOST_SESSION);
    throw new IdeError(
      `Could not start the tmux-ide host shell: ${(error as Error).message}`,
      { code: "HOST_SHELL_FAILED", cause: error as Error },
    );
  }

  attachSession(HOST_SESSION);
}
