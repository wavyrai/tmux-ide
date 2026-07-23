import { createHash } from "node:crypto";
import {
  AGENT_GRAPH_LABEL_MAX_LENGTH,
  projectAgentGraphOverlay,
  type AgentGraphDetectStatus,
  type AgentGraphNodeStatus,
  type AgentGraphOverlay,
  type AgentGraphProjectionGroup,
  type AgentGraphProjectionNode,
  type AgentGraphProjectionRelation,
  type AppWindowDocumentV1,
  type MissionActor,
  type MissionAttempt,
  type MissionSnapshot,
} from "@tmux-ide/contracts";
import type { MissionRepositorySnapshot } from "../../lib/mission-repository.ts";
import {
  isAgentPane,
  paneIdentities,
  resolveAgentPresentation,
  type ApplicationShellSessionFacts,
} from "./application-shell.ts";

/**
 * Inputs for the daemon-side agent-graph overlay. Every field is a durable
 * daemon fact; the raw mission snapshot (which still carries attempt terminal /
 * session targets) is correlated to durable window ids HERE and never leaves.
 */
export interface AgentGraphOverlayProjectionInput {
  readonly session: ApplicationShellSessionFacts;
  readonly appWindows: AppWindowDocumentV1;
  /** Raw mission state + history. Absent (or null) yields a nodes-only overlay. */
  readonly missionSnapshot?: MissionRepositorySnapshot | null;
  readonly nowSec: number;
}

/**
 * The `@ide_role` values (besides `lead`) that a session lead is inferred to
 * relate to. Kept in lockstep with the roles {@link isAgentPane} recognizes.
 */
const INFERRED_SUBORDINATE_ROLES: ReadonlySet<string> = new Set([
  "teammate",
  "planner",
  "validator",
  "researcher",
]);

/** Order-independent key for the unordered window pair an edge connects. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** Narrow the detect status union to the four canvas node states. */
function nodeStatus(detect: AgentGraphDetectStatus): AgentGraphNodeStatus {
  // `unknown` (never a fresh authority stamp; an unrecognized scrape) settles to
  // `idle` on the canvas rather than inventing a busy state we cannot vouch for.
  return detect === "unknown" ? "idle" : detect;
}

/** Control-strip and clamp a candidate label to the overlay label grammar. */
function nodeLabel(value: string | null | undefined): string | null {
  const withoutControls = Array.from(value ?? "", (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
  }).join("");
  const normalized = withoutControls
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, AGENT_GRAPH_LABEL_MAX_LENGTH);
  return normalized.length > 0 ? normalized : null;
}

/** Opaque, prefixed mission-group id derived from the durable mission id. */
function groupId(missionId: string): string {
  const token = createHash("sha256").update(missionId).digest("hex").slice(0, 32);
  return `group.${token}`;
}

/**
 * Build the runtime agent-graph overlay entirely from durable daemon facts.
 *
 * Nodes are the agent panes that already have a durable AppWindow on the canvas,
 * keyed by that window's instance id and carrying the SAME ground-truth status
 * the shell projection computes via {@link resolveAgentPresentation} — there is
 * one status decision function, not a second classifier here.
 *
 * Ground-truth relationships come from missions (never from `@agent_session_id`):
 * a group is a mission (same identity/label the Missions surface reads), a
 * `spawned` edge is a mission attempt whose starting actor is an agent that is
 * itself running a correlated attempt in the mission, and a `mission` edge is
 * co-membership when no spawn relationship is derivable. Every attempt terminal /
 * session reference is correlated to a durable window id here; a correlation that
 * fails simply yields no edge — a raw pane id, session name, or path is never
 * emitted.
 *
 * Two weaker INFERRED edge kinds are derived from durable pane stamps alone, so
 * relationships are visible without a mission resource: an `inferred-role` edge
 * links a session `lead` pane to each subordinate-role pane (`@ide_role`), and an
 * `inferred-mission` edge links panes sharing an `@tmux_ide_mission` stamp. These
 * always yield to ground truth — an inferred edge is never emitted for a pair a
 * real edge connects, and an inferred mission already covered by a ground-truth
 * mission group is dropped. A session with neither stamp stays edge-free.
 *
 * PURE and total: the contract folder {@link projectAgentGraphOverlay} degrades
 * (dedupes, drops dangling edges, enforces caps) so the result always satisfies
 * the overlay schema by construction.
 */
