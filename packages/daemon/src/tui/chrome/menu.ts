/**
 * The tmux-ide right-click actions menu — native chrome.
 *
 * Right-clicking the chrome row (or pressing `⌥m` on an adopted session) floats
 * tmux's own `display-menu`: a small popup of tmux-ide actions (switch session,
 * cheat sheet, jump to any live session, new session, kill session). tmux draws
 * the whole thing — there is no OpenTUI/bun boot and no per-tick cost — so this
 * module only produces the argument vector.
 *
 * The menu content is LIVE (the session list changes), so it can't be baked into
 * a static bind. Instead the bind runs our CLI via `run-shell`, and the CLI
 * rebuilds the menu args fresh and hands them to `tmux display-menu -c <client>`
 * (see the `menu` case in bin/cli.ts). This mirrors how the switcher/cheat-sheet
 * popups defer their content to a fresh CLI invocation.
 *
 * `buildMenu` and the bind/unbind command builders are PURE (tested); the CLI
 * `menu` command wires the io (resolve the client, run display-menu).
 */
import { DEFAULT_THEME, type AppTheme } from "../../lib/app-config.ts";
import type { AgentStatus } from "../detect/classify.ts";
import { switcherPopupCommand, MENU_KEY, MENU_PANE_KEY, MENU_STATUS_KEY } from "./statusline.ts";
import { cheatsheetPopupCommand } from "./cheatsheet.ts";
import { PANEL_POPUPS, panelPopupCommand } from "./panels.ts";

/** Single-char menu mnemonics for the panel rows (parallel to PANEL_POPUPS). */
const PANEL_MENU_KEYS = ["e", "g", ","];

/**
 * PURE — glyph + tmux colour per status for the menu's session rows, from the
 * shared theme tokens. Colours are `theme.status.*` (working amber, blocked red,
 * done blue, idle green). `idle` uses the hollow `inactive` glyph so a quiet
 * session reads as "nothing running" at a glance; `unknown` uses the `·` "no
 * signal" marker; everything else the filled `active` glyph.
 */
function menuGlyph(status: AgentStatus, theme: AppTheme): { glyph: string; colour: string } {
  const glyph =
    status === "idle" ? theme.glyphs.inactive : status === "unknown" ? "·" : theme.glyphs.active;
  return { glyph, colour: theme.status[status] };
}

/** Max session rows the menu lists (keys 1..8). Extra sessions are dropped. */
const MAX_SESSION_ITEMS = 8;

/**
 * Quote a session name for embedding in a tmux command string (the target of a
 * menu item's `switch-client -t <name>`). Single-quote it and escape any embedded
 * single quote the shell way (`'\''`) — tmux's lexer builds words like the shell,
 * so this keeps a weird name (spaces, `;`, `#`, `$`) inert instead of leaking as
 * extra command tokens. Verified live on tmux 3.6.
 */
