/**
 * The tmux-ide cheat-sheet — an iPadOS-style "all the keys" command sheet.
 *
 * Pressing `⌥k` (or clicking the `[ ? keys ]` trigger in the chrome row) on any
 * adopted session floats a `display-popup` running `tmux-ide cheatsheet`, which
 * prints this grouped, styled sheet and then blocks until ANY key closes it.
 *
 * The sheet is STATIC content, so it renders as a plain ANSI CLI print — no
 * OpenTUI/bun boot — which keeps the popup instant. To stop the sheet drifting
 * from reality, its dynamic groups are SOURCED from live inputs: the configured
 * key binds + theme tokens (`keys`/`theme`, defaulting to the app-config
 * defaults) and the team app's `DEFAULT_KEYMAP`/`ACTION_ORDER`. Only the
 * inherently-static tmux essentials group is hardcoded.
 *
 * `buildCheatsheet` and the bind/unbind command builders are PURE (tested); the
 * CLI `cheatsheet` command wires the io (print + wait-for-key).
 */
import { DEFAULT_KEYS, DEFAULT_THEME, type AppKeys, type AppTheme } from "../../lib/app-config.ts";
import { ACTION_ORDER, DEFAULT_KEYMAP } from "../team/keymap.ts";
import { GRAMMAR_HELP } from "../../widgets/lib/grammar.ts";
import { PANEL_POPUPS, panelKey } from "./panels.ts";

/**
 * The root-table key that floats this sheet: `M-k` (Alt+k). Like the switcher's
 * popup key it lives in the ROOT table so it fires without the prefix from any adopted
 * session, and Alt-letter keys are low-collision in terminal apps. Chosen to sit
 * next to `M-p` (switcher) so the two chrome popups share an ergonomic home.
 */
export const CHEATSHEET_KEY = "M-k";

// --- ANSI styling — the CLI's bold/cyan/dim pattern (see bin/cli.ts). ---
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
const head = (s: string) => `\x1b[1;36m${s}\x1b[0m`;
const color = (code: number, s: string) => `\x1b[38;5;${code}m${s}\x1b[39m`;

/**
 * The 256-color index of a `colourN` theme token for the ANSI legend, or null
 * for a non-`colourN` token (e.g. a hex color) — the caller then renders it dim
 * rather than mis-mapping the code.
 */
function tokenCode(token: string): number | null {
  const m = /^colou?r(\d+)$/.exec(token);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
}

/** Render a glyph in a theme status token's color for the legend (dim fallback). */
function legendMark(token: string, glyph: string): string {
  const code = tokenCode(token);
  return code === null ? dim(glyph) : color(code, glyph);
}

/**
 * Render a tmux key name for humans: `M-` → `⌥`, `C-` → `^`, `S-` → `⇧`. Keeps
 * the sheet's key hints sourced from the real `M-…` constants instead of a
 * separately-maintained pretty string.
 */
function renderKey(tmuxKey: string): string {
  return tmuxKey.replace(/M-/g, "⌥").replace(/C-/g, "^").replace(/S-/g, "⇧");
}

/**
 * Clip a styled line to `width` VISIBLE columns, passing ANSI escapes through
 * untouched (they cost no width) and closing any open style with a reset so a
 * mid-style cut can't bleed into the next line. Guarantees the sheet respects a
 * narrow popup without mangling color codes.
 */
function clip(line: string, width: number): string {
  let out = "";
  let visible = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      // eslint-disable-next-line no-control-regex -- matching the ANSI SGR escape
      const m = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (visible >= width) break;
    out += line[i];
    visible++;
    i++;
  }
  return `${out}\x1b[0m`;
}

