/**
 * The command palette's action model (M18.4) — PURE so it unit-tests without
 * OpenTUI. app.tsx opens a centered overlay (F5), feeds keystrokes to a query,
 * and runs the selected {@link PaletteAction}; the DESCRIPTORS and the fuzzy
 * filtering live here, the closures that actually attach/save/quit stay in the
 * app (a `dispatch` switch over `action.kind`).
 *
 * Reuses {@link ../team/fuzzy.ts} for the same subsequence match the fleet
 * quick-jump uses, so typing "ses" ranks "Attach session: …" the way a human
 * expects. The dynamic "Open file: <query>" action is always offered when the
 * query is non-empty (you can't fuzzy-match a path you're still typing), pinned
 * to the top when the query looks like a path.
 */
import { fuzzyFilter } from "../team/fuzzy.ts";
import type { Tab } from "./app-state.ts";

/** One runnable palette entry. `label` is what the list shows and what the
 *  fuzzy filter scores; `kind` (+ payload) is what the app dispatches on. */
export type PaletteAction =
  | { kind: "tab"; tab: Tab; label: string }
  | { kind: "attach"; session: string; label: string }
  | { kind: "open-file"; path: string; label: string }
  | { kind: "save"; label: string }
  | { kind: "refresh-diff"; label: string }
  | { kind: "paste-buffer"; label: string }
  | { kind: "new-window"; label: string }
  | { kind: "rename-window"; name: string; label: string }
  | { kind: "kill-window"; label: string }
  | { kind: "zoom-pane"; label: string }
  | { kind: "swap-pane"; label: string }
  | { kind: "break-pane"; label: string }
  | { kind: "rotate-window"; label: string }
  | { kind: "select-layout"; layout: string; label: string }
  | { kind: "sync-toggle"; label: string }
  | { kind: "quit"; label: string };

/** The five tmux `select-layout` presets, offered one palette action each so the
 *  fuzzy filter finds "tiled" / "main-vertical" directly. Shared with the pane
 *  context menu's Layouts submenu (menu-model). */
export const LAYOUT_PRESETS = [
  "even-horizontal",
  "even-vertical",
  "main-horizontal",
  "main-vertical",
  "tiled",
] as const;

/** Context the palette needs beyond the fuzzy query. `terminal` gates the
 *  window/pane verbs (New/Rename/Kill window, Zoom pane) to the Terminal surface
 *  — they are no-ops on Home/Files/Diff, so they only clutter the list there. */
export interface PaletteContext {
  terminal?: boolean;
}

const TAB_LABELS: { tab: Tab; label: string }[] = [
  { tab: "home", label: "Switch tab: Home" },
  { tab: "terminal", label: "Switch tab: Terminal" },
  { tab: "files", label: "Switch tab: Files" },
  { tab: "diff", label: "Switch tab: Diff" },
];

/** PURE — the always-available static actions: the four tab switches, one
 *  attach-session per fleet session, then Save / Refresh diff, the Terminal-only
 *  window/pane verbs, and Quit. */
export function staticPaletteActions(
  sessions: string[],
  ctx: PaletteContext = {},
): PaletteAction[] {
  const actions: PaletteAction[] = TAB_LABELS.map((t) => ({
    kind: "tab" as const,
    tab: t.tab,
    label: t.label,
  }));
  for (const s of sessions) {
    actions.push({ kind: "attach", session: s, label: `Attach session: ${s}` });
  }
  actions.push({ kind: "save", label: "Save file" });
  actions.push({ kind: "refresh-diff", label: "Refresh diff" });
  // Paste target is the focused surface (a pane, or the editor buffer), so this
  // is offered on every surface — selecting it opens a second-level list of the
  // tmux paste buffers rather than dispatching directly.
  actions.push({ kind: "paste-buffer", label: "Paste buffer…" });
  if (ctx.terminal) {
    actions.push({ kind: "new-window", label: "New window" });
    actions.push({ kind: "kill-window", label: "Kill window" });
    actions.push({ kind: "zoom-pane", label: "Zoom pane" });
    actions.push({ kind: "swap-pane", label: "Swap pane with next" });
    actions.push({ kind: "break-pane", label: "Break pane to window" });
    actions.push({ kind: "rotate-window", label: "Rotate panes" });
    actions.push({ kind: "sync-toggle", label: "Synchronize panes (toggle)" });
    for (const layout of LAYOUT_PRESETS) {
      actions.push({ kind: "select-layout", layout, label: `Layout: ${layout}` });
    }
  }
  actions.push({ kind: "quit", label: "Quit" });
  return actions;
}

/** One tmux paste buffer for the picker: its `name` (e.g. `buffer0`) and a
 *  short, control-char-sanitized `preview` of its content. */
export interface TmuxBuffer {
  name: string;
  preview: string;
}

/**
 * PURE — parse `list-buffers -F "#{buffer_name}\t#{buffer_sample}"` reply lines
 * into pickable buffers. The sample is truncated to `previewLen` chars and any
 * control characters (tabs/newlines that survived a sample, C0 bytes) collapse
 * to a middle-dot so one buffer stays one clean row. Nameless/blank lines drop.
 */
export function parseBufferList(lines: readonly string[], previewLen = 40): TmuxBuffer[] {
  const out: TmuxBuffer[] = [];
  for (const raw of lines) {
    if (!raw) continue;
    const tab = raw.indexOf("\t");
    const name = (tab === -1 ? raw : raw.slice(0, tab)).trim();
    if (!name) continue;
    const sample = tab === -1 ? "" : raw.slice(tab + 1);
    const preview = sample
      .slice(0, previewLen)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, "·");
    out.push({ name, preview });
  }
  return out;
}

/** A typed query "looks like a path" when it carries a separator or dot — then
 *  the Open-file action is worth pinning to the top of the results. */
function looksLikePath(q: string): boolean {
  return /[/.~]/.test(q);
}

/**
 * PURE — the palette result list for `query`: the static actions fuzzy-filtered
 * and score-sorted, plus (when the query is non-empty) a dynamic
 * "Open file: <query>" action. That open-file entry is pinned FIRST when the
 * query looks like a path, otherwise appended LAST so it never buries a real
 * match. An empty query returns every static action in natural order.
 */
export function filterPaletteActions(
  query: string,
  sessions: string[],
  ctx: PaletteContext = {},
): PaletteAction[] {
  const statics = staticPaletteActions(sessions, ctx);
  const q = query.trim();
  const matched =
    q.length === 0 ? statics : fuzzyFilter(query, statics, (a) => a.label).map((m) => m.item);
  if (q.length === 0) return matched;
  const dynamic: PaletteAction[] = [{ kind: "open-file", path: q, label: `Open file: ${q}` }];
  // On the Terminal surface a non-empty query also offers a rename-to-<query>
  // window verb (there is no way to fuzzy-match a name you are still typing —
  // same reasoning as the open-file entry).
  if (ctx.terminal) {
    dynamic.push({ kind: "rename-window", name: q, label: `Rename window: ${q}` });
  }
  return looksLikePath(q) ? [...dynamic, ...matched] : [...matched, ...dynamic];
}
