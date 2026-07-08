/**
 * Per-pane agent chips for the unified app (M22.3) — PURE.
 *
 * The fleet payload (`tmux-ide team --json`) carries per-pane agent entries
 * (`agents: PaneAgentEntry[]`, M22.1). This module is the io-free half of the
 * Terminal surface's pane chips: the paneId→entry join, the label builder, and
 * the width-degrading truncation. The render side (app.tsx) styles the label
 * with the app's own STATUS_COLOR/STATUS_GLYPH grammar — the OpenTUI-side
 * mirror of the dock chip grammar in tui/chrome/chip.ts — so a pane chip in
 * the app reads the same as its sidebar/home glyphs. The glyph travels IN as a
 * parameter: this module carries no grammar constants of its own (they live
 * with the app; see the status-grammar coordination note in the M22 board).
 *
 * Staleness is NOT re-implemented here: the report already applies the
 * authority staleness window and falls back to scraping, so `state` is always
 * the final answer — this module only joins and formats.
 */
import type { AgentStatus } from "../detect/classify.ts";

/** The slice of a fleet `PaneAgentEntry` the chip needs (structural — the app
 *  declares its fleet shapes locally instead of importing the data layer). */
export interface ChipAgent {
  /** tmux pane id (`%N`) — the mirror's pane ids are the same ids, so the join
   *  is a straight map lookup. */
  paneId: string;
  /** Resolved agent kind (manifest id: `claude`, `codex`, …). */
  kind: string;
  /** Final per-pane status (authority when fresh, else scraped/tracked). */
  state: AgentStatus;
  /** Authority epoch (SECONDS) when the authority layer supplied the state;
   *  null for scraped panes. Feeds the "blocked 4m" age suffix. */
  since: number | null;
}

/**
 * Flatten a fleet payload into a paneId→entry map. Tolerates sessions without
 * an `agents` field (older payloads degrade to no chips, never a crash).
 * First entry wins on a duplicate paneId (a session listed under two projects
 * repeats its panes; pane ids are server-global so the entries are identical).
 */
export function agentsByPane(
  projects: ReadonlyArray<{
    sessions: ReadonlyArray<{ agents?: ReadonlyArray<ChipAgent> }>;
  }>,
): Map<string, ChipAgent> {
  const map = new Map<string, ChipAgent>();
  for (const p of projects)
    for (const s of p.sessions)
      for (const a of s.agents ?? []) if (!map.has(a.paneId)) map.set(a.paneId, a);
  return map;
}

/**
 * Compact age of a state stamp — "32s" / "4m" / "2h" / "3d" — or null when
 * there is no authoritative timestamp (scraped pane). Negative skew clamps to
 * "0s" rather than inventing time travel.
 */
export function stateAge(since: number | null, nowMs: number): string | null {
  if (since === null) return null;
  const s = Math.max(0, Math.floor(nowMs / 1000 - since));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * Build a chip label that fits `budget` cells (the printable text, WITHOUT the
 * one-cell padding the renderer adds each side). Degrades in steps rather than
 * mid-word ellipsis so a narrow pane still reads:
 *
 *   `● claude · blocked 4m`   blocked, authority age known
 *   `● claude · blocked`      blocked, scraped (no stamp)
 *   `● claude`                any other state (color carries the state)
 *   `●`                       narrow pane
 *   null                      no room at all (or a hidden-worthy budget < 1)
 *
 * Only `blocked` spells its state out — it is the attention state; everything
 * else leans on the glyph color, matching the dock chips' quiet default.
 */
export function chipLabel(
  entry: ChipAgent,
  glyph: string,
  nowMs: number,
  budget: number,
): string | null {
  const base = `${glyph} ${entry.kind}`;
  const candidates: string[] = [];
  if (entry.state === "blocked") {
    const age = stateAge(entry.since, nowMs);
    if (age) candidates.push(`${base} · blocked ${age}`);
    candidates.push(`${base} · blocked`);
  }
  candidates.push(base, glyph);
  for (const c of candidates) if (c.length <= budget) return c;
  return null;
}