/** Visible-width of a styled string (ANSI escapes stripped). */
function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex -- stripping ANSI SGR escapes
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Build the full ANSI cheat sheet, one screenful for a ~100x28 popup.
 *
 * Groups (each under a bold-cyan heading):
 *   1. dock       — the ⌥p / ⌥k popups, the clickable bar, and the glyph legend.
 *   2. picker     — the keys live INSIDE the ⌥p switcher popup.
 *   3. team app   — DERIVED from ACTION_ORDER/DEFAULT_KEYMAP (two columns if the
 *                   width allows), so it never drifts from the real keymap.
 *   4. tmux       — the prefix essentials (inherently static → hardcoded).
 *   5. cli        — the handful of scriptable commands worth remembering.
 *
 * Every line is clipped to `width` so nothing overflows a narrow popup.
 */
export function buildCheatsheet(opts: { width: number; keys?: AppKeys; theme?: AppTheme }): string {
  const width = Math.max(20, opts.width);
  const keys = opts.keys ?? DEFAULT_KEYS;
  const theme = opts.theme ?? DEFAULT_THEME;
  const lines: string[] = [];
  const pad = (s: string) => `  ${s}`; // two-space indent under each heading

  // Title.
  lines.push(`${head(" tmux-ide")}  ${dim("cheat sheet — press any key to close")}`);
  lines.push("");

  // 1. dock — sourced key hints from the configured keys.
  lines.push(head("dock"));
  lines.push(
    pad(
      `${bold(renderKey(keys.home))} home cockpit   ${bold(renderKey(keys.popup))} switcher popup   ${bold(renderKey(keys.cheatsheet))} this sheet   ${bold(renderKey(keys.menu))} actions menu   ${bold(renderKey(keys.sidebar))} sidebar`,
    ),
  );
  lines.push(
    pad(
      dim(
        `bar: click a project tab = switch there · [ ⌂ home ${renderKey(keys.home)} ] = home · [ ⧉ switch ${renderKey(keys.popup)} ] = switcher · right-click anywhere = menu`,
      ),
    ),
  );
  const active = theme.glyphs.active;
  const legend =
    `${legendMark(theme.status.blocked, active)} blocked  ${legendMark(theme.status.working, active)} working  ` +
    `${legendMark(theme.status.done, active)} done  ${legendMark(theme.status.idle, active)} idle  ` +
    `${dim("·")} unknown  ${dim(theme.glyphs.inactive)} stopped`;
  lines.push(pad(legend));
  lines.push("");

  // 1a. prefix twins — the RELIABLE bindings (the tmux prefix survives every
  // keyboard protocol; Alt keys don't always). Letters pinned against
  // prefixKeyBinds by a statusline test so they can't drift.
  lines.push(head("prefix keys (always work)"));
  lines.push(
    pad(
      `${bold("prefix h")} home  ${bold("prefix j")} switcher  ${bold("prefix k")} keys  ${bold("prefix u")} menu  ${bold("prefix b")} sidebar  ${bold("prefix e")} files  ${bold("prefix g")} changes  ${bold("prefix v")} config`,
    ),
  );
  lines.push(pad(dim(`prefix = your tmux prefix (usually C-b) — use these when Alt keys don't reach tmux`)));
  lines.push("");

  // 1b. panels — every widget floats as a popup, one key away, esc to close.
  lines.push(head("panels"));
  const panelHints = PANEL_POPUPS.map(
    (p) => `${bold(renderKey(panelKey(p, keys.panels)))} ${p.label}`,
  ).join("   ");
  lines.push(pad(`${panelHints}   ${dim("esc/q closes any panel")}`));
  lines.push("");

  // 1c. grammar — the ONE interaction grammar every panel + the sidebar share,
  // sourced from GRAMMAR_HELP so it can never drift from the widgets.
  lines.push(head("in panels & sidebar"));
  const gKeyW = Math.max(...GRAMMAR_HELP.map((r) => r.keys.length));
  for (const row of GRAMMAR_HELP) {
    lines.push(pad(`${bold(row.keys.padEnd(gKeyW))}  ${dim(row.label)}`));
  }
  lines.push("");

  // 2. picker — keys inside the switcher popup.
  lines.push(head(`picker  ${dim(`(inside the ${renderKey(keys.popup)} popup)`)}`));
  lines.push(
    pad(`${bold("↵")} switch   ${bold("l")} launch   ${bold("/")} find   ${bold("esc")} close`),
  );
  lines.push("");

  // 3. team app — derived from the real keymap, two columns when it fits.
  lines.push(head("team app"));
  const cells = ACTION_ORDER.map((action) => {
    const binding = DEFAULT_KEYMAP[action];
    return { keys: binding.keys.join("/"), desc: binding.description };
  });
  const keyW = Math.max(...cells.map((c) => c.keys.length));
  const descW = Math.max(...cells.map((c) => c.desc.length));
  const cellW = keyW + 2 + descW; // "keys" + gap + "desc" visible width
  const renderCell = (c: { keys: string; desc: string }): string => {
    const text = `${bold(c.keys.padEnd(keyW))}  ${dim(c.desc)}`;
    return text + " ".repeat(Math.max(0, cellW - visibleWidth(text)));
  };
  const twoCols = width >= cellW * 2 + 4;
  if (twoCols) {
    const half = Math.ceil(cells.length / 2);
    for (let i = 0; i < half; i++) {
      const left = cells[i];
      const right = cells[i + half];
      const rendered = left ? renderCell(left) : "";
      lines.push(pad(right ? `${rendered}  ${renderCell(right)}` : rendered));
    }
  } else {
    for (const c of cells) lines.push(pad(renderCell(c)));
  }
  lines.push("");

  // 4. tmux essentials — static.
  lines.push(head("tmux essentials"));
  lines.push(
    pad(
      `${bold("prefix d")} detach   ${bold("prefix z")} zoom pane   ${bold("prefix [")} copy mode`,
    ),
  );
  lines.push(
    pad(
      `${bold("prefix c")} new window   ${bold("prefix n/p")} next/prev   ${bold('prefix % / "')} splits`,
    ),
  );
  lines.push("");

  // 5. cli — scriptable commands.
  lines.push(head("cli"));
  lines.push(pad(cyan("tmux-ide team --json")));
  lines.push(pad(cyan("tmux-ide wait agent-status <s> --status done")));
  lines.push(pad(cyan("tmux-ide adopt/unadopt <session>")));
  lines.push(pad(cyan("tmux-ide worktree create <branch>") + dim("   (⎇ in the menu)")));

  return lines.map((line) => clip(line, width)).join("\n");
}