export function menuQuoteName(name: string): string {
  return `'${name.replace(/'/g, `'\\''`)}'`;
}

/** The styled `#[fg=…]glyph#[default] name` label for a session row. */
function sessionLabel(session: { name: string; status: AgentStatus }, theme: AppTheme): string {
  const g = menuGlyph(session.status, theme);
  return `#[fg=${g.colour}]${g.glyph}#[default] ${session.name}`;
}

/**
 * PURE — the `display-menu` argument vector (everything AFTER `display-menu`,
 * minus the runtime `-c <client>`/placement flags the CLI prepends): a
 * `tmux-ide` title, then four groups joined by separator lines —
 *
 *   1. `⧉ Switch session…` (s) → the same switcher popup M-p / the bar trigger
 *      opens; `? Cheat sheet` (k) → the same cheat-sheet popup M-k opens. Both
 *      reuse the exact popup command strings so a menu pick behaves identically.
 *   2. the widget PANELS (Files e / Changes g / Config ,) → the same floating
 *      `display-popup` each panel's root-table key opens (see ./panels.ts).
 *   3. up to 8 live sessions, each `«glyph» <name>` keyed 1..8 →
 *      `switch-client -t <name>` (the name quoted so odd names stay inert). The
 *      menu commands run in the client that opened the menu, so the switch lands
 *      on the right client.
 *   4. `＋ New session…` (n) → a `command-prompt` that creates + switches to a
 *      named session; `✕ Kill this session` (x) → a confirmed `kill-session`.
 *
 * A separator is a single empty-string argument (tmux's display-menu convention).
 * Empty groups (no sessions) collapse so two separators never stack.
 */
export function buildMenu(
  sessions: Array<{ name: string; status: AgentStatus }>,
  theme: AppTheme = DEFAULT_THEME,
): string[] {
  const header: string[] = [
    "⧉ Switch session…",
    "s",
    switcherPopupCommand(),
    "? Cheat sheet",
    "k",
    cheatsheetPopupCommand(),
    "▏ Toggle sidebar",
    "b",
    // run-shell format-expands #{session_name}, so the toggle targets whatever
    // session the opening client is viewing (bind args don't expand; run-shell
    // does — the same trick the menu bind itself uses).
    `run-shell "tmux-ide sidebar-toggle --session '#{session_name}'"`,
  ];

  // The widget panels — each row opens the same floating popup its root-table
  // key does (esc/q closes). Menu commands run in the opening client, so the
  // popup lands on its pane's cwd.
  const panelItems: string[] = [];
  PANEL_POPUPS.forEach((panel, i) => {
    panelItems.push(panel.label, PANEL_MENU_KEYS[i] ?? "", panelPopupCommand(panel));
  });

  const sessionItems: string[] = [];
  sessions.slice(0, MAX_SESSION_ITEMS).forEach((session, i) => {
    sessionItems.push(
      sessionLabel(session, theme),
      String(i + 1),
      `switch-client -t ${menuQuoteName(session.name)}`,
    );
  });

  const footer: string[] = [
    "＋ New session…",
    "n",
    `command-prompt -p "new session name:" "new-session -d -s '%%' ; switch-client -t '%%'"`,
    "✕ Kill this session",
    "x",
    `confirm-before -p "kill session #S? (y/n)" kill-session`,
  ];

  // Join non-empty groups with a single separator line between them.
  const items: string[] = [];
  for (const group of [header, panelItems, sessionItems, footer]) {
    if (group.length === 0) continue;
    if (items.length > 0) items.push(""); // separator
    items.push(...group);
  }
  return ["-T", "tmux-ide", ...items];
}

// Re-export the key constants (defined in statusline.ts alongside POPUP_KEY so
// the cheat sheet can list them without importing this module) for callers that
// reach for them via the menu module.
export { MENU_KEY, MENU_PANE_KEY, MENU_STATUS_KEY };

/**
 * The tmux command run by every menu bind: invoke our CLI to (re)build and show
 * the menu. `run-shell` format-expands `#{client_name}` into `--client` (bind
 * args themselves do NOT expand; run-shell DOES — verified live on tmux 3.6), and
 * `-b` detaches so tmux's key/mouse dispatch isn't blocked while the menu is open.
 * The CLI resolves the client from `--client`, falling back to the
 * most-recently-active attached client, and runs display-menu (all tmux calls
 * time-capped so the bind can never hang).
 */
function menuRunShellArgs(menuCmd: string): string[] {
  return ["run-shell", "-b", `${menuCmd} --client '#{client_name}'`];
}

/**
 * Like {@link menuRunShellArgs} but for a PANE mouse bind: forwards the click
 * position, only knowable at fire time inside the mouse binding.
 *
 * Coordinate model (measured live on tmux 3.6):
 *  - `#{mouse_x}`/`#{mouse_y}` are PANE-RELATIVE for pane mouse events — the
 *    screen position is `pane_left + mouse_x` / `pane_top + mouse_y`, computed
 *    in the bind string itself with tmux format arithmetic (`#{e|+:…}`).
 *  - `display-menu -y` is the menu's BOTTOM edge, so passing the pointer row
 *    opens the menu upward from the click (tmux clamps/flips near edges).
 * Keyboard binds (M-m) deliberately stay coordless — centered is right when
 * there's no pointer.
 */
function menuPaneMouseRunShellArgs(menuCmd: string): string[] {
  return [
    "run-shell",
    "-b",
    `${menuCmd} --client '#{client_name}' --x '#{e|+:#{pane_left},#{mouse_x}}' --y '#{e|+:#{pane_top},#{mouse_y}}'`,
  ];
}

/**
 * Status-line (dock) variant: status mouse events carry no pane and their
 * `#{mouse_x}` is already the screen column. The dock sits at the bottom, so
 * `#{client_height}` as the bottom edge opens the menu directly ABOVE the dock
 * at the clicked column.
 */
function menuStatusMouseRunShellArgs(menuCmd: string): string[] {
  return [
    "run-shell",
    "-b",
    `${menuCmd} --client '#{client_name}' --x '#{mouse_x}' --y '#{client_height}'`,
  ];
}

/**
 * PURE — the `display-menu` position flags (`-x <n> -y <n>`) for a click at
 * `(x, y)`, or `[]` when either coord is absent or non-numeric (the keyboard
 * path, or an unexpanded `#{mouse_*}` literal) so tmux falls back to centering.
 * `-x` is the menu's LEFT edge; `-y` is the menu's BOTTOM edge on tmux 3.6, so
 * the pointer coords put the menu just above-right of the click.
 */
export function menuPositionArgs(x: string | undefined, y: string | undefined): string[] {
  const nx = parseCoord(x);
  const ny = parseCoord(y);
  if (nx === null || ny === null) return [];
  return ["-x", String(nx), "-y", String(ny)];
}

/** Parse a non-negative integer coord, or null for anything else. */
function parseCoord(value: string | undefined): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/**
 * PURE — the tmux argv that binds {@link MENU_KEY} (`M-m`, root table) to open
 * the actions menu. Server-wide bind, mirroring the switcher's M-p — see the note
 * on `unadoptSession`.
 */
export function menuBindCommand(menuCmd = "tmux-ide menu", key = MENU_KEY): string[] {
  return ["bind-key", "-n", key, ...menuRunShellArgs(menuCmd)];
}

/**
 * PURE — the tmux argv that binds a RIGHT-click on the chrome row
 * ({@link MENU_STATUS_KEY}) to open the same actions menu. Unlike the left-click
 * router this is range-independent: a right-click anywhere on the bar opens the
 * menu, so the session-list content is what matters, not the click target.
 */
export function menuStatusBindCommand(menuCmd = "tmux-ide menu"): string[] {
  return ["bind-key", "-n", MENU_STATUS_KEY, ...menuStatusMouseRunShellArgs(menuCmd)];
}

/**
 * PURE — the tmux argv that binds a RIGHT-click on ANY pane body
 * ({@link MENU_PANE_KEY}) to open the same actions menu, so the menu is reachable
 * everywhere, not only from the dock row. Forwards the click position (see
 * {@link menuPaneMouseRunShellArgs}) so the menu opens at the pointer. Panes whose app
 * captures the mouse (vim, agent TUIs) eat the event — graceful degradation,
 * `M-m` still works there.
 */
export function menuPaneBindCommand(menuCmd = "tmux-ide menu"): string[] {
  return ["bind-key", "-n", MENU_PANE_KEY, ...menuPaneMouseRunShellArgs(menuCmd)];
}

/** PURE — the tmux argv that removes the {@link MENU_KEY} binding. */
export function menuUnbindCommand(key = MENU_KEY): string[] {
  return ["unbind-key", "-n", key];
}

/** PURE — the tmux argv that removes the {@link MENU_STATUS_KEY} binding. */
export function menuStatusUnbindCommand(): string[] {
  return ["unbind-key", "-n", MENU_STATUS_KEY];
}

/** PURE — the tmux argv that removes the {@link MENU_PANE_KEY} binding. */
export function menuPaneUnbindCommand(): string[] {
  return ["unbind-key", "-n", MENU_PANE_KEY];
}
