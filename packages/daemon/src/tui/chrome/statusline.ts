/**
 * The tmux-ide status bar — native chrome.
 *
 * Instead of wrapping or re-rendering tmux, tmux-ide renders itself INTO
 * tmux's own status line: `adoptSession` gives a session a second status row
 * whose content comes from `tmux-ide statusline` (invoked by tmux via `#()`
 * every `status-interval`). The row lists every project/session with a live
 * agent-state glyph and persists no matter which pane has focus — tmux draws
 * the chrome, so there's no nesting and the user's real sessions stay
 * untouched otherwise.
 *
 * `buildStatusline` is pure (tested); the io wrappers are thin.
 */
import { runTmux } from "@tmux-ide/tmux-bridge";
import type { AgentStatus } from "../detect/classify.ts";
import type { TeamProject } from "../team/projects.ts";
import { cheatsheetBindCommand, cheatsheetUnbindCommand } from "./cheatsheet.ts";

/** tmux style markup per status — chrome-row colors for the state glyphs. */
const STATUS_STYLE: Record<AgentStatus, string> = {
  blocked: "#[fg=colour203,bold]",
  working: "#[fg=colour221]",
  done: "#[fg=colour111]",
  idle: "#[fg=colour114]",
  unknown: "#[fg=colour244]",
};

const GLYPH: Record<AgentStatus, string> = {
  blocked: "●",
  working: "●",
  done: "●",
  idle: "●",
  unknown: "·",
};

/**
 * Whether a name is INTERNAL — the host shell (`_tmux-ide`) and any
 * `_`-prefixed scratch/plumbing session. Internal names are hidden from both
 * the status bar and the switcher: they're infrastructure, not projects.
 */
export function isInternalName(name: string): boolean {
  return name.startsWith("_");
}

/**
 * Build the status-bar string with tmux `#[...]` markup.
 *
 * One segment per entry: running projects show their rolled-up status glyph;
 * stopped registered projects show a muted `○`. The `active` session's
 * segment is highlighted (bold + underscore) so you can see where you are.
 * `maxItems` caps the segment count (tmux clips overflow anyway; capping
 * keeps the useful part visible).
 *
 * Interactivity (tmux status-line mouse ranges — see {@link statusClickBindCommand}):
 *   - Each RUNNING project is wrapped in a `#[range=user|sw<session>]…#[norange]`
 *     range keyed by its first live session, so a click switches to it. The
 *     prefix is a bare `sw` (NO colon): a `:` inside the `#{s/^sw//:…}` used to
 *     extract the session name is swallowed by tmux's modifier parser (verified
 *     live — the extraction yields ""). Stopped projects stay un-ranged (they'd
 *     need a launch flow to click — out of scope).
 *   - A right-aligned `switcher` TRIGGER button ends the row so the popup is
 *     discoverable from the footer, not just via the M-p key.
 */
export function buildStatusline(
  projects: TeamProject[],
  active: string | null,
  maxItems = 12,
): string {
  const visible = projects.filter((p) => !isInternalName(p.name));
  const segments: string[] = [];
  for (const project of visible.slice(0, maxItems)) {
    const isActive =
      active !== null &&
      (project.name === active || project.sessions.some((s) => s.name === active));
    const glyph = project.running
      ? `${STATUS_STYLE[project.status]}${GLYPH[project.status]}#[default]`
      : "#[fg=colour240]○#[default]";
    const name = isActive
      ? `#[fg=colour231,bold,underscore]${project.name}#[default]`
      : project.running
        ? `#[fg=colour250]${project.name}#[default]`
        : `#[fg=colour240]${project.name}#[default]`;
    const label = `${glyph} ${name}`;
    // Only running projects are clickable — wrap them in a session-keyed range.
    const session = project.sessions[0]?.name;
    segments.push(
      project.running && session ? `#[range=user|sw${session}]${label}#[norange]` : label,
    );
  }
  if (visible.length > maxItems) {
    segments.push(`#[fg=colour240]+${visible.length - maxItems}#[default]`);
  }
  const body = segments.join("  ");
  // Two button-like, right-aligned triggers. `keys` (muted) floats the cheat
  // sheet; `switcher` (primary) opens the picker popup — switch stays visually
  // dominant, the sheet is the quieter companion just to its left.
  const keysTrigger = `#[range=user|keys]#[fg=colour244][ ? keys ]#[default]#[norange]`;
  const trigger = `#[range=user|switcher]#[fg=colour75,bold][ ⧉ switch ⌥p ]#[default]#[norange]`;
  return `#[fg=colour75,bold] tmux-ide #[default] ${body}#[align=right]${keysTrigger} ${trigger} `;
}

