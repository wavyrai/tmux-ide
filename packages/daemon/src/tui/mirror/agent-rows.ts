/**
 * The sidebar AGENTS section's pure model (M22.2) — PURE so it unit-tests
 * without OpenTUI. app.tsx flattens the fleet payload's per-session
 * `agents: PaneAgentEntry[]` (M22.1) into one fleet-wide list, sorts it
 * attention-first, renders one row per agent (reusing app.tsx's existing
 * STATUS_GLYPH / STATUS_COLOR grammar keyed by state — NOT reinvented here), and
 * lets a click JUMP to the exact session/window/pane. Ordering, row-label
 * truncation, state-age formatting, and the sidebar row hit-test all live here;
 * the render/router just read them.
 *
 * The sort order mirrors {@link ../team/home.ts}'s `ROLLUP_ORDER` so the sidebar
 * list and the header rollup chips agree on what "attention-first" means.
 */
import type { AgentStatus } from "../detect/classify.ts";
import { ROLLUP_ORDER } from "../team/home.ts";

/** The per-agent fields the sidebar needs — a structural subset of the fleet
 *  payload's `PaneAgentEntry` (app.tsx keeps its fleet types local + io-free, so
 *  this narrower shape is what it flattens into). */
export interface AgentRowInput {
  /** tmux pane id, e.g. `%5` — the exact pane a click focuses. */
  paneId: string;
  /** `window_index` of the tab this pane lives in — the window a click selects. */
  windowIndex: number;
  /** Owning session name — the workspace a click switches to. */
  session: string;
  /** Resolved agent kind (manifest id: `claude`, `codex`, …). */
  kind: string;
  /** Final per-pane status (drives the glyph + color, reusing the app grammar). */
  state: AgentStatus;
  /** Authority state's epoch-seconds stamp, or null for a scraped pane. */
  since: number | null;
}

/** Attention-first rank: blocked, working, done, idle (from `ROLLUP_ORDER`), then
 *  `unknown` last. Lower sorts earlier. */
const STATE_RANK: Record<AgentStatus, number> = (() => {
  const rank = {} as Record<AgentStatus, number>;
  ROLLUP_ORDER.forEach((s, i) => (rank[s] = i));
  rank.unknown = ROLLUP_ORDER.length;
  return rank;
})();

/**
 * PURE — order agents attention-first (blocked → working → done → idle →
 * unknown), STABLE within a group so rows don't jitter between polls when states
 * are unchanged (`Array.prototype.sort` is stable). Returns a new array; the
 * input is untouched.
 */
export function sortAgentRows<T extends { state: AgentStatus }>(agents: readonly T[]): T[] {
  return [...agents].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]);
}

/**
 * PURE — the label shown on a sidebar agent row: `"<kind> · <session>"`,
 * truncated with a trailing ellipsis to at most `maxChars` columns (the sidebar
 * is width-constrained and drag-resizable). `maxChars <= 0` yields "".
 */
export function agentRowLabel(kind: string, session: string, maxChars: number): string {
  const full = `${kind} · ${session}`;
  if (maxChars <= 0) return "";
  if (full.length <= maxChars) return full;
  if (maxChars === 1) return "…";
  return full.slice(0, maxChars - 1) + "…";
}

/**
 * PURE — the AGENTS section header, `"agents · <count>"`, truncated to
 * `maxChars`. The count is always shown so the header doubles as the tally the
 * card asks for.
 */
export function agentsHeaderLabel(count: number, maxChars: number): string {
  const full = `agents · ${count}`;
  if (maxChars <= 0) return "";
  return full.length <= maxChars ? full : full.slice(0, Math.max(1, maxChars - 1)) + "…";
}

/** The quiet empty-state line shown under the header when no agents are running. */
export const AGENTS_EMPTY_LINE = "no agents running — panes running claude or codex show up here";

/** The always-present spawn chip on the AGENTS header row (and the empty-state
 *  row) — THE discoverable "start a new agent" entry (M24.1). Right-aligned;
 *  the render and the router share its span via `spansFromRight`. */
export const AGENTS_ADD_CHIP = "[+ agent]";

/**
 * PURE — a compact state-age like `"blocked 4m"` from a `since` epoch-seconds
 * stamp, for the hovered row. Returns null when there is no timestamp (a scraped
 * pane) or the dwell rounds to zero — nothing worth showing. Granularity:
 * seconds under a minute, then minutes, then hours.
 */
export function agentAgeLabel(
  state: AgentStatus,
  since: number | null,
  nowSec: number,
): string | null {
  if (since == null) return null;
  const secs = Math.max(0, Math.floor(nowSec - since));
  let span: string;
  if (secs < 60) span = `${secs}s`;
  else if (secs < 3600) span = `${Math.floor(secs / 60)}m`;
  else span = `${Math.floor(secs / 3600)}h`;
  return `${state} ${span}`;
}

/** Blank rows the render leaves between the session list and the agents header
 *  (the agents section's `marginTop`). Kept here so `sidebarHit` and the render
 *  agree on the row the header sits on — a mismatch lands clicks one row off. */
export const AGENTS_GAP_ROWS = 1;

/** What a sidebar content row (a tab-bar-adjusted `gy`) targets. The gap
 *  row(s) are inert; `agents-header` opens the Team dialog (its right-aligned
 *  `[+ agent]` chip spawns — the router x-tests the chip span first), and
 *  `agents-empty` is the empty-state row (inert except its chip). */
export type SidebarHit =
  | { kind: "session"; index: number }
  | { kind: "agent"; index: number }
  | { kind: "agents-header" }
  | { kind: "agents-empty" }
  | null;

/**
 * PURE — map a sidebar content row `gy` (already `y - TABBAR_H`) to what it
 * targets, shared by the click router and the hover resolver so a click can
 * never land where a row isn't drawn. Layout, top to bottom: `gy 0` title,
 * `gy 1` rule, then `sessionCount` session rows from `gy 2`, then
 * `AGENTS_GAP_ROWS` blank row(s), then the agents section — one header row, then
 * `agentCount` agent rows (or a single empty-state row when `agentCount === 0`,
 * hit-tested as `agents-empty` so its `[+ agent]` chip stays clickable).
 */
export function sidebarHit(gy: number, sessionCount: number, agentCount: number): SidebarHit {
  if (gy < 2) return null;
  const si = gy - 2;
  if (si < sessionCount) return { kind: "session", index: si };
  const headerGy = 2 + sessionCount + AGENTS_GAP_ROWS;
  if (gy < headerGy) return null; // the gap row(s) between sessions and agents
  if (gy === headerGy) return { kind: "agents-header" };
  const ai = gy - headerGy - 1;
  if (agentCount === 0) return ai === 0 ? { kind: "agents-empty" } : null;
  if (ai < 0 || ai >= agentCount) return null;
  return { kind: "agent", index: ai };
}
