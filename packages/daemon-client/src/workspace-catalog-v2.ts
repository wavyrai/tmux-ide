import {
  WorkspaceCatalogResourceV2SchemaZ,
  type WorkspaceCatalogIntentV2,
  type WorkspaceCatalogLiveSessionV2,
} from "@tmux-ide/contracts";

/**
 * A full, validated catalog snapshot. Catalog intent is deliberately retained
 * separately from observed tmux sessions so stopped workspaces cannot acquire
 * an actionable pane merely because they were persisted.
 */
export interface WorkspaceCatalogV2State {
  readonly daemonInstanceId: string | null;
  readonly intents: readonly WorkspaceCatalogIntentV2[];
  readonly liveSessions: readonly WorkspaceCatalogLiveSessionV2[];
}

export function initialWorkspaceCatalogV2State(): WorkspaceCatalogV2State {
  return { daemonInstanceId: null, intents: [], liveSessions: [] };
}

/**
 * Validate and atomically replace a catalog snapshot.
 *
 * This is replacement, not merge, by design. A daemon generation is an
 * authority boundary: when it changes no intent or live tmux observation from
 * the retired generation survives. Availability is also recomputed from the
 * observed live-session collection instead of trusting the convenience field
 * on durable intent.
 */
export function replaceWorkspaceCatalogV2(
  _previous: WorkspaceCatalogV2State,
  input: unknown,
): WorkspaceCatalogV2State {
  const resource = WorkspaceCatalogResourceV2SchemaZ.parse(input);
  const liveByName = new Map<string, WorkspaceCatalogLiveSessionV2>();
  const liveByFleetSessionId = new Map<string, WorkspaceCatalogLiveSessionV2>();
  for (const session of resource.liveSessions) {
    if (liveByName.has(session.sessionName)) {
      throw new TypeError(
        `workspace catalog contains duplicate live session ${session.sessionName}`,
      );
    }
    if (liveByFleetSessionId.has(session.fleetSessionId)) {
      throw new TypeError(
        `workspace catalog contains duplicate fleet session ${session.fleetSessionId}`,
      );
    }
    liveByName.set(session.sessionName, session);
    liveByFleetSessionId.set(session.fleetSessionId, session);
  }

  return {
    daemonInstanceId: resource.daemon.instanceId,
    intents: resource.intents.map((intent) => ({
      ...intent,
      availability: liveByName.has(intent.sessionName) ? "live" : "stopped",
    })),
    liveSessions: [...liveByName.values()],
  };
}

/** A one-shot boundary for hosts whose generation lifecycle lives elsewhere. */
export function decodeWorkspaceCatalogV2(input: unknown): WorkspaceCatalogV2State {
  return replaceWorkspaceCatalogV2(initialWorkspaceCatalogV2State(), input);
}
