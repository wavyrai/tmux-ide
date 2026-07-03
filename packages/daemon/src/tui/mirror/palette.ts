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
  | { kind: "quit"; label: string };

const TAB_LABELS: { tab: Tab; label: string }[] = [
  { tab: "home", label: "Switch tab: Home" },
  { tab: "terminal", label: "Switch tab: Terminal" },
  { tab: "files", label: "Switch tab: Files" },
  { tab: "diff", label: "Switch tab: Diff" },
];

/** PURE — the always-available static actions: the four tab switches, one
 *  attach-session per fleet session, then Save / Refresh diff / Quit. */
export function staticPaletteActions(sessions: string[]): PaletteAction[] {
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
  actions.push({ kind: "quit", label: "Quit" });
  return actions;
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
export function filterPaletteActions(query: string, sessions: string[]): PaletteAction[] {
  const statics = staticPaletteActions(sessions);
  const q = query.trim();
  const matched =
    q.length === 0 ? statics : fuzzyFilter(query, statics, (a) => a.label).map((m) => m.item);
  if (q.length === 0) return matched;
  const openFile: PaletteAction = {
    kind: "open-file",
    path: q,
    label: `Open file: ${q}`,
  };
  return looksLikePath(q) ? [openFile, ...matched] : [...matched, openFile];
}
