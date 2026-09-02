import {
  DAEMON_WIRE_PROTOCOL_VERSION,
  type DaemonInstanceIdentity,
  type FleetCatalogResourceV1,
} from "@tmux-ide/contracts";

/**
 * Shared, contract-valid fleet-catalog fixtures for the fleet store tests and
 * the sidebar/graph component fixtures. Every id here satisfies the opaque
 * `session.<token>` / `agent.<token>` grammar so the resource parses cleanly.
 */

export const FLEET_FIXTURE_DAEMON: DaemonInstanceIdentity = {
  protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
  productVersion: "2.8.0",
  instanceId: "b2f4c6d8-0a1b-4c3d-8e5f-60718293a4b5",
  startedAt: "2026-07-21T00:00:00.000Z",
};

/**
 * A mixed fleet: an app-created session with a working agent, an adopted-only
 * session with a blocked agent wanting attention, and an agent-free session.
 */
export function mixedFleetCatalog(
  daemon: DaemonInstanceIdentity = FLEET_FIXTURE_DAEMON,
): FleetCatalogResourceV1 {
  return {
    version: 1,
    daemon,
    sessions: [
      {
        sessionId: "session.aaaaaaaaaaaaaaaa",
        label: "web",
        projectLabel: "web-app",
        appCreated: true,
        paneCount: 3,
        agents: [
          {
            agentId: "agent.aaaaaaaaaaaaaaaa",
            name: "Claude",
            harness: "claude-code",
            activity: "running",
            attention: false,
            statusSource: "authority",
          },
          {
            agentId: "agent.aaaaaaaaaaaaaaab",
            name: "Codex",
            harness: "codex",
            activity: "complete",
            attention: false,
            statusSource: "authority",
          },
        ],
      },
      {
        sessionId: "session.bbbbbbbbbbbbbbbb",
        label: "api",
        projectLabel: "api-svc",
        appCreated: false,
        paneCount: 2,
        agents: [
          {
            agentId: "agent.bbbbbbbbbbbbbbbb",
            name: "Reviewer",
            harness: "custom",
            activity: "waiting",
            attention: true,
            statusSource: "authority",
          },
        ],
      },
      {
        sessionId: "session.cccccccccccccccc",
        label: "scratch",
        projectLabel: "scratch",
        appCreated: false,
        paneCount: 1,
        agents: [],
      },
    ],
  };
}

export function emptyFleetCatalog(
  daemon: DaemonInstanceIdentity = FLEET_FIXTURE_DAEMON,
): FleetCatalogResourceV1 {
  return { version: 1, daemon, sessions: [] };
}