/**
 * PURE — the `display-popup` command STRING that floats the cheat sheet (shared
 * by the M-k bind, the bar's `[ ? keys ]` left-click router, and the actions
 * menu's "Cheat sheet" item, so all three open an identical popup). Mirror of the
 * sizing in {@link cheatsheetBindCommand}.
 */
export function cheatsheetPopupCommand(cheatsheetCmd = "tmux-ide cheatsheet"): string {
  return `display-popup -E -w 90% -h 80% "${cheatsheetCmd}"`;
}

/**
 * PURE — the tmux argv that binds {@link CHEATSHEET_KEY}: `M-k` opens a
 * `display-popup` running the cheat sheet (which waits for any key, then exits,
 * closing the popup). Server-wide root-table bind, mirroring the switcher's
 * popup key — see the note on `unadoptSession`.
 */
export function cheatsheetBindCommand(
  cheatsheetCmd = "tmux-ide cheatsheet",
  key = CHEATSHEET_KEY,
): string[] {
  return ["bind-key", "-n", key, "display-popup", "-E", "-w", "90%", "-h", "80%", cheatsheetCmd];
}

/** PURE — the tmux argv that removes the cheat-sheet key binding. */
export function cheatsheetUnbindCommand(key = CHEATSHEET_KEY): string[] {
  return ["unbind-key", "-n", key];
}
