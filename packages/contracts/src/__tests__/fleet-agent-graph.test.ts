import { describe, expect, it } from "vitest";
import { AgentGraphOverlaySchemaZ } from "../agent-graph-overlay.ts";
import {
  fleetActivityToNodeStatus,
  fleetDisplayNodeId,
  fleetSessionGroupId,
  projectFleetAgentGraphOverlay,
  type FleetAgentGraphProjectionSession,
} from "../fleet-agent-graph.ts";
import {
  FLEET_MAX_AGENTS_PER_SESSION,
  FLEET_MAX_SESSIONS,
  FLEET_MAX_TOTAL_AGENTS,
} from "../fleet-catalog.ts";
import { AGENT_ACTIVITY_IDS, type AgentActivity } from "../pane-appearance.ts";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "../semantic-identity.ts";

function agent(
  token: string,
  overrides: Partial<FleetAgentGraphProjectionSession["agents"][number]> = {},
): FleetAgentGraphProjectionSession["agents"][number] {
  return {
    agentId: `agent.${token}`,
    name: "reviewer",
    activity: "running",
    attention: false,
    statusSource: "authority",
    ...overrides,
  };
}

function session(
  token: string,
  agents: FleetAgentGraphProjectionSession["agents"],
): FleetAgentGraphProjectionSession {
  return { sessionId: `session.${token}`, label: `fleet-${token.slice(0, 4)}`, agents };
}

const SESSION_A = "0123456789abcdef01";
const SESSION_B = "fedcba9876543210ff";

describe("fleetActivityToNodeStatus", () => {
  it("is total over the activity union", () => {
    for (const activity of AGENT_ACTIVITY_IDS) {
      expect(() => fleetActivityToNodeStatus(activity)).not.toThrow();
    }
  });

  it("maps each activity to its canvas status", () => {
    const expected: Record<AgentActivity, string> = {
      idle: "idle",
      running: "working",
      waiting: "blocked",
      complete: "done",
      failed: "blocked",
      disconnected: "idle",
    };
    for (const activity of AGENT_ACTIVITY_IDS) {
      expect(fleetActivityToNodeStatus(activity)).toBe(expected[activity]);
    }
  });
});

describe("fleet id derivation", () => {
  it("keys nodes under the reserved non-attachable prefix", () => {
    const nodeId = fleetDisplayNodeId(`agent.${SESSION_A}`);
    expect(nodeId).toBe(`terminal.discovered.agent.${SESSION_A}`);
  });

  it("returns null for a malformed agent id", () => {
    expect(fleetDisplayNodeId("%7")).toBeNull();
    expect(fleetDisplayNodeId("agent.$bad")).toBeNull();
  });

  it("derives a group id from the session token", () => {
    expect(fleetSessionGroupId(`session.${SESSION_A}`)).toBe(`group.${SESSION_A}`);
  });

  it("returns null for a malformed session id", () => {
    expect(fleetSessionGroupId("$3")).toBeNull();
  });
});

