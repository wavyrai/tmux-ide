import {
  AGENT_GRAPH_MAX_GROUPS,
  AGENT_GRAPH_MAX_NODES,
  projectAgentGraphOverlay,
  projectFleetAgentGraphOverlay,
  type AgentGraphOverlay,
  type AgentGraphProjectionGroup,
  type AgentGraphProjectionNode,
  type AgentGraphProjectionRelation,
  type FleetAgentGraphProjectionSession,
  type FleetCatalogResourceV1,
} from "@tmux-ide/contracts";

/**
 * Renderer-side composition of the open workspace's agent-graph overlay with the
 * read-only fleet catalog (card m40/fleet-4 item 4). The two resources are
 * composed HERE, not daemon-side, and the result still satisfies every overlay
 * invariant because the merge folds through {@link projectAgentGraphOverlay}.
 *
 * Fleet nodes are display-only by construction: the contracts fleet projector
 * keys every fleet node under the reserved, non-attachable `terminal.discovered.`
 * id form, so no fleet node id can ever collide with the open workspace's real
 * semantic node ids or pass an attachment authority.
 *
 * Cap discipline: the overlay caps are hard. If folding the fleet in WOULD
 * exceed them, the merge is REJECTED wholesale — the canvas keeps the exact
 * open-workspace overlay and the caller shows a truncated indicator — rather
 * than rendering a half-trimmed, misleading fleet.
 */

export interface FleetGraphMergeInput {
  /** The open workspace's overlay (the per-workspace V3 projection). */
  readonly openOverlay: AgentGraphOverlay;
  /** The current fleet catalog snapshot. */
  readonly fleet: FleetCatalogResourceV1;
  /**
   * Fleet session ids to leave out — normally the open workspace's own session,
   * so it is not drawn twice. The renderer cannot yet correlate the open
   * workspace to its opaque fleet session id (that needs a daemon-provided key),
   * so callers pass an empty set until that correlation exists.
   */
  readonly excludeSessionIds?: ReadonlySet<string>;
}

export interface FleetGraphMergeResult {
  /** The overlay to feed the canvas — merged, or the untouched open overlay. */
  readonly overlay: AgentGraphOverlay;
  /** True when fleet context was dropped or trimmed (composition is incomplete). */
  readonly truncated: boolean;
  /** True when at least one fleet node was actually merged in. */
  readonly fleetIncluded: boolean;
}

function overlayToProjectionNodes(overlay: AgentGraphOverlay): AgentGraphProjectionNode[] {
  return Object.values(overlay.nodes).map((node) => ({
    windowId: node.windowId,
    status: node.status,
    statusSource: node.statusSource,
    attention: node.attention,
    label: node.label,
  }));
}

function overlayToProjectionEdges(overlay: AgentGraphOverlay): AgentGraphProjectionRelation[] {
  return overlay.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind }));
}

function overlayToProjectionGroups(overlay: AgentGraphOverlay): AgentGraphProjectionGroup[] {
  return overlay.groups.map((group) => ({
    id: group.id,
    label: group.label,
    memberWindowIds: [...group.memberWindowIds],
  }));
}

/**
 * Compose the fleet into the open overlay. Pure and total: it never throws and
 * always returns a schema-valid overlay. See the file header for the cap rule.
 */
export function mergeFleetGraphOverlay(input: FleetGraphMergeInput): FleetGraphMergeResult {
  const exclude = input.excludeSessionIds ?? new Set<string>();

  const otherSessions: FleetAgentGraphProjectionSession[] = input.fleet.sessions
    .filter((session) => !exclude.has(session.sessionId))
    .map((session) => ({
      sessionId: session.sessionId,
      label: session.label,
      agents: session.agents.map((agent) => ({
        agentId: agent.agentId,
        name: agent.name,
        activity: agent.activity,
        attention: agent.attention,
        statusSource: agent.statusSource,
      })),
    }));

  const fleetProjection = projectFleetAgentGraphOverlay({ sessions: otherSessions });
  const fleetNodes = overlayToProjectionNodes(fleetProjection.overlay);
  const fleetGroups = overlayToProjectionGroups(fleetProjection.overlay);

  if (fleetNodes.length === 0 && fleetGroups.length === 0) {
    // Nothing to add (empty fleet, or every session excluded). Keep the open
    // overlay untouched; `truncated` only if the fleet projector itself trimmed.
    return {
      overlay: input.openOverlay,
      truncated: fleetProjection.truncated,
      fleetIncluded: false,
    };
  }

  const openNodes = overlayToProjectionNodes(input.openOverlay);
  const openGroups = overlayToProjectionGroups(input.openOverlay);

  // Reject the merge outright if it would breach a hard cap: an over-cap fleet
  // is dropped in full, not silently half-rendered.
  if (
    openNodes.length + fleetNodes.length > AGENT_GRAPH_MAX_NODES ||
    openGroups.length + fleetGroups.length > AGENT_GRAPH_MAX_GROUPS
  ) {
    return { overlay: input.openOverlay, truncated: true, fleetIncluded: false };
  }

  const folded = projectAgentGraphOverlay({
    nodes: [...openNodes, ...fleetNodes],
    edges: overlayToProjectionEdges(input.openOverlay),
    groups: [...openGroups, ...fleetGroups],
  });

  return {
    overlay: folded.overlay,
    truncated: fleetProjection.truncated || folded.truncated,
    fleetIncluded: true,
  };
}
