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
import { DEFAULT_THEME, getAppConfig, type AppKeys, type AppTheme } from "../../lib/app-config.ts";
import type { AgentStatus } from "../detect/classify.ts";
import type { TeamProject } from "../team/projects.ts";
import { cheatsheetBindCommand, cheatsheetPopupCommand } from "./cheatsheet.ts";
import {
  menuBindCommand,
  menuPaneBindCommand,
  menuPaneUnbindCommand,
  menuStatusBindCommand,
  menuStatusUnbindCommand,
} from "./menu.ts";
import { PANEL_POPUPS, panelKey, panelPopupBindCommand } from "./panels.ts";
import { sidebarToggleBindCommand } from "./sidebar.ts";
import { maybeShowWelcomePopup } from "./welcome.ts";
import { maybeOfferIntegrationPopup } from "../integrations/offer.ts";
import { kittyEscapeFor, kittyUserKeyIndex, kittyUserKeyName } from "./kitty-keys.ts";
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
  // The home trigger floats the full fleet cockpit (the same M-h key opens) so
  // "get me back to the home screen" is discoverable from the dock, not just via
  // the key. Muted like `keys` — switch stays the dominant primary action.
  const homeTrigger = `#[range=user|home]#[fg=colour244][ ⌂ home ⌥h ]#[default]#[norange]`;
  const trigger = `#[range=user|switcher]#[fg=${theme.accent},bold][ ⧉ switch ⌥p ]#[default]#[norange]`;
  return `#[fg=${theme.accent},bold] tmux-ide #[default] ${body}#[align=right]${extra}${homeTrigger} ${keysTrigger} ${trigger} `;
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
 * The root-table key that floats the full fleet HOME cockpit: `M-h` (Alt+h).
 * Like {@link POPUP_KEY} it lives in the ROOT table so it fires without the
 * prefix from any adopted session. Where the switcher is the compact picker,
 * this opens the full two-column home (fleet tree + detail) as a large popup —
 * "get me home from anywhere", the first half of the discovery flow.
 */
export const HOME_KEY = "M-h";

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
// MouseUP, deliberately: the menu is built via a ~150ms CLI hop, so a DOWN bind
// opens it under a still-held button and the user's release lands on/near the
// fresh menu and dismisses it instantly (measured live; -O does not save it).
// Opening on release means no trailing button event exists to kill the menu.
export const MENU_STATUS_KEY = "MouseUp3Status";

/**
 * The root-table mouse key for a RIGHT-click on ANY pane body (not just the
 * chrome row): `MouseDown3Pane`. tmux fires this for a right-click landing inside
 * a pane, so the actions menu is reachable from anywhere — any pane, any session
 * — not only the dock row. Like {@link MENU_STATUS_KEY} it opens the same
 * `display-menu`. NOTE: a pane whose app grabs the mouse (vim, an agent TUI, …)
 * consumes the event before tmux sees it — graceful degradation, the `M-m` key
 * still opens the menu there.
 */