describe("projectFleetAgentGraphOverlay", () => {
  it("projects an empty fleet to an empty, untruncated overlay", () => {
    const result = projectFleetAgentGraphOverlay({ sessions: [] });
    expect(result.truncated).toBe(false);
    expect(Object.keys(result.overlay.nodes)).toHaveLength(0);
    expect(result.overlay.groups).toHaveLength(0);
    expect(result.overlay.edges).toHaveLength(0);
    expect(AgentGraphOverlaySchemaZ.safeParse(result.overlay).success).toBe(true);
  });

  it("emits a group with no members for a session with zero agents", () => {
    const result = projectFleetAgentGraphOverlay({ sessions: [session(SESSION_A, [])] });
    expect(result.truncated).toBe(false);
    expect(result.overlay.groups).toHaveLength(1);
    expect(result.overlay.groups[0]!.id).toBe(`group.${SESSION_A}`);
    expect(result.overlay.groups[0]!.memberWindowIds).toHaveLength(0);
    expect(Object.keys(result.overlay.nodes)).toHaveLength(0);
  });

  it("projects agents across sessions into nodes, groups, and no edges", () => {
    const result = projectFleetAgentGraphOverlay({
      sessions: [
        session(SESSION_A, [agent("aaaaaaaaaaaaaaaa01"), agent("aaaaaaaaaaaaaaaa02")]),
        session(SESSION_B, [agent("bbbbbbbbbbbbbbbb01")]),
      ],
    });
    expect(result.truncated).toBe(false);
    expect(Object.keys(result.overlay.nodes)).toHaveLength(3);
    expect(result.overlay.edges).toHaveLength(0);
    expect(result.overlay.groups).toHaveLength(2);
    const groupA = result.overlay.groups.find((group) => group.id === `group.${SESSION_A}`)!;
    expect(groupA.memberWindowIds).toEqual([
      "terminal.discovered.agent.aaaaaaaaaaaaaaaa01",
      "terminal.discovered.agent.aaaaaaaaaaaaaaaa02",
    ]);
    expect(AgentGraphOverlaySchemaZ.safeParse(result.overlay).success).toBe(true);
  });

  it("carries status, attention, statusSource, and label onto the node", () => {
    const result = projectFleetAgentGraphOverlay({
      sessions: [
        session(SESSION_A, [
          agent("aaaaaaaaaaaaaaaa01", {
            name: "planner",
            activity: "waiting",
            attention: true,
            statusSource: "scrape",
          }),
        ]),
      ],
    });
    const node = result.overlay.nodes["terminal.discovered.agent.aaaaaaaaaaaaaaaa01"]!;
    expect(node.status).toBe("blocked");
    expect(node.attention).toBe(true);
    expect(node.statusSource).toBe("scrape");
    expect(node.label).toBe("planner");
  });

  it("produces node ids that no attachment authority will accept", () => {
    const result = projectFleetAgentGraphOverlay({
      sessions: [session(SESSION_A, [agent("aaaaaaaaaaaaaaaa01")])],
    });
    for (const nodeId of Object.keys(result.overlay.nodes)) {
      expect(TerminalAttachmentSemanticPaneIdSchemaZ.safeParse(nodeId).success).toBe(false);
    }
  });

  it("collapses an agent id duplicated across sessions and reports truncation", () => {
    const result = projectFleetAgentGraphOverlay({
      sessions: [
        session(SESSION_A, [agent("aaaaaaaaaaaaaaaa01")]),
        session(SESSION_B, [agent("aaaaaaaaaaaaaaaa01")]),
      ],
    });
    expect(result.truncated).toBe(true);
    // The duplicate agent collapses to a single node; both session groups keep a
    // reference to the one surviving node, and the overlay stays structurally valid.
    expect(Object.keys(result.overlay.nodes)).toHaveLength(1);
    const groupB = result.overlay.groups.find((group) => group.id === `group.${SESSION_B}`)!;
    expect(groupB.memberWindowIds).toEqual(["terminal.discovered.agent.aaaaaaaaaaaaaaaa01"]);
    expect(AgentGraphOverlaySchemaZ.safeParse(result.overlay).success).toBe(true);
  });

  it("skips a malformed session and marks truncation", () => {
    const result = projectFleetAgentGraphOverlay({
      sessions: [
        { sessionId: "$bad", label: "broken", agents: [agent("aaaaaaaaaaaaaaaa01")] },
        session(SESSION_A, [agent("aaaaaaaaaaaaaaaa02")]),
      ],
    });
    expect(result.truncated).toBe(true);
    expect(result.overlay.groups).toHaveLength(1);
    expect(Object.keys(result.overlay.nodes)).toHaveLength(1);
  });

  it("skips a malformed agent id but keeps its session", () => {
    const result = projectFleetAgentGraphOverlay({
      sessions: [
        session(SESSION_A, [
          {
            agentId: "%7",
            name: "raw",
            activity: "running",
            attention: false,
            statusSource: "unknown",
          },
          agent("aaaaaaaaaaaaaaaa02"),
        ]),
      ],
    });
    expect(result.truncated).toBe(true);
    expect(result.overlay.groups).toHaveLength(1);
    expect(Object.keys(result.overlay.nodes)).toHaveLength(1);
  });

  it("truncates sessions beyond the fleet session cap", () => {
    const sessions = Array.from({ length: FLEET_MAX_SESSIONS + 5 }, (_unused, index) =>
      session(`sessiontoken${String(index).padStart(6, "0")}`, []),
    );
    const result = projectFleetAgentGraphOverlay({ sessions });
    expect(result.truncated).toBe(true);
    expect(result.overlay.groups).toHaveLength(FLEET_MAX_SESSIONS);
  });

  it("truncates agents beyond the per-session cap", () => {
    const agents = Array.from({ length: FLEET_MAX_AGENTS_PER_SESSION + 5 }, (_unused, index) =>
      agent(`agenttoken000${String(index).padStart(6, "0")}`),
    );
    const result = projectFleetAgentGraphOverlay({ sessions: [session(SESSION_A, agents)] });
    expect(result.truncated).toBe(true);
    expect(result.overlay.groups[0]!.memberWindowIds).toHaveLength(FLEET_MAX_AGENTS_PER_SESSION);
    expect(AgentGraphOverlaySchemaZ.safeParse(result.overlay).success).toBe(true);
  });

  it("truncates total agents beyond the fleet cap", () => {
    let counter = 0;
    const sessions = Array.from({ length: 6 }, (_unused, sessionIndex) => {
      const agents = Array.from({ length: FLEET_MAX_AGENTS_PER_SESSION }, () =>
        agent(`agenttoken${String(counter++).padStart(8, "0")}`),
      );
      return session(`sessiontoken${String(sessionIndex).padStart(6, "0")}`, agents);
    });
    const result = projectFleetAgentGraphOverlay({ sessions });
    expect(result.truncated).toBe(true);
    expect(Object.keys(result.overlay.nodes)).toHaveLength(FLEET_MAX_TOTAL_AGENTS);
    expect(AgentGraphOverlaySchemaZ.safeParse(result.overlay).success).toBe(true);
  });
});
