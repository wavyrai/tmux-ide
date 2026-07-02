/**
 * The tmux-ide status bar — native chrome.
 *
 * Instead of wrapping or re-rendering tmux, tmux-ide renders itself INTO
 * tmux's own status line: `adoptSession` gives a session a second status row
 * whose content is a pre-rendered `@tmux_ide_status` user option that a single
 * background updater ({@link ./updater.ts}) keeps fresh — the bar reads a bare
 * `#{@tmux_ide_status}`, so tmux spawns nothing per tick. The row lists every
 * project/session with a live agent-state glyph and persists no matter which
 * pane has focus — tmux draws the chrome, so there's no nesting and the user's
 * real sessions stay untouched otherwise.
 *
 * `buildStatusline` is pure (tested); the io wrappers are thin.
 */
import { runTmux } from "@tmux-ide/tmux-bridge";
import { DEFAULT_THEME, getAppConfig, type AppTheme } from "../../lib/app-config.ts";
import type { AgentStatus } from "../detect/classify.ts";
import type { TeamProject } from "../team/projects.ts";
import {
  cheatsheetBindCommand,
  cheatsheetPopupCommand,
  cheatsheetUnbindCommand,
} from "./cheatsheet.ts";
import {
  menuBindCommand,
  menuPaneBindCommand,
  menuPaneUnbindCommand,
  menuStatusBindCommand,
  menuStatusUnbindCommand,
  menuUnbindCommand,
} from "./menu.ts";
import {
  ADOPTED_OPTION,
  CHIP_OPTION,
  listAdoptedSessions,
  seedSessionStatus,
  startUpdaterIfNeeded,
  STATUS_OPTION,
  stopUpdater,
} from "./updater.ts";

/**
 * PURE — tmux style markup for a status color token. `blocked` reads bold (an
 * urgency cue kept from the original STATUS_STYLE); every other state is a plain
 * `#[fg=…]`. Shared with the pane chip ({@link ./chip.ts}) so a chip matches its
 * session's rollup glyph.
 */
export function statusStyle(status: AgentStatus, theme: AppTheme): string {
  const color = theme.status[status];
  return status === "blocked" ? `#[fg=${color},bold]` : `#[fg=${color}]`;
}

/**
 * PURE — the glyph character for a running project's state: the filled `active`
 * token for a known state, but `·` for `unknown` (a "no signal" marker with no
 * token of its own).
 */
export function statusGlyph(status: AgentStatus, theme: AppTheme): string {
  return status === "unknown" ? "·" : theme.glyphs.active;
}

/**
 * Whether a name is INTERNAL — the host shell (`_tmux-ide`) and any
 * `_`-prefixed scratch/plumbing session. Internal names are hidden from both
 * the status bar and the switcher: they're infrastructure, not projects.
 */
export function isInternalName(name: string): boolean {
  return name.startsWith("_");
}

/**
 * PURE — the session names `adopt --all` should adopt: every live session that
 * isn't internal (`_`-prefixed plumbing like the updater/scratch sessions).
 */
