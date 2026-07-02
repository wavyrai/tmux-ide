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
import type { AgentStatus } from "../detect/classify.ts";
import { switcherPopupCommand, MENU_KEY, MENU_STATUS_KEY } from "./statusline.ts";
import { cheatsheetPopupCommand } from "./cheatsheet.ts";

/**
 * Glyph + tmux colour per status for the menu's session rows. Mirrors the bar's
 * palette (see STATUS_STYLE in statusline.ts): working amber, blocked red, done
 * blue, idle green. Idle uses a hollow glyph here so a quiet session reads as
 * "nothing running" at a glance in the menu list.
 */
const MENU_GLYPH: Record<AgentStatus, { glyph: string; colour: string }> = {
  working: { glyph: "●", colour: "colour221" },
  blocked: { glyph: "●", colour: "colour203" },
  done: { glyph: "●", colour: "colour111" },
  idle: { glyph: "○", colour: "colour114" },
  unknown: { glyph: "·", colour: "colour244" },
};

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
function sessionLabel(session: { name: string; status: AgentStatus }): string {
  const g = MENU_GLYPH[session.status];
  return `#[fg=${g.colour}]${g.glyph}#[default] ${session.name}`;
}

/**
 * PURE — the `display-menu` argument vector (everything AFTER `display-menu`,
 * minus the runtime `-c <client>`/placement flags the CLI prepends): a
 * `tmux-ide` title, then three groups joined by separator lines —
 *
 *   1. `⧉ Switch session…` (s) → the same switcher popup M-p / the bar trigger
 *      opens; `? Cheat sheet` (k) → the same cheat-sheet popup M-k opens. Both
 *      reuse the exact popup command strings so a menu pick behaves identically.
 *   2. up to 8 live sessions, each `«glyph» <name>` keyed 1..8 →
 *      `switch-client -t <name>` (the name quoted so odd names stay inert). The
 *      menu commands run in the client that opened the menu, so the switch lands
 *      on the right client.
 *   3. `＋ New session…` (n) → a `command-prompt` that creates + switches to a
 *      named session; `✕ Kill this session` (x) → a confirmed `kill-session`.
 *
 * A separator is a single empty-string argument (tmux's display-menu convention).
 * Empty groups (no sessions) collapse so two separators never stack.
 */
export function buildMenu(sessions: Array<{ name: string; status: AgentStatus }>): string[] {
  const header: string[] = [
    "⧉ Switch session…",
    "s",
    switcherPopupCommand(),
    "? Cheat sheet",
    "k",
    cheatsheetPopupCommand(),
  ];

  const sessionItems: string[] = [];
  sessions.slice(0, MAX_SESSION_ITEMS).forEach((session, i) => {
    sessionItems.push(sessionLabel(session), String(i + 1), `switch-client -t ${menuQuoteName(session.name)}`);
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
  for (const group of [header, sessionItems, footer]) {
    if (group.length === 0) continue;
    if (items.length > 0) items.push(""); // separator
    items.push(...group);
  }
  return ["-T", "tmux-ide", ...items];
}

// Re-export the key constants (defined in statusline.ts alongside POPUP_KEY so
// the cheat sheet can list them without importing this module) for callers that
// reach for them via the menu module.
export { MENU_KEY, MENU_STATUS_KEY };

/**
 * The tmux command run by both menu binds: invoke our CLI to (re)build and show
 * the menu. `run-shell` format-expands `#{client_name}` into `--client` (bind
 * args themselves do NOT expand), and `-b` detaches so tmux's key/mouse dispatch
 * isn't blocked while the menu is open. The CLI resolves the client from
 * `--client` (falling back to `display-message` if empty) and runs display-menu.
 */
function menuRunShellArgs(menuCmd: string): string[] {
  return ["run-shell", "-b", `${menuCmd} --client '#{client_name}'`];
}

/**
 * PURE — the tmux argv that binds {@link MENU_KEY} (`M-m`, root table) to open
 * the actions menu. Server-wide bind, mirroring the switcher's M-p — see the note
 * on `unadoptSession`.
 */
export function menuBindCommand(menuCmd = "tmux-ide menu"): string[] {
  return ["bind-key", "-n", MENU_KEY, ...menuRunShellArgs(menuCmd)];
}

/**
 * PURE — the tmux argv that binds a RIGHT-click on the chrome row
 * ({@link MENU_STATUS_KEY}) to open the same actions menu. Unlike the left-click
 * router this is range-independent: a right-click anywhere on the bar opens the
 * menu, so the session-list content is what matters, not the click target.
 */
export function menuStatusBindCommand(menuCmd = "tmux-ide menu"): string[] {
  return ["bind-key", "-n", MENU_STATUS_KEY, ...menuRunShellArgs(menuCmd)];
}

/** PURE — the tmux argv that removes the {@link MENU_KEY} binding. */
export function menuUnbindCommand(): string[] {
  return ["unbind-key", "-n", MENU_KEY];
}

/** PURE — the tmux argv that removes the {@link MENU_STATUS_KEY} binding. */
export function menuStatusUnbindCommand(): string[] {
  return ["unbind-key", "-n", MENU_STATUS_KEY];
}
