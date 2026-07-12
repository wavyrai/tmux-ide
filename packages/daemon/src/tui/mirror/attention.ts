/**
 * In-app attention surfacing (M25.1) — the PURE half of "an agent you can't
 * see needs you". The app's 3s fleet poll diffs the previous per-pane agent
 * states against the fresh payload; blocked/done transitions for agents NOT on
 * the current screen (another workspace, another window, or a non-Terminal
 * tab) become a status-strip note plus a brief sidebar flash. The diff, the
 * visibility test, and the note text live here so they unit-test without
 * OpenTUI; app.tsx supplies the signals and timers.
 *
 * First sight is graced exactly like the chrome updater's notification path
 * (`from: null` never notes) — an app boot must not re-announce every agent
 * that was already blocked.
 */
import type { AgentStatus } from "../detect/classify.ts";

/** The per-agent slice of the fleet payload the diff needs. */
export interface AttentionAgent {
  paneId: string;
  session: string;
  kind: string;
  state: AgentStatus;
}

/** One agent's state change between two fleet polls. */
export interface AttentionTransition {
  paneId: string;
  session: string;
  kind: string;
  from: AgentStatus | null;
  to: AgentStatus;
}

/** What the app is currently showing — the visibility side of the test. */
export interface AttentionView {
  /** The active surface tab (only `terminal` shows panes at all). */
  tab: string;
  /** Pane ids on screen right now (the mirrored window's panes). */
  visiblePaneIds: readonly string[];
}

/** The two states worth interrupting the user over (mirrors the chrome
 *  updater's NOTIFY_STATES). */
const NOTE_STATES: ReadonlySet<AgentStatus> = new Set<AgentStatus>(["blocked", "done"]);

/**
 * PURE — diff the previous per-pane states against this poll's agents.
 * Returns the transitions plus the fresh state map to thread into the next
 * poll (the input map is NOT mutated). A pane that vanished emits nothing and
 * drops out of the state.
 */
export function diffAttention(
  prev: ReadonlyMap<string, AgentStatus>,
  agents: readonly AttentionAgent[],
): { transitions: AttentionTransition[]; next: Map<string, AgentStatus> } {
  const next = new Map<string, AgentStatus>();
  const transitions: AttentionTransition[] = [];
  for (const a of agents) {
    if (next.has(a.paneId)) continue; // deduped: a session can surface under two projects
    const before = prev.has(a.paneId) ? prev.get(a.paneId)! : null;
    next.set(a.paneId, a.state);
    if (before === a.state) continue;
    transitions.push({
      paneId: a.paneId,
      session: a.session,
      kind: a.kind,
      from: before,
      to: a.state,
    });
  }
  return { transitions, next };
}

/** PURE — is this pane on the app's screen right now? Only the Terminal tab
 *  shows panes; there, exactly the mirrored window's panes are visible. */
export function isPaneVisible(paneId: string, view: AttentionView): boolean {
  return view.tab === "terminal" && view.visiblePaneIds.includes(paneId);
}

/**
 * PURE — the transitions worth a note: blocked/done, not first-sight, and not
 * currently visible (the user can see a visible pane flip themselves).
 */
export function noteworthyTransitions(
  transitions: readonly AttentionTransition[],
  view: AttentionView,
): AttentionTransition[] {
  return transitions.filter(
    (t) => t.from !== null && NOTE_STATES.has(t.to) && !isPaneVisible(t.paneId, view),
  );
}

/** PURE — the status-strip note for one transition, e.g.
 *  `● claude blocked · zz-api — click agents`. Done reads `✓ … — click agents`. */
export function attentionNote(t: AttentionTransition): string {
  const glyph = t.to === "blocked" ? "●" : "✓";
  return `${glyph} ${t.kind} ${t.to} · ${t.session} — click agents`;
}

/** PURE — the note line for a whole poll's noteworthy set: the first (most
 *  recent diff order) transition's note, with a `(+N)` tail when several agents
 *  flipped in the same poll. Null for an empty set. */
export function attentionNoteLine(worthy: readonly AttentionTransition[]): string | null {
  const first = worthy[0];
  if (!first) return null;
  const extra = worthy.length > 1 ? ` (+${worthy.length - 1})` : "";
  return `${attentionNote(first)}${extra}`;
}

/** How long the sidebar attention flash lasts. */
export const ATTENTION_FLASH_MS = 2500;