export function adoptableSessionNames(names: string[]): string[] {
  return names.filter((name) => name.length > 0 && !isInternalName(name));
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
  theme: AppTheme = DEFAULT_THEME,
  extraSegment = "",
): string {
  const visible = projects.filter((p) => !isInternalName(p.name));
  const segments: string[] = [];
  for (const project of visible.slice(0, maxItems)) {
    const isActive =
      active !== null &&
      (project.name === active || project.sessions.some((s) => s.name === active));
    const glyph = project.running
      ? `${statusStyle(project.status, theme)}${statusGlyph(project.status, theme)}#[default]`
      : `#[fg=${theme.muted}]${theme.glyphs.inactive}#[default]`;
    const name = isActive
      ? `#[fg=colour231,bold,underscore]${project.name}#[default]`
      : project.running
        ? `#[fg=${theme.fg}]${project.name}#[default]`
        : `#[fg=${theme.muted}]${project.name}#[default]`;
    const label = `${glyph} ${name}`;
    // Only running projects are clickable — wrap them in a session-keyed range.
    const session = project.sessions[0]?.name;
    segments.push(
      project.running && session ? `#[range=user|sw${session}]${label}#[norange]` : label,
    );
  }
  if (visible.length > maxItems) {
    segments.push(`#[fg=${theme.muted}]+${visible.length - maxItems}#[default]`);
  }
  const body = segments.join("  ");
  // A reserved right-side slot the update-flow card (0047) feeds "⬆ vX.Y.Z"
  // through; empty by default so it takes no space. Sits before the triggers.
  const extra = extraSegment ? `${extraSegment} ` : "";
  // Two button-like, right-aligned triggers. `keys` (muted) floats the cheat
  // sheet; `switcher` (primary) opens the picker popup — switch stays visually
  // dominant, the sheet is the quieter companion just to its left.
  const keysTrigger = `#[range=user|keys]#[fg=colour244][ ? keys ]#[default]#[norange]`;
  const trigger = `#[range=user|switcher]#[fg=${theme.accent},bold][ ⧉ switch ⌥p ]#[default]#[norange]`;
  return `#[fg=${theme.accent},bold] tmux-ide #[default] ${body}#[align=right]${extra}${keysTrigger} ${trigger} `;
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
 * The root-table key that opens the right-click actions menu: `M-m` (Alt+m).
 * Like {@link POPUP_KEY} it lives in the ROOT table so it fires without the
 * prefix from any adopted session, and sits with `M-p`/`M-k` as the third chrome
 * shortcut. The menu itself is drawn by tmux's `display-menu` (see ./menu.ts).
 */
export const MENU_KEY = "M-m";

/**
 * The root-table mouse key for a RIGHT-click on the status bar. tmux fires this
 * for a right-click landing anywhere on a status line; the menu is
 * range-independent (unlike the left-click router — see {@link STATUS_CLICK_KEY}),
 * so it opens the same actions menu regardless of what's under the click.
 */
export const MENU_STATUS_KEY = "MouseDown3Status";

/**
 * The root-table mouse key for a RIGHT-click on ANY pane body (not just the
 * chrome row): `MouseDown3Pane`. tmux fires this for a right-click landing inside
 * a pane, so the actions menu is reachable from anywhere — any pane, any session
 * — not only the dock row. Like {@link MENU_STATUS_KEY} it opens the same
 * `display-menu`. NOTE: a pane whose app grabs the mouse (vim, an agent TUI, …)
 * consumes the event before tmux sees it — graceful degradation, the `M-m` key
 * still opens the menu there.
 */
export const MENU_PANE_KEY = "MouseDown3Pane";

/**
 * PURE — the `display-popup` command STRING that floats the switcher (shared by
 * the M-p bind, the bar's left-click router, and the actions menu's "Switch
 * session…" item, so all three open an identical popup). Mirror of the sizing in
 * {@link popupBindCommand}.
 */
export function switcherPopupCommand(switcherCmd = "tmux-ide switcher"): string {
  return `display-popup -E -w 80% -h 60% "${switcherCmd}"`;
}

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
export function popupBindCommand(switcherCmd = "tmux-ide switcher", key = POPUP_KEY): string[] {
  return ["bind-key", "-n", key, "display-popup", "-E", "-w", "80%", "-h", "60%", switcherCmd];
}

/** PURE — the tmux argv that removes the popup key binding. */
export function popupUnbindCommand(key = POPUP_KEY): string[] {
  return ["unbind-key", "-n", key];
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
  const popup = switcherPopupCommand(switcherCmd);
  const cheatsheet = cheatsheetPopupCommand(cheatsheetCmd);
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
 * Adopt a session: add the chrome row (status line 2) that renders the
 * pre-computed `@tmux_ide_status` var (a bare `#{…}` read — tmux spawns
 * nothing per tick; a single background updater keeps the var fresh), bind the
 * popup key so `M-p` opens the floating switcher from anywhere in the session,
 * mark the session adopted, seed its bar immediately, and make sure the updater
 * loop is running. Status/marker options are set per-session (`-t`) so only
 * adopted sessions change; the key binds are server-wide (tmux has no
 * per-session bind). `unadoptSession` reverses all of it.
 *
 * The var form is plain `#{@tmux_ide_status}` (not `#{E:…}`): styles (`#[…]`)
 * are parsed at draw time, so the stored markup renders its colors directly and
 * the `E:` re-expansion buys nothing but a double-`#` hazard (verified live on
 * tmux 3.6 — both forms render identically, so the simpler one wins).
 */
/**
 * PURE — the per-session `set-option` argv adopt applies: the second status row
 * (which renders the pre-computed `@tmux_ide_status` var — a bare `#{…}` read,
 * no per-tick spawn), mouse mode for status clicks, and the adopted marker the
 * updater enumerates by. All `-t <session>` so only adopted sessions change.
 */
export function adoptOptionCommands(session: string): string[][] {
  const format = `#[align=left]#{${STATUS_OPTION}}`;
  // Per-pane agent chip on the bottom border: render `@tmux_ide_chip` (kept
  // fresh by the updater) when set, else fall back to the pane title. NOTE:
  // tmux hides pane borders when a window has only ONE pane, so a chip only
  // shows once a window has been split — acceptable (there's no border to paint
  // in a single-pane window).
  const borderFormat = ` #{?#{${CHIP_OPTION}},#{${CHIP_OPTION}},#{pane_title}} `;
  return [
    ["set-option", "-t", session, "status", "2"],
    ["set-option", "-t", session, "status-interval", "2"],
    ["set-option", "-t", session, "status-format[1]", format],
    // Status-line clicks need mouse mode ON. NOTE: this also changes scroll
    // behavior (the wheel enters copy-mode / scrolls pane history instead of the
    // terminal's native scrollback). Per-session (`-t`) so only adopted change.
    ["set-option", "-t", session, "mouse", "on"],
    // Per-pane agent chips on the bottom border (see borderFormat above).
    ["set-option", "-t", session, "pane-border-status", "bottom"],
    ["set-option", "-t", session, "pane-border-format", borderFormat],
    // Marker the updater enumerates by (readable in list-sessions -F formats).
    ["set-option", "-t", session, ADOPTED_OPTION, "1"],
  ];
}

/**
 * PURE — the per-session `set-option -u` argv unadopt applies: revert the status
 * row/mouse to inherited, and drop the adopted marker + status var.
 */
export function unadoptOptionCommands(session: string): string[][] {
  return [
    ["set-option", "-u", "-t", session, "status"],
    ["set-option", "-u", "-t", session, "status-interval"],
    ["set-option", "-u", "-t", session, "status-format[1]"],
    ["set-option", "-u", "-t", session, "mouse"],
    ["set-option", "-u", "-t", session, "pane-border-status"],
    ["set-option", "-u", "-t", session, "pane-border-format"],
    ["set-option", "-u", "-t", session, ADOPTED_OPTION],
    ["set-option", "-u", "-t", session, STATUS_OPTION],
  ];
}

export function adoptSession(session: string, switcherCmd = "tmux-ide switcher"): void {
  for (const argv of adoptOptionCommands(session)) runTmux(argv);
  // Key binds are configurable via ~/.tmux-ide/config.json (keys.*); re-adopting
  // after a config change rebinds them. Server-wide + idempotent (re-binding a
  // key just overwrites it): the popup, the cheat sheet, and the click router.
  const keys = getAppConfig().keys;
  runTmux(popupBindCommand(switcherCmd, keys.popup));
  runTmux(cheatsheetBindCommand("tmux-ide cheatsheet", keys.cheatsheet));
  runTmux(statusClickBindCommand(switcherCmd));
  // The actions menu: the configured menu key, a right-click on the chrome row
  // (MouseDown3Status), and a right-click on ANY pane body (MouseDown3Pane) all
  // open tmux's native display-menu, rebuilt live by the `menu` CLI command — so
  // the menu is reachable from anywhere, not just the dock row.
  runTmux(menuBindCommand("tmux-ide menu", keys.menu));
  runTmux(menuStatusBindCommand());
  runTmux(menuPaneBindCommand());
  // Seed the bar now so it's never blank, then make sure the loop that keeps it
  // fresh is up.
  seedSessionStatus(session);
  startUpdaterIfNeeded();
}

/**
 * Remove the chrome row from a session (revert to inherited options), drop the
 * adopted marker + status var, and stop the background updater when this was the
 * LAST adopted session.
 */
export function unadoptSession(session: string): void {
  for (const argv of unadoptOptionCommands(session)) runTmux(argv);
  // KNOWN SIMPLIFICATION: the popup key AND the status-click router are
  // SERVER-wide binds, so unadopting one session removes them for ALL adopted
  // sessions. Acceptable for now — best-effort so a missing bind (already
  // unadopted) doesn't throw. Unbind the SAME configured keys adopt bound.
  const keys = getAppConfig().keys;
  try {
    runTmux(popupUnbindCommand(keys.popup));
  } catch {
    // no such key bound — nothing to undo
  }
  try {
    runTmux(cheatsheetUnbindCommand(keys.cheatsheet));
  } catch {
    // no such key bound — nothing to undo
  }
  try {
    runTmux(statusClickUnbindCommand());
  } catch {
    // no such key bound — nothing to undo
  }
  try {
    runTmux(menuUnbindCommand(keys.menu));
  } catch {
    // no such key bound — nothing to undo
  }
  try {
    runTmux(menuStatusUnbindCommand());
  } catch {
    // no such key bound — nothing to undo
  }
  try {
    runTmux(menuPaneUnbindCommand());
  } catch {
    // no such key bound — nothing to undo
  }
  // The updater only needs to run while something is adopted.
  if (listAdoptedSessions().length === 0) stopUpdater();
}