/**
 * The root-table key that opens the floating switcher popup. Chosen to avoid
 * tmux defaults: `M-p` (Alt+p) is unbound by stock tmux, and — unlike prefix
 * `p` (previous-window) — it lives in the ROOT table so it fires without the
 * prefix from any adopted session. Alt-letter keys are directional/rare in
 * terminal apps, so grabbing one at the root is low-collision.
 */
export const POPUP_KEY = "M-p";

/**
 * PURE — the tmux argv that binds the popup key: `M-p` opens a `display-popup`
 * running the compact switcher, which `switch-client`s you to whatever you
 * pick and then exits (closing the popup).
 *
 * The bound command is just `<switcherCmd>` (default `tmux-ide switcher`). We
 * deliberately do NOT append `--client '#{client_name}'`: on tmux 3.6 a
 * `#{...}` format in a `display-popup -E` command argument is NOT expanded at
 * invocation (verified live — the literal string survives to the shell). The
 * switcher instead resolves its own invoking client from inside the popup via
 * `tmux display-message -p '#{client_name}'`, which DOES resolve correctly, and
 * switches with an explicit `-c <client>`.
 *
 * Bindings are SERVER-wide (there is no per-session `bind-key`), so this is a
 * global root-table bind — see the note on {@link unadoptSession}.
 */
export function popupBindCommand(switcherCmd = "tmux-ide switcher"): string[] {
  return [
    "bind-key",
    "-n",
    POPUP_KEY,
    "display-popup",
    "-E",
    "-w",
    "80%",
    "-h",
    "60%",
    switcherCmd,
  ];
}

/** PURE — the tmux argv that removes the popup key binding. */
export function popupUnbindCommand(): string[] {
  return ["unbind-key", "-n", POPUP_KEY];
}

/**
 * The root-table mouse key that routes clicks on the status bar. tmux fires
 * this for a click landing on a NAMED range in any status line (our chrome
 * row's `user|…` ranges), exposing the range name via `#{mouse_status_range}`.
 */
export const STATUS_CLICK_KEY = "MouseDown1Status";

/**
 * Wrap a tmux command string as a double-quoted argument for embedding ONE
 * level deeper: escape backslashes first, then double quotes. Composable — the
 * innermost command can be `dq`'d once per nesting level and each layer's
 * dequote peels exactly one level off (verified live), which is what lets the
 * dispatch chain nest `keys → sw*` without hand-counting escapes.
 */
function dq(cmd: string): string {
  return `"${cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * PURE — the tmux argv that binds status-bar clicks (server-wide, root table).
 *
 * Dispatch is on `#{mouse_status_range}` (the `#[range=user|<name>]` under the
 * click, surfaced as `<name>`), a nested if-shell chain:
 *   - `switcher`      → the SAME `display-popup` the M-p key runs.
 *   - `keys`          → the cheat-sheet `display-popup` the M-k key runs.
 *   - `sw<session>`   → switch the clicking client to `<session>`.
 *   - anything else   → tmux's default `select-window -t =` (window-list clicks
 *                       on the primary status line keep working).
 *
 * WHY run-shell for the switch (verified live on tmux 3.6):
 *   - A `switch-client -t <target>` target is NOT format-expanded — passing
 *     `-t "#{…}"` fails with `can't find session: #{…}`. So the session name
 *     can't be handed to `switch-client` as a format directly.
 *   - `run-shell` DOES expand `#{…}` in its command, so it re-invokes
 *     `tmux switch-client` with the name already extracted via
 *     `#{s/^sw//:mouse_status_range}` and the clicking client from
 *     `#{client_name}`.
 *
 * The two popup branches stay tmux-native (identical to {@link popupBindCommand}
 * / {@link cheatsheetBindCommand}), so a click behaves exactly like M-p / M-k.
 * The `sw*` branch nests one level under `keys`, so its inner commands are
 * `dq`'d twice — the chain stays balanced (see {@link dq}).
 *
 * SERVER-wide bind — tmux has no per-session key table — so this replaces the
 * global `MouseDown1Status` for every client (same caveat as the M-p popup key;
 * see {@link unadoptSession}). Idempotent: re-binding overwrites.
 */