export const MENU_PANE_KEY = "MouseUp3Pane";

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
 * PURE — the `display-popup` command STRING that floats the full HOME cockpit
 * (shared by the M-h bind, the dock's `[ ⌂ home ⌥h ]` trigger, and the actions
 * menu's Home item, so all three open an identical popup). The bound command is
 * `tmux-ide team --popup`: the `--popup` flag tells the cockpit it's floating
 * over a tmux client, so — like the switcher popup — Enter `switch-client`s the
 * invoking client and closes instead of attaching in place. Large (95%×95%)
 * because it's the full two-column layout, not the compact picker.
 */
export function homePopupCommand(homeCmd = "tmux-ide team --popup"): string {
  return `display-popup -E -w 95% -h 95% "${homeCmd}"`;
}

/**
 * PURE — the tmux argv that binds {@link HOME_KEY} (`M-h`, root table) to the
 * home cockpit popup. Server-wide bind, mirroring the switcher's M-p — see the
 * note on {@link unadoptSession}. Idempotent: re-binding overwrites.
 */
export function homeBindCommand(homeCmd = "tmux-ide team --popup", key = HOME_KEY): string[] {
  return ["bind-key", "-n", key, "display-popup", "-E", "-w", "95%", "-h", "95%", homeCmd];
}

/** PURE — the tmux argv that removes the home key binding. */
export function homeUnbindCommand(key = HOME_KEY): string[] {
  return ["unbind-key", "-n", key];
}

/**
 * PURE — the `display-popup` command STRING for the dock's `⬆ v<latest>` update
 * chip (see {@link ./updater.ts updateSegment}). It runs `tmux-ide update
 * --dry-run` — which prints the exact command to run for THIS install (dev
 * checkout, npm/pnpm/bun global) — then holds the popup open until Enter so the
 * instruction is readable (a bare `-E` popup would close the instant the CLI
 * exits). Shell-portable: `read _` (no bash-only `-n1`), no backslash escapes.
 */
export function updatePopupCommand(updateCmd = "tmux-ide update --dry-run"): string {
  const shell = `${updateCmd}; echo ''; echo '[ press Enter to close ]'; read _`;
  return `display-popup -E -w 70% -h 50% "${shell}"`;
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
 *   - `home`          → the home-cockpit `display-popup` the M-h key runs.
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
  const home = homePopupCommand();
  const update = updatePopupCommand();
  // run-shell re-enters tmux with the name/client already format-expanded.
  const switchClient = `run-shell "tmux switch-client -c '#{client_name}' -t '#{s/^sw//:mouse_status_range}'"`;
  // `sw*` → switch, else window-list default. Its args are one level deep here.
  const swBranch = `if-shell -F "#{m:sw*,#{mouse_status_range}}" ${dq(switchClient)} "select-window -t ="`;
  // `keys` → cheat sheet, else the sw branch. Both args nest one level deeper,
  // so they're `dq`'d again — dequoting peels the layers off in order.
  const keysBranch = `if-shell -F "#{==:#{mouse_status_range},keys}" ${dq(cheatsheet)} ${dq(swBranch)}`;
  // `home` → the home cockpit popup, else the keys branch. One more nesting
  // level, so both args are `dq`'d once more on top of what they already carry.
  const homeBranch = `if-shell -F "#{==:#{mouse_status_range},home}" ${dq(home)} ${dq(keysBranch)}`;
  // `update` → the update-flow popup (the dock's `⬆ v<latest>` chip), else the
  // home branch. Another nesting level, so both args carry one more `dq` layer.
  const updateBranch = `if-shell -F "#{==:#{mouse_status_range},update}" ${dq(update)} ${dq(homeBranch)}`;
  return [
    "bind-key",
    "-n",
    STATUS_CLICK_KEY,
    "if-shell",
    "-F",
    "#{==:#{mouse_status_range},switcher}",
    popup,
    updateBranch,
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

/**
 * The root-table ALT-KEY binds adopt registers, as `(tmux key, bind argv)`
 * pairs, in a STABLE order: popup, home, cheat sheet, menu, sidebar, then the
 * panels. Threaded through ONE place so adopt, unadopt, AND the kitty-protocol
 * User-key fallbacks all agree — the bind argv's action (everything after
 * `bind-key -n <key>`) is reused verbatim for the `UserN` twin (see
 * {@link ./kitty-keys.ts}). The mouse binds (status-click / right-click) are
 * NOT here — they aren't Alt keys and need no kitty fallback.
 */
export function altKeyBinds(
  keys: AppKeys,
  switcherCmd = "tmux-ide switcher",
): Array<{ key: string; bind: string[] }> {
  return [
    { key: keys.popup, bind: popupBindCommand(switcherCmd, keys.popup) },
    { key: keys.home, bind: homeBindCommand("tmux-ide team --popup", keys.home) },
    { key: keys.cheatsheet, bind: cheatsheetBindCommand("tmux-ide cheatsheet", keys.cheatsheet) },
    { key: keys.menu, bind: menuBindCommand("tmux-ide menu", keys.menu) },
    { key: keys.sidebar, bind: sidebarToggleBindCommand("tmux-ide sidebar-toggle", keys.sidebar) },
    ...PANEL_POPUPS.map((panel) => {
      const key = panelKey(panel, keys.panels);
      return { key, bind: panelPopupBindCommand(panel, key) };
    }),
  ];
}

/**
 * Lowercase letters tmux binds by DEFAULT in the prefix table — deriving a
 * prefix twin must never clobber these (c/n/p window ops, m mark, s/w choosers,
 * o pane rotate, l last, d detach, x kill, z zoom, f find, i info, q display,
 * r refresh, t clock).
 */
const PREFIX_TAKEN = new Set([..."cdfilmnopqrstwxz"]);

/** Alt keys whose letter is taken get an explicit, documented prefix home. */
const PREFIX_REMAP: Record<string, string> = {
  "M-m": "u", // menu — m is mark-pane
  "M-p": "j", // switcher — p is previous-window; j = "jump"
  "M-,": "v", // config panel — , is rename-window
};

/**
 * PURE — the `prefix + <letter>` twins of every Alt-key action. The tmux PREFIX
 * survives every keyboard-protocol flavor (it's how you use tmux at all), so
 * these are the RELIABLE bindings — the Alt forms are the bonus for terminals
 * that deliver them. Same letter as the Alt key where tmux's defaults allow,
 * {@link PREFIX_REMAP} where they don't; anything unmappable is skipped.
 */
export function prefixKeyBinds(
  keys: AppKeys,
  switcherCmd = "tmux-ide switcher",
): Array<{ pkey: string; bind: string[] }> {
  const out: Array<{ pkey: string; bind: string[] }> = [];
  for (const { key, bind } of altKeyBinds(keys, switcherCmd)) {
    const remapped = PREFIX_REMAP[key];
    const letter = remapped ?? /^M-([a-z])$/.exec(key)?.[1];
    if (!letter || (!remapped && PREFIX_TAKEN.has(letter))) continue;
    out.push({ pkey: letter, bind: ["bind-key", "-T", "prefix", letter, ...bind.slice(3)] });
  }
  return out;
}

/**
 * Binds retired by newer chrome generations — adopt clears them so a server
 * that lived through an upgrade doesn't keep firing the old behavior alongside
 * the new (the menu moved from MouseDown3 to MouseUp3: with both bound, the
 * press opened a menu the release instantly killed).
 */
const LEGACY_BINDS: string[][] = [
  ["unbind-key", "-n", "MouseDown3Status"],
  ["unbind-key", "-n", "MouseDown3Pane"],
];

export function adoptSession(session: string, switcherCmd = "tmux-ide switcher"): void {
  for (const argv of adoptOptionCommands(session)) runTmux(argv);
  // Clear binds retired by newer chrome generations (best-effort).
  for (const legacy of LEGACY_BINDS) {
    try {
      runTmux(legacy);
    } catch {
      // nothing stale bound — fine
    }
  }
  // Key binds are configurable via ~/.tmux-ide/config.json (keys.*); re-adopting
  // after a config change rebinds them. Server-wide + idempotent (re-binding a
  // key just overwrites it).
  const keys = getAppConfig().keys;
  // The mouse binds: the status-click router and the two right-click menu
  // openers (chrome row + any pane body). Not Alt keys → no kitty fallback.
  runTmux(statusClickBindCommand(switcherCmd));
  runTmux(menuStatusBindCommand());
  runTmux(menuPaneBindCommand());
  // Every root-table Alt-key bind, PLUS a kitty-protocol User-key fallback so the
  // shortcut still fires when a focused Claude Code pane has the Kitty keyboard
  // protocol on (tmux 3.6 doesn't normalize the `ESC[<code>;3:1u` full form back
  // to `M-…`). The UserN twin runs the identical action argv (`bind.slice(3)` —
  // everything after `bind-key -n <key>`). See {@link ./kitty-keys.ts}.
  altKeyBinds(keys, switcherCmd).forEach(({ key, bind }, i) => {
    runTmux(bind);
    const escape = kittyEscapeFor(key);
    if (escape === null) return; // not an `M-<c>` key → no fallback
    const idx = kittyUserKeyIndex(i);
    runTmux(["set-option", "-s", `user-keys[${idx}]`, escape]);
    runTmux(["bind-key", "-n", kittyUserKeyName(i), ...bind.slice(3)]);
  });
  // The RELIABLE twins: prefix + letter for every action (the prefix survives
  // kitty/CSI-u keyboard protocols; Alt keys don't always).
  for (const { bind } of prefixKeyBinds(keys, switcherCmd)) runTmux(bind);
  // Seed the bar now so it's never blank, then make sure the loop that keeps it
  // fresh is up.
  seedSessionStatus(session);
  startUpdaterIfNeeded();
  // First-run: float the one-time welcome card on the adopting client (gated by
  // the marker file + config; best-effort, never blocks or fails the adopt).
  maybeShowWelcomePopup();
  // First-adopt: if Claude Code is on PATH but the integration isn't installed,
  // offer to install it (one-time, marker + config gated; best-effort — never
  // blocks or fails the adopt). See ../integrations/offer.ts.
  maybeOfferIntegrationPopup();
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
  // The mouse binds (status-click router + the two right-click menu openers).
  for (const undo of [
    statusClickUnbindCommand(),
    menuStatusUnbindCommand(),
    menuPaneUnbindCommand(),
  ]) {
    try {
      runTmux(undo);
    } catch {
      // no such key bound — nothing to undo
    }
  }
  // Every Alt-key bind AND its kitty User-key fallback + the user-keys slot,
  // walked in the SAME order adopt registered them so the slot indices line up.
  altKeyBinds(keys, "tmux-ide switcher").forEach(({ key }, i) => {
    try {
      runTmux(["unbind-key", "-n", key]);
    } catch {
      // no such key bound — nothing to undo
    }
    if (kittyEscapeFor(key) === null) return;
    try {
      runTmux(["unbind-key", "-n", kittyUserKeyName(i)]);
    } catch {
      // no such User key bound — nothing to undo
    }
    try {
      runTmux(["set-option", "-su", `user-keys[${kittyUserKeyIndex(i)}]`]);
    } catch {
      // no such user-keys slot set — nothing to undo
    }
  });
  for (const { pkey } of prefixKeyBinds(keys, "tmux-ide switcher")) {
    try {
      runTmux(["unbind-key", "-T", "prefix", pkey]);
    } catch {
      // not bound — nothing to undo
    }
  }
  // The updater only needs to run while something is adopted.
  if (listAdoptedSessions().length === 0) stopUpdater();
}
