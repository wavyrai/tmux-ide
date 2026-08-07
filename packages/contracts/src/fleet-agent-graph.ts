/**
 * The fleet agent-graph projector — folds the read-only {@link ./fleet-catalog.ts}
 * shape into the EXISTING {@link ./agent-graph-overlay.ts} overlay so the desktop
 * canvas can render the whole fleet with one renderer, not two.
 *
 * Structural guarantees, all by construction:
 * - One node per agent, keyed by the reserved `terminal.discovered.` identity
 *   form. That prefix is exactly what {@link TerminalAttachmentSemanticPaneIdSchemaZ}
 *   REJECTS, so a fleet node id can never pass an attachment authority — the
 *   nodes are display-only and non-attachable no matter what a consumer does.
 * - One group per session (`group.<token>` carrying the session label), its
 *   members being that session's agent nodes.
 * - No edges: mission/spawn edges stay workspace-scoped for now.
 *
 * PURE and it DEGRADES rather than throwing — fleet-scale caps and any
 * structurally impossible id are trimmed with an honest `truncated` flag, and
 * the final fold runs through {@link projectAgentGraphOverlay} so every overlay
 * invariant (record-key/id match, dedupe, caps) holds.
 */
import {
  projectAgentGraphOverlay,
  type AgentGraphNodeStatus,
  type AgentGraphOverlay,
  type AgentGraphProjectionGroup,
  type AgentGraphProjectionNode,
  type AgentGraphStatusSource,
} from "./agent-graph-overlay.ts";
import {
  FLEET_MAX_AGENTS_PER_SESSION,
  FLEET_MAX_SESSIONS,
  FLEET_MAX_TOTAL_AGENTS,
  FleetAgentIdSchemaZ,
  FleetSessionIdSchemaZ,
} from "./fleet-catalog.ts";
import type { AgentActivity } from "./pane-appearance.ts";
import { RESERVED_DISCOVERED_TERMINAL_ID_PREFIX } from "./semantic-identity.ts";

/**
 * Exhaustive map from the sidebar activity union to the four canvas node states.
 * The overlay node status has no `failed`/`disconnected` — `failed` surfaces as
 * `blocked` (it wants the user), and `disconnected` settles to `idle`.
 *
 * | activity     | node status |
 * | ------------ | ----------- |
 * | running      | working     |
 * | waiting      | blocked     |
 * | failed       | blocked     |
 * | complete     | done        |
 * | idle         | idle        |
 * | disconnected | idle        |
 */
const ACTIVITY_TO_NODE_STATUS: Readonly<Record<AgentActivity, AgentGraphNodeStatus>> =
  Object.freeze({
    idle: "idle",
    running: "working",
    waiting: "blocked",
    complete: "done",
    failed: "blocked",
    disconnected: "idle",
  });

/** Map a fleet agent's activity to its canvas node status. PURE and total. */
export function fleetActivityToNodeStatus(activity: AgentActivity): AgentGraphNodeStatus {
  return ACTIVITY_TO_NODE_STATUS[activity];
}

/**
 * The reserved, non-attachable display node id for a fleet agent: the agent's
 * opaque id under the `terminal.discovered.` prefix. Returns `null` when the
 * agent id is not a well-formed `agent.<token>` (the caller then skips it).
 */
export function fleetDisplayNodeId(agentId: string): string | null {
  if (!FleetAgentIdSchemaZ.safeParse(agentId).success) return null;
  return `${RESERVED_DISCOVERED_TERMINAL_ID_PREFIX}${agentId}`;
}

/**
 * The session group id, derived from the session's opaque token so it satisfies
 * the overlay's `group.<token>` grammar. Returns `null` for a malformed session
 * id (the caller then skips the whole session).
 */
export function fleetSessionGroupId(sessionId: string): string | null {
  if (!FleetSessionIdSchemaZ.safeParse(sessionId).success) return null;
  return `group.${sessionId.slice("session.".length)}`;
}

/** One agent as handed to the fleet projector (field-typed, not cross-checked). */
export interface FleetAgentGraphProjectionAgent {
  readonly agentId: string;
  readonly name: string;
  readonly activity: AgentActivity;
  readonly attention: boolean;
  readonly statusSource: AgentGraphStatusSource;
}

/** One session as handed to the fleet projector. */
export interface FleetAgentGraphProjectionSession {
  readonly sessionId: string;
  readonly label: string;
  readonly agents: readonly FleetAgentGraphProjectionAgent[];
}

export interface FleetAgentGraphProjectionInput {
  readonly sessions: readonly FleetAgentGraphProjectionSession[];
}

export interface FleetAgentGraphProjectionResult {
  readonly overlay: AgentGraphOverlay;
  /** True when any fleet or overlay cap forced honest truncation. */
  readonly truncated: boolean;
}

/**
 * Fold a fleet-catalog-shaped input into a structurally valid agent-graph
 * overlay. See the file header for the guarantees; the returned overlay
 * satisfies every {@link projectAgentGraphOverlay} invariant.
 */
export function projectFleetAgentGraphOverlay(
  input: FleetAgentGraphProjectionInput,
): FleetAgentGraphProjectionResult {
  let truncated = false;

  const nodes: AgentGraphProjectionNode[] = [];
  const groups: AgentGraphProjectionGroup[] = [];
  let sessionCount = 0;

  for (const session of input.sessions) {
    const groupId = fleetSessionGroupId(session.sessionId);
    if (groupId === null) {
      truncated = true;
      continue;
    }
    if (sessionCount >= FLEET_MAX_SESSIONS) {
      truncated = true;
      continue;
    }
    sessionCount += 1;

    const memberWindowIds: string[] = [];
    let agentCount = 0;
    for (const agent of session.agents) {
      const windowId = fleetDisplayNodeId(agent.agentId);
      if (windowId === null) {
        truncated = true;
        continue;
      }
      if (agentCount >= FLEET_MAX_AGENTS_PER_SESSION) {
        truncated = true;
        continue;
      }
      if (nodes.length >= FLEET_MAX_TOTAL_AGENTS) {
        truncated = true;
        continue;
      }
      agentCount += 1;
      nodes.push({
        windowId,
        status: fleetActivityToNodeStatus(agent.activity),
        statusSource: agent.statusSource,
        attention: agent.attention,
        label: agent.name,
      });
      memberWindowIds.push(windowId);
    }

    groups.push({ id: groupId, label: session.label, memberWindowIds });
  }

  const folded = projectAgentGraphOverlay({ nodes, edges: [], groups });
  return { overlay: folded.overlay, truncated: truncated || folded.truncated };
}
