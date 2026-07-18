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
import type { PaletteUsageEntry, Tab } from "./app-state.ts";
import type { AgentRowInput } from "./agent-rows.ts";
import type { HostedPanelView } from "./panel-host.ts";
import { SETTINGS_PALETTE_COMMANDS, type SettingsCommandId } from "./settings-model.ts";

/** One runnable palette entry. `label` is what the list shows and what the
 *  fuzzy filter scores; `kind` (+ payload) is what the app dispatches on. */
export type PaletteAction =
  | { kind: "tab"; tab: Tab; label: string }
  | { kind: "view"; viewId: string; label: string }
  | { kind: "open-folder"; label: string }
  | { kind: "attach"; session: string; label: string }
  | { kind: "jump-agent"; paneId: string; session: string; windowIndex: number; label: string }
  // The lifecycle verbs (M23.1) — `agentKind` (not `kind`, taken by the action
  // discriminant) is the manifest id the restart flow resolves a launch
  // command from. Each fleet agent gets one restart + one stop row; "New
  // agent…" opens the spawn flow (kind → placement → run) on the dialog stack.
  | { kind: "new-agent"; label: string }
  // Repeat the current context's remembered spawn directly — no dialog (M24.1).
  | { kind: "new-agent-again"; label: string }
  // The one-surface team console (M24.1): jump/restart/stop + "+ new agent".
  | { kind: "manage-team"; label: string }
  | { kind: "restart-agent"; paneId: string; agentKind: string; session: string; label: string }
  | { kind: "stop-agent"; paneId: string; agentKind: string; session: string; label: string }
  | { kind: "open-file"; path: string; label: string }
  // "Go to file:" (M24.6) — one row per fuzzy-matched REPO file (workspace-
  // relative, ignore-respecting, fed by the app via ctx.repoFiles), unlike
  // open-file whose path is whatever the user typed.
  | { kind: "go-file"; path: string; label: string }
  | { kind: "save"; label: string }
  | { kind: "refresh-diff"; label: string }
  | { kind: "paste-buffer"; label: string }
  | { kind: "search-scrollback"; label: string }
  | { kind: "new-window"; label: string }
  | { kind: "rename-window"; name: string; label: string }
  | { kind: "kill-window"; label: string }
  | { kind: "zoom-pane"; label: string }
  | { kind: "swap-pane"; label: string }
  | { kind: "break-pane"; label: string }
  | { kind: "rotate-window"; label: string }
  | { kind: "select-layout"; layout: string; label: string }
  | { kind: "sync-toggle"; label: string }
  | { kind: "select-text"; label: string }
  | { kind: "resize-window"; label: string }
  | { kind: "settings"; id: SettingsCommandId; label: string }
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
  /** The fleet's agents (M22.2) — the palette offers one "Agent: …" jump action
   *  each, the keyboard twin of the sidebar's clickable agent rows. Already
   *  sorted attention-first by the caller (fleetAgents). */
  agents?: AgentRowInput[];
  /** A co-attached terminal has sized the tmux window away from our canvas
   *  (M22.8). Only then is the "Resize to fit this window" reclaim action worth
   *  offering — otherwise it is a no-op that clutters the list. */
  sizeMismatch?: boolean;
  /** The focused pane's app turned mouse reporting on (M22.9) — only then is
   *  "Select text in pane" offered (ordinary panes drag-select directly, so the
   *  action would be a no-op that clutters the list). */
  appMousePane?: boolean;
  /** What the current context's remembered spawn is called (`claude`, a custom
   *  argv, …) — when set, a direct "New agent: <name> (again)" action is PINNED
   *  FIRST, so a repeat spawn is F5 → Enter (M24.1's ≤2-Enters bar). */
  againName?: string | null;
  /** Palette usage history (M24.4) keyed by {@link paletteActionKey}: drives
   *  the empty-query "recent" group and the frequency/recency tie-break on a
   *  typed query. Persisted in app-state. */
  usage?: Readonly<Record<string, PaletteUsageEntry>>;
  /** The active surface tab (M24.4) — steers the empty-query "suggested"
   *  group (Terminal → window/pane verbs + the again spawn; Files → save +
   *  open-folder). `terminal` above stays THE gate for the window/pane verbs
   *  so existing callers/tests are untouched. */
  surface?: Tab;
  /** Action key → keycap ({@link ../mirror/settings-model.ts}'s
   *  PALETTE_KEYCAPS) — rows whose action has one right-align it (M24.4).
   *  app.tsx drops `quit` in HOSTED mode, where ^q detaches instead. */
  keycaps?: Readonly<Record<string, string>>;
  /** The workspace's file list (M24.6) — repo-relative paths, gitignore-
   *  respecting, capped by the caller. A non-empty query offers fuzzy-matched
   *  "Go to file: <path>" rows via {@link goToFileActions}. */
  repoFiles?: readonly string[];
  /** Configured first-class panel views (C05). When present, these replace the
   *  legacy four static tab actions so duplicate panel kinds keep their stable
   *  configured view identity. */
  views?: readonly HostedPanelView[];
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
  const actions: PaletteAction[] = [];
  // The repeat spawn (M24.1) — FIRST, above everything: with memory for the
  // current context, an empty-query Enter repeats the last spawn, making
  // F5 → Enter the whole gesture (the card's ≤2-Enters acceptance bar).
  if (ctx.againName) {
    actions.push({ kind: "new-agent-again", label: `New agent: ${ctx.againName} (again)` });
  }
  if (ctx.views) {
    for (const view of ctx.views) {
      actions.push({ kind: "view", viewId: view.id, label: `Switch view: ${view.title}` });
    }
  } else {
    for (const t of TAB_LABELS) actions.push({ kind: "tab", tab: t.tab, label: t.label });
  }
  // The non-technicals' front door (M22.5): a filesystem picker → create-or-
  // attach a session in the chosen folder. Offered on every surface.
  actions.push({ kind: "open-folder", label: "Open folder…" });
  // Spawn an agent (M23.1/M24.1) — offered on every surface; ONE dialog whose
  // default placement is contextual (split beside a focused pane, else a new
  // window in the session, else a fresh session).
  actions.push({ kind: "new-agent", label: "New agent…" });
  // The team console (M24.1): every fleet agent in one dialog — jump, restart,
  // stop, spawn. The sidebar agents-header click's keyboard twin.
  actions.push({ kind: "manage-team", label: "Manage team…" });
  for (const s of sessions) {
    actions.push({ kind: "attach", session: s, label: `Attach session: ${s}` });
  }
  // One jump per fleet agent (M22.2) — the sidebar rows' keyboard twin. Labeled
  // "Agent: <kind> · <session> (<state>)" so the fuzzy filter finds it by kind,
  // session, or state (typing "agent", "claude", or "blocked" all narrow to it).
  for (const a of ctx.agents ?? []) {
    actions.push({
      kind: "jump-agent",
      paneId: a.paneId,
      session: a.session,
      windowIndex: a.windowIndex,
      label: `Agent: ${a.kind} · ${a.session} (${a.state})`,
    });
  }
  // The per-agent lifecycle verbs (M23.1), grouped after the jumps so an empty
  // query reads jump-first; the fuzzy filter finds "restart"/"stop" directly.
  for (const a of ctx.agents ?? []) {
    const who = `${a.kind} · ${a.session}`;
    actions.push({
      kind: "restart-agent",
      paneId: a.paneId,
      agentKind: a.kind,
      session: a.session,
      label: `Restart agent: ${who}`,
    });
    actions.push({
      kind: "stop-agent",
      paneId: a.paneId,
      agentKind: a.kind,
      session: a.session,
      label: `Stop agent: ${who}`,
    });
  }
  actions.push({ kind: "save", label: "Save file" });
  actions.push({ kind: "refresh-diff", label: "Refresh diff" });
  // Paste target is the focused surface (a pane, or the editor buffer), so this
  // is offered on every surface — selecting it opens a second-level list of the
  // tmux paste buffers rather than dispatching directly.
  actions.push({ kind: "paste-buffer", label: "Paste buffer…" });
  // The SETTINGS category (M22.4) — every setting is a command; "Settings…" is
  // the categorized umbrella over the same dialogs. Offered on every surface.
  for (const c of SETTINGS_PALETTE_COMMANDS) {
    actions.push({ kind: "settings", id: c.id, label: c.label });
  }
  if (ctx.terminal) {
    // `/` only opens search while scrolled into history (at the live prompt it
    // belongs to the pane — agents' slash commands); this is the always-there
    // entry.
    actions.push({ kind: "search-scrollback", label: "Search scrollback" });
    actions.push({ kind: "new-window", label: "New window" });
    actions.push({ kind: "kill-window", label: "Kill window" });
    actions.push({ kind: "zoom-pane", label: "Zoom pane" });
    actions.push({ kind: "swap-pane", label: "Swap pane with next" });
    actions.push({ kind: "break-pane", label: "Break pane to window" });
    actions.push({ kind: "rotate-window", label: "Rotate panes" });
    actions.push({ kind: "sync-toggle", label: "Synchronize panes (toggle)" });
    // Selection entry on app-mouse panes (M22.9) — the pane menu verb's
    // keyboard twin, offered only where forwarding blocks a direct drag.
    if (ctx.appMousePane) {
      actions.push({ kind: "select-text", label: "Select text in pane" });
    }
    for (const layout of LAYOUT_PRESETS) {
      actions.push({ kind: "select-layout", layout, label: `Layout: ${layout}` });
    }
    // Only when a co-attached terminal is dictating the window size — the reclaim
    // is a no-op otherwise, and we never fight the other terminal unasked.
    if (ctx.sizeMismatch) {
      actions.push({ kind: "resize-window", label: "Resize to fit this window" });
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

// ── Overlay geometry (M21.9 — palette mouse support) ────────────────────────
// The palette overlay is app-rendered (a centered <box border paddingLeft=1>),
// so its full geometry is knowable by pure math. These helpers are shared by
// the RENDER (placement) and the central mouse ROUTER (row hit-test / inside-
// vs-outside), so a click can never land where a row isn't drawn. Layout, in
// screen rows from `top`: border (top+0) · input/header line (top+1) · rule
// (top+2) · result rows (top+3 …) · an optional "no matches" row when empty ·
// border. Rows span the box interior in x: [left+1, left+width-1).

/** Rows of chrome above the first result row: top border + input line + rule. */
export const PALETTE_HEADER_ROWS = 3;

/** The palette box geometry the router hit-tests: the placed box plus how many
 *  result rows are currently visible (min(count - top, pageRows)). */
export interface PaletteGeom {
  left: number;
  top: number;
  width: number;
  /** Result rows on screen right now (0 when the list is empty). */
  visibleRows: number;
}

/** PURE — the overlay's placement for a terminal size: horizontally centered,
 *  top at a sixth of the height (min 1 — below the surface tab bar). MUST match
 *  the render's `left`/`top` props (the render calls this). */
export function palettePos(
  termW: number,
  termH: number,
  width: number,
): { left: number; top: number } {
  return {
    left: Math.max(0, Math.floor((termW - width) / 2)),
    top: Math.max(1, Math.floor(termH / 6)),
  };
}

/** PURE — total box height for `visibleRows` results: header chrome + the rows
 *  (an empty list still shows one "no matches"/"no buffers" row) + the bottom
 *  border. Used for inside/outside containment. */
export function paletteHeight(visibleRows: number): number {
  return PALETTE_HEADER_ROWS + Math.max(1, visibleRows) + 1;
}

/** PURE — the VISIBLE result-row index under (x, y), or -1. Only real rows hit
 *  (the "no matches" placeholder row is not clickable); x must be inside the
 *  box interior (borders excluded). */
export function paletteRowAt(g: PaletteGeom, x: number, y: number): number {
  if (x < g.left + 1 || x >= g.left + g.width - 1) return -1;
  const row = y - (g.top + PALETTE_HEADER_ROWS);
  return row >= 0 && row < g.visibleRows ? row : -1;
}

/** PURE — whether (x, y) falls anywhere on the palette box (border included).
 *  A press outside dismisses the overlay; inside-but-not-a-row is a no-op. */
export function paletteContains(g: PaletteGeom, x: number, y: number): boolean {
  return (
    x >= g.left && x < g.left + g.width && y >= g.top && y < g.top + paletteHeight(g.visibleRows)
  );
}

/** PURE — clamp a wheel-scrolled list top into [0, count - pageRows]. */
export function clampPaletteTop(top: number, count: number, pageRows: number): number {
  return Math.max(0, Math.min(top, count - pageRows));
}

/** A typed query "looks like a path" when it carries a separator or dot — then
 *  the Open-file action is worth pinning to the top of the results. */
function looksLikePath(q: string): boolean {
  return /[/.~]/.test(q);
}

/** Cap on "Go to file:" rows so a big repo never floods the palette. */
export const GO_FILE_CAP = 8;

/**
 * PURE (M24.6) — the dynamic "Go to file:" rows for `query`: the repo's
 * (ignore-respecting) file list fuzzy-filtered against the query, one open
 * action per match, capped at `cap`. An empty query offers none — the static
 * list stays uncluttered. Strictly ADDITIVE to the palette: this only CALLS
 * the shared fuzzy filter, and its rows are appended after the existing
 * results (see {@link filterPaletteActions}).
 */
export function goToFileActions(
  query: string,
  repoFiles: readonly string[],
  cap: number = GO_FILE_CAP,
): PaletteAction[] {
  const q = query.trim();
  if (q.length === 0 || repoFiles.length === 0) return [];
  return fuzzyFilter(q, [...repoFiles], (p) => p)
    .slice(0, cap)
    .map((m) => ({ kind: "go-file" as const, path: m.item, label: `Go to file: ${m.item}` }));
}

/**
 * PURE — the STABLE identity of an action for usage history (M24.4): the kind
 * plus the payload fields that survive restarts (session/layout/settings id/
 * path — NOT the label, so relabeling never orphans history, and NOT pane ids,
 * which tmux renumbers). Kinds without a stable payload are keyed by kind
 * alone (rename-window's typed name is query-dependent, not identity).
 */
export function paletteActionKey(a: PaletteAction): string {
  switch (a.kind) {
    case "tab":
      return `tab:${a.tab}`;
    case "view":
      return `view:${a.viewId}`;
    case "attach":
      return `attach:${a.session}`;
    case "jump-agent":
      return `jump-agent:${a.session}`;
    case "restart-agent":
      return `restart-agent:${a.session}:${a.agentKind}`;
    case "stop-agent":
      return `stop-agent:${a.session}:${a.agentKind}`;
    case "select-layout":
      return `select-layout:${a.layout}`;
    case "settings":
      return `settings:${a.id}`;
    case "open-file":
      return `open-file:${a.path}`;
    default:
      return a.kind;
  }
}

/** PURE — the usage comparator (frequency first, then recency): negative when
 *  `a` should rank before `b`. Unused actions rank last, mutually tied. */
function compareUsage(
  a: PaletteAction,
  b: PaletteAction,
  usage: Readonly<Record<string, PaletteUsageEntry>> | undefined,
): number {
  const ua = usage?.[paletteActionKey(a)];
  const ub = usage?.[paletteActionKey(b)];
  return (ub?.count ?? 0) - (ua?.count ?? 0) || (ub?.lastUsed ?? 0) - (ua?.lastUsed ?? 0);
}

/**
 * PURE — the palette result list for `query`: the static actions fuzzy-filtered
 * and score-sorted (exact/prefix matches outrank mid-word via the scorer's
 * label-start weighting; score TIES break by usage — frequency then recency —
 * M24.4), plus (when the query is non-empty) a dynamic
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
    q.length === 0
      ? statics
      : fuzzyFilter(query, statics, (a) => a.label)
          .sort((x, y) => y.score - x.score || compareUsage(x.item, y.item, ctx.usage))
          .map((m) => m.item);
  if (q.length === 0) return matched;
  const dynamic: PaletteAction[] = [{ kind: "open-file", path: q, label: `Open file: ${q}` }];
  // On the Terminal surface a non-empty query also offers a rename-to-<query>
  // window verb (there is no way to fuzzy-match a name you are still typing —
  // same reasoning as the open-file entry).
  if (ctx.terminal) {
    dynamic.push({ kind: "rename-window", name: q, label: `Rename window: ${q}` });
  }
  // "Go to file:" rows (M24.6) are APPENDED after everything so this addition
  // cannot disturb the existing result ranking.
  const goFiles = goToFileActions(q, ctx.repoFiles ?? []);
  return looksLikePath(q)
    ? [...dynamic, ...matched, ...goFiles]
    : [...matched, ...dynamic, ...goFiles];
}

// ── Grouped rows (M24.4 — the palette's list model) ─────────────────────────
// The overlay renders ROWS, not bare actions: on an EMPTY query the list opens
// with a "recent" group (top used actions), a contextual "suggested" group,
// then everything else under "commands"; a typed query is one flat ranked list
// (no headers). Headers are real rows — they occupy a screen line, scroll with
// the list, and are NOT selectable/clickable — so the selection helpers below
// are what the keyboard/router use to move between action rows.

/** One rendered palette line: a group header, or an action with its optional
 *  right-aligned keycap (from ctx.keycaps). */
export type PaletteRow =
  | { type: "header"; label: string }
  | { type: "action"; action: PaletteAction; shortcut: string | null };

/** How many actions the empty-query "recent" group shows at most. */
export const PALETTE_RECENT_LIMIT = 5;

/** The Terminal surface's suggested window/pane verbs, in offer order. */
const TERMINAL_SUGGESTED_KINDS: ReadonlyArray<PaletteAction["kind"]> = [
  "new-window",
  "kill-window",
  "zoom-pane",
  "swap-pane",
  "break-pane",
  "rotate-window",
];

/**
 * PURE — the palette rows for `query` (M24.4). A non-empty query is the flat
 * {@link filterPaletteActions} ranking. An empty query groups:
 *   1. "recent" — up to {@link PALETTE_RECENT_LIMIT} previously-run actions
 *      still offerable now (usage keys matched against the current statics),
 *      most-frequently-used first, recency breaking ties;
 *   2. "suggested" — BLOCKED agents' jump actions first (ctx.agents arrives
 *      attention-sorted, so their relative order is the sidebar's), then the
 *      surface's verbs: Terminal → the again-spawn + window/pane verbs, Files
 *      → save + open-folder;
 *   3. "commands" — every remaining action in today's natural order.
 * With nothing to group (no usage, no suggestions) the list is exactly the
 * ungrouped statics — no headers, same as before this card.
 */
export function paletteRows(
  query: string,
  sessions: string[],
  ctx: PaletteContext = {},
): PaletteRow[] {
  const row = (action: PaletteAction): PaletteRow => ({
    type: "action",
    action,
    shortcut: ctx.keycaps?.[paletteActionKey(action)] ?? null,
  });
  if (query.trim().length > 0) return filterPaletteActions(query, sessions, ctx).map(row);

  const statics = staticPaletteActions(sessions, ctx);
  // First static per key — recents resolve through this so a persisted key
  // finds the action's CURRENT incarnation (relabels don't orphan history).
  const byKey = new Map<string, PaletteAction>();
  for (const a of statics) {
    const k = paletteActionKey(a);
    if (!byKey.has(k)) byKey.set(k, a);
  }
  const taken = new Set<PaletteAction>();

  const recent: PaletteAction[] = [];
  const usedKeys = Object.entries(ctx.usage ?? {})
    .sort(([, a], [, b]) => b.count - a.count || b.lastUsed - a.lastUsed)
    .map(([k]) => k);
  for (const k of usedKeys) {
    if (recent.length >= PALETTE_RECENT_LIMIT) break;
    const a = byKey.get(k);
    if (a && !taken.has(a)) {
      recent.push(a);
      taken.add(a);
    }
  }

  const suggested: PaletteAction[] = [];
  const suggest = (pred: (a: PaletteAction) => boolean): void => {
    for (const a of statics) {
      if (!taken.has(a) && pred(a)) {
        suggested.push(a);
        taken.add(a);
      }
    }
  };
  // Blocked agents outrank every other suggestion — they are why the user is
  // opening the palette (the sidebar's attention-first law, applied here).
  const blockedPanes = new Set(
    (ctx.agents ?? []).filter((x) => x.state === "blocked").map((x) => x.paneId),
  );
  suggest((a) => a.kind === "jump-agent" && blockedPanes.has(a.paneId));
  if (ctx.surface === "terminal") {
    suggest((a) => a.kind === "new-agent-again");
    suggest((a) => TERMINAL_SUGGESTED_KINDS.includes(a.kind));
  } else if (ctx.surface === "files") {
    suggest((a) => a.kind === "save" || a.kind === "open-folder");
  }

  if (recent.length === 0 && suggested.length === 0) return statics.map(row);
  const rows: PaletteRow[] = [];
  if (recent.length > 0) {
    rows.push({ type: "header", label: "recent" });
    for (const a of recent) rows.push(row(a));
  }
  if (suggested.length > 0) {
    rows.push({ type: "header", label: "suggested" });
    for (const a of suggested) rows.push(row(a));
  }
  rows.push({ type: "header", label: "commands" });
  for (const a of statics) if (!taken.has(a)) rows.push(row(a));
  return rows;
}

/** PURE — the first selectable (action) row index, or -1 when none. Where the
 *  selection starts on open/query edits (headers are never selected). */
export function firstPaletteAction(rows: readonly PaletteRow[]): number {
  return rows.findIndex((r) => r.type === "action");
}

/** PURE — the next action row from `cur` in `dir` (±1), skipping headers;
 *  stays put at the list's ends. The keyboard's up/down. */
export function stepPaletteRow(rows: readonly PaletteRow[], cur: number, dir: 1 | -1): number {
  for (let i = cur + dir; i >= 0 && i < rows.length; i += dir) {
    if (rows[i]!.type === "action") return i;
  }
  return cur;
}

/**
 * PURE — one action row's text after the selection prefix: the label, then —
 * when the row has a keycap — right-aligned padding + the keycap inside
 * `width` cells. The label truncates with an ellipsis so the keycap ALWAYS
 * fits (min one space between); without a keycap the label just truncates.
 */
export function paletteRowText(label: string, shortcut: string | null, width: number): string {
  if (width <= 0) return "";
  if (!shortcut || shortcut.length + 2 > width) {
    return label.length <= width ? label : label.slice(0, Math.max(0, width - 1)) + "…";
  }
  const labelMax = width - shortcut.length - 1;
  const shown = label.length <= labelMax ? label : label.slice(0, Math.max(0, labelMax - 1)) + "…";
  return shown + " ".repeat(width - shown.length - shortcut.length) + shortcut;
}