export function projectApplicationShellAgentGraphOverlay(
  input: AgentGraphOverlayProjectionInput,
): AgentGraphOverlay {
  const { session, appWindows, missionSnapshot, nowSec } = input;

  const windowIdByTerminalSourceId = new Map<string, string>();
  for (const window of Object.values(appWindows.windows)) {
    if (window.source.kind === "terminal") {
      windowIdByTerminalSourceId.set(window.source.terminalSourceId, window.id);
    }
  }

  const identities = paneIdentities(session);
  const nodes: AgentGraphProjectionNode[] = [];
  const nodeWindowIds = new Set<string>();
  // Daemon-only correlation maps: KEYS are live/semantic pane identity used to
  // resolve mission targets; only the durable window id (the VALUE) is emitted.
  const windowIdByRuntimePaneId = new Map<string, string>();
  const windowIdBySemanticPaneId = new Map<string, string>();
  // Durable pane stamps captured per node, keyed by the emitted window id, used
  // ONLY to derive inferred edges below. The stamp values never leave.
  const leadWindowIds: string[] = [];
  const subordinateWindowIds: string[] = [];
  const missionStampMembers = new Map<string, string[]>();

  session.panes.forEach((pane, index) => {
    const terminalSourceId = identities[index]!.resourceId;
    const windowId = windowIdByTerminalSourceId.get(terminalSourceId);
    if (windowId === undefined) return; // no canvas window -> nothing to place
    if (pane.runtimePaneId) windowIdByRuntimePaneId.set(pane.runtimePaneId, windowId);
    if (pane.semanticPaneId) windowIdBySemanticPaneId.set(pane.semanticPaneId, windowId);
    if (!isAgentPane(pane)) return;
    const presentation = resolveAgentPresentation(pane, nowSec);
    nodes.push({
      windowId,
      status: nodeStatus(presentation.detectStatus),
      statusSource: presentation.statusSource,
      attention: presentation.attention,
      label: nodeLabel(presentation.displayName ?? pane.name ?? pane.title),
    });
    nodeWindowIds.add(windowId);
    if (pane.role === "lead") leadWindowIds.push(windowId);
    else if (INFERRED_SUBORDINATE_ROLES.has(pane.role ?? "")) subordinateWindowIds.push(windowId);
    const stamp = (pane.missionStamp ?? "").trim();
    if (stamp.length > 0) {
      const members = missionStampMembers.get(stamp);
      if (members) members.push(windowId);
      else missionStampMembers.set(stamp, [windowId]);
    }
  });

  const edges: AgentGraphProjectionRelation[] = [];
  const groups: AgentGraphProjectionGroup[] = [];

  const correlateAttempt = (attempt: MissionAttempt): string | null => {
    const terminal = attempt.terminal;
    if (terminal === undefined) return null;
    const windowId =
      windowIdByRuntimePaneId.get(terminal) ??
      windowIdByTerminalSourceId.get(terminal) ??
      windowIdBySemanticPaneId.get(terminal);
    // Only a correlated AGENT window (an existing node) is a usable endpoint.
    return windowId !== undefined && nodeWindowIds.has(windowId) ? windowId : null;
  };

  if (missionSnapshot) {
    const actorByAttemptId = new Map<string, MissionActor>();
    for (const entry of missionSnapshot.history) {
      if (entry.event.type === "attempt.started") {
        actorByAttemptId.set(entry.event.attemptId, entry.event.actor);
      }
    }

    for (const mission of Object.values(missionSnapshot.state.missions) as MissionSnapshot[]) {
      const attempts = Object.values(mission.attempts) as MissionAttempt[];
      const windowIdByAttemptId = new Map<string, string>();
      for (const attempt of attempts) {
        const windowId = correlateAttempt(attempt);
        if (windowId !== null) windowIdByAttemptId.set(attempt.id, windowId);
      }
      const memberWindowIds = [...new Set(windowIdByAttemptId.values())];
      if (memberWindowIds.length === 0) continue; // no correlated members -> node-only

      groups.push({
        id: groupId(mission.id),
        label: nodeLabel(mission.title) ?? "mission",
        memberWindowIds,
      });

      // spawned: an attempt started by an agent actor P that is itself the agent
      // of another correlated attempt A in this mission -> A spawned this attempt.
      const spawned: AgentGraphProjectionRelation[] = [];
      for (const child of attempts) {
        const childWindowId = windowIdByAttemptId.get(child.id);
        if (childWindowId === undefined) continue;
        const actor = actorByAttemptId.get(child.id);
        if (actor === undefined || actor.type !== "agent" || actor.id === undefined) continue;
        for (const parent of attempts) {
          if (parent.id === child.id || parent.agent !== actor.id) continue;
          const parentWindowId = windowIdByAttemptId.get(parent.id);
          if (parentWindowId === undefined || parentWindowId === childWindowId) continue;
          spawned.push({ from: parentWindowId, to: childWindowId, kind: "spawned" });
        }
      }

      if (spawned.length > 0) {
        edges.push(...spawned);
      } else if (memberWindowIds.length >= 2) {
        // No derivable parentage: link co-members from the first (sorted) window.
        const sorted = [...memberWindowIds].sort((left, right) => left.localeCompare(right));
        const lead = sorted[0]!;
        for (const member of sorted.slice(1)) {
          edges.push({ from: lead, to: member, kind: "mission" });
        }
      }
    }
  }

  // Inferred edges — derived from durable pane stamps alone, never confusable
  // with the ground-truth edges above. Ground-truth PRECEDENCE: an inferred edge
  // is never emitted for a window pair a real edge already connects, and an
  // inferred mission whose members are already a ground-truth mission's members
  // is dropped entirely. Any inferred pair, once emitted, blocks a second
  // inferred edge on the same pair so role and mission inference cannot overlap.
  const groundTruthPairs = new Set<string>();
  for (const edge of edges) groundTruthPairs.add(pairKey(edge.from, edge.to));
  const groundTruthGroupMembers = groups.map((group) => new Set(group.memberWindowIds));
  const emittedInferredPairs = new Set<string>();

  const emitInferred = (from: string, to: string, kind: "inferred-role" | "inferred-mission") => {
    if (from === to) return;
    const key = pairKey(from, to);
    if (groundTruthPairs.has(key) || emittedInferredPairs.has(key)) return;
    emittedInferredPairs.add(key);
    edges.push({ from, to, kind });
  };

  // Role inference: within one session, each `lead` pane relates to every
  // subordinate-role pane. A session with no lead (or no subordinates) yields
  // nothing — hand-made sessions correctly stay edge-free.
  for (const lead of leadWindowIds) {
    for (const subordinate of subordinateWindowIds)
      emitInferred(lead, subordinate, "inferred-role");
  }

  // Mission-stamp inference: panes sharing an `@tmux_ide_mission` value are
  // co-members. Skip a stamp whose members are already covered by a ground-truth
  // mission group; otherwise link co-members in a star from the first (sorted)
  // window, mirroring the ground-truth co-membership fallback.
  for (const members of missionStampMembers.values()) {
    const unique = [...new Set(members)];
    if (unique.length < 2) continue;
    const alreadyGrouped = groundTruthGroupMembers.some((group) =>
      unique.every((windowId) => group.has(windowId)),
    );
    if (alreadyGrouped) continue;
    const sorted = [...unique].sort((left, right) => left.localeCompare(right));
    const lead = sorted[0]!;
    for (const member of sorted.slice(1)) emitInferred(lead, member, "inferred-mission");
  }

  return projectAgentGraphOverlay({ nodes, edges, groups }).overlay;
}