export function statusClickBindCommand(
  switcherCmd = "tmux-ide switcher",
  cheatsheetCmd = "tmux-ide cheatsheet",
): string[] {
  const popup = `display-popup -E -w 80% -h 60% "${switcherCmd}"`;
  const cheatsheet = `display-popup -E -w 90% -h 80% "${cheatsheetCmd}"`;
  // run-shell re-enters tmux with the name/client already format-expanded.
  const switchClient = `run-shell "tmux switch-client -c '#{client_name}' -t '#{s/^sw//:mouse_status_range}'"`;
  // `sw*` → switch, else window-list default. Its args are one level deep here.
  const swBranch = `if-shell -F "#{m:sw*,#{mouse_status_range}}" ${dq(switchClient)} "select-window -t ="`;
  // `keys` → cheat sheet, else the sw branch. Both args nest one level deeper,
  // so they're `dq`'d again — dequoting peels the layers off in order.
  const keysBranch = `if-shell -F "#{==:#{mouse_status_range},keys}" ${dq(cheatsheet)} ${dq(swBranch)}`;
  return [
    "bind-key",
    "-n",
    STATUS_CLICK_KEY,
    "if-shell",
    "-F",
    "#{==:#{mouse_status_range},switcher}",
    popup,
    keysBranch,
  ];
}

/** PURE — the tmux argv that removes the status-click binding. */
export function statusClickUnbindCommand(): string[] {
  return ["unbind-key", "-n", STATUS_CLICK_KEY];
}

/**
 * Adopt a session: add the chrome row (status line 2) that shells out to
 * `tmux-ide statusline` every 2s, and bind the popup key so `M-p` opens the
 * floating switcher from anywhere in the session. Status options are set
 * per-session (`-t`) so only adopted sessions change; the key bind is
 * server-wide (tmux has no per-session bind). `unadoptSession` reverses both.
 */
export function adoptSession(
  session: string,
  statuslineCmd = "tmux-ide statusline",
  switcherCmd = "tmux-ide switcher",
): void {
  const format = `#[align=left]#(${statuslineCmd} --active '#{session_name}')`;
  runTmux(["set-option", "-t", session, "status", "2"]);
  runTmux(["set-option", "-t", session, "status-interval", "2"]);
  runTmux(["set-option", "-t", session, "status-format[1]", format]);
  // Status-line clicks need mouse mode ON for this session. NOTE: this also
  // changes scroll behavior for the session (the wheel enters copy-mode /
  // scrolls the pane history instead of the terminal's native scrollback).
  // Per-session (`-t`) so only adopted sessions are affected.
  runTmux(["set-option", "-t", session, "mouse", "on"]);
  // Server-wide binds, idempotent (re-binding the same key just overwrites it):
  // the M-p popup, the M-k cheat sheet, and the status-bar click router.
  runTmux(popupBindCommand(switcherCmd));
  runTmux(cheatsheetBindCommand());
  runTmux(statusClickBindCommand(switcherCmd));
}

/** Remove the chrome row from a session (revert to inherited options). */
export function unadoptSession(session: string): void {
  runTmux(["set-option", "-u", "-t", session, "status"]);
  runTmux(["set-option", "-u", "-t", session, "status-interval"]);
  runTmux(["set-option", "-u", "-t", session, "status-format[1]"]);
  runTmux(["set-option", "-u", "-t", session, "mouse"]);
  // KNOWN SIMPLIFICATION: the popup key AND the status-click router are
  // SERVER-wide binds, so unadopting one session removes them for ALL adopted
  // sessions. Acceptable for now — best-effort so a missing bind (already
  // unadopted) doesn't throw.
  try {
    runTmux(popupUnbindCommand());
  } catch {
    // no such key bound — nothing to undo
  }
  try {
    runTmux(cheatsheetUnbindCommand());
  } catch {
    // no such key bound — nothing to undo
  }
  try {
    runTmux(statusClickUnbindCommand());
  } catch {
    // no such key bound — nothing to undo
  }
}
