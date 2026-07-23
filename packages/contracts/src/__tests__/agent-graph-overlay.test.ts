import { describe, expect, it } from "vitest";
import {
  AGENT_GRAPH_LABEL_MAX_LENGTH,
  AGENT_GRAPH_MAX_EDGES,
  AGENT_GRAPH_MAX_GROUP_MEMBERS,
  AGENT_GRAPH_MAX_GROUPS,
  AGENT_GRAPH_MAX_NODES,
  AgentGraphEdgeKindSchemaZ,
  AgentGraphGroupIdSchemaZ,
  AgentGraphLabelSchemaZ,
  AgentGraphNodeSchemaZ,
  AgentGraphOverlaySchemaZ,
  isInferredEdgeKind,
  projectAgentGraphOverlay,
  resolveAgentStatusPresentation,
  type AgentGraphDetectStatus,
  type AgentGraphEdgeKind,
  type AgentGraphNode,
  type AgentGraphOverlay,
  type AgentGraphProjectionNode,
} from "../agent-graph-overlay.ts";
import { AGENT_ACTIVITY_IDS, CANONICAL_DOMAIN_STATUS_IDS } from "../pane-appearance.ts";

const NUL = String.fromCharCode(0);
const BELL = String.fromCharCode(7);
const TAB = String.fromCharCode(9);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const VALID_GROUP_ID = "group.0123456789abcdef";

function node(windowId: string, overrides: Partial<AgentGraphNode> = {}): AgentGraphNode {
  return {
    windowId,
    status: "working",
    statusSource: "authority",
    attention: false,
    label: windowId,
    ...overrides,
  };
}

function overlay(
  nodes: AgentGraphNode[],
  rest: Partial<AgentGraphOverlay> = {},
): AgentGraphOverlay {
  const record: Record<string, AgentGraphNode> = {};
  for (const n of nodes) record[n.windowId] = n;
  return { nodes: record, edges: [], groups: [], ...rest } as AgentGraphOverlay;
}

describe("agent-graph node/group id schemas", () => {
  it("keys nodes by durable AppWindow ids and rejects raw pane ids, sessions, and paths", () => {
    expect(AgentGraphOverlaySchemaZ.safeParse(overlay([node("terminal.abc")])).success).toBe(true);
    expect(AgentGraphOverlaySchemaZ.safeParse(overlay([node("native.home")])).success).toBe(true);

    // A raw tmux pane id starts with `%` — never a valid key.
    expect(AgentGraphOverlaySchemaZ.safeParse(overlay([node("%12")])).success).toBe(false);
    // A session name with a space is not a durable id.
    expect(AgentGraphOverlaySchemaZ.safeParse(overlay([node("my session")])).success).toBe(false);
    // An absolute path is not a durable id.
    expect(AgentGraphOverlaySchemaZ.safeParse(overlay([node("/tmp/agent")])).success).toBe(false);
  });

  it("rejects a reserved value in the node windowId field", () => {
    expect(AgentGraphNodeSchemaZ.safeParse(node("__proto__")).success).toBe(false);
    expect(AgentGraphNodeSchemaZ.safeParse(node("constructor")).success).toBe(false);
    expect(AgentGraphNodeSchemaZ.safeParse(node("terminal.ok")).success).toBe(true);
  });

  it("strips a smuggled own __proto__ record key so it never survives as a node", () => {
    // JSON.parse creates a real own "__proto__" key — the prototype-pollution vector.
    // zod's record parse drops it; the reserved key must never surface as a node.
    const payload = JSON.parse(
      '{"nodes":{"__proto__":{"windowId":"__proto__","status":"idle",' +
        '"statusSource":"unknown","attention":false,"label":null},' +
        '"terminal.ok":{"windowId":"terminal.ok","status":"idle",' +
        '"statusSource":"unknown","attention":false,"label":null}},"edges":[],"groups":[]}',
    ) as unknown;
    const parsed = AgentGraphOverlaySchemaZ.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.prototype.hasOwnProperty.call(parsed.data.nodes, "__proto__")).toBe(false);
      expect(Object.keys(parsed.data.nodes)).toEqual(["terminal.ok"]);
    }
  });

  it("accepts prefixed opaque group ids and rejects pane-shaped or reserved values", () => {
    expect(AgentGraphGroupIdSchemaZ.safeParse(VALID_GROUP_ID).success).toBe(true);

    expect(AgentGraphGroupIdSchemaZ.safeParse("0123456789abcdef").success).toBe(false); // no prefix
    expect(AgentGraphGroupIdSchemaZ.safeParse("group.short").success).toBe(false); // token too short
    expect(AgentGraphGroupIdSchemaZ.safeParse("group.%12abcdef012345").success).toBe(false); // pane char
    expect(AgentGraphGroupIdSchemaZ.safeParse("group.a/b0123456789abc").success).toBe(false); // path sep
    expect(AgentGraphGroupIdSchemaZ.safeParse(`group.${"a".repeat(65)}`).success).toBe(false); // too long
    expect(AgentGraphGroupIdSchemaZ.safeParse("__proto__").success).toBe(false); // reserved
  });

  it("bounds labels and rejects control characters", () => {
    expect(AgentGraphLabelSchemaZ.safeParse("PM · orchestrator").success).toBe(true);
    expect(AgentGraphLabelSchemaZ.safeParse("").success).toBe(false);
    expect(
      AgentGraphLabelSchemaZ.safeParse("a".repeat(AGENT_GRAPH_LABEL_MAX_LENGTH + 1)).success,
    ).toBe(false);
    for (const bad of [NUL, BELL, TAB, ESC, DEL, "\n", "\r"]) {
      expect(AgentGraphLabelSchemaZ.safeParse(`label${bad}x`).success).toBe(false);
    }
  });
});

describe("agent-graph edge kinds", () => {
  it("carries the two ground-truth and two inferred kinds", () => {
    for (const kind of ["spawned", "mission", "inferred-role", "inferred-mission"] as const) {
      expect(AgentGraphEdgeKindSchemaZ.safeParse(kind).success).toBe(true);
    }
    expect(AgentGraphEdgeKindSchemaZ.safeParse("inferred").success).toBe(false);
    expect(AgentGraphEdgeKindSchemaZ.safeParse("role").success).toBe(false);
  });

  it("classifies only the stamp-derived kinds as inferred", () => {
    const kinds: AgentGraphEdgeKind[] = ["spawned", "mission", "inferred-role", "inferred-mission"];
    expect(kinds.filter(isInferredEdgeKind)).toEqual(["inferred-role", "inferred-mission"]);
  });

  it("accepts an inferred edge between two known nodes", () => {
    expect(
      AgentGraphOverlaySchemaZ.safeParse(
        overlay([node("terminal.lead"), node("terminal.sub")], {
          edges: [{ from: "terminal.lead", to: "terminal.sub", kind: "inferred-role" }],
        }),
      ).success,
    ).toBe(true);
  });
});

describe("agent-graph overlay invariants", () => {
  it("accepts a coherent overlay with edges and groups", () => {
    const parsed = AgentGraphOverlaySchemaZ.safeParse(
      overlay([node("terminal.pm"), node("terminal.sub")], {
        edges: [{ from: "terminal.pm", to: "terminal.sub", kind: "spawned" }],
        groups: [{ id: VALID_GROUP_ID, label: "mission one", memberWindowIds: ["terminal.pm"] }],
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("requires the record key to match the node windowId", () => {
    const bad = { nodes: { "terminal.a": node("terminal.b") }, edges: [], groups: [] };
    expect(AgentGraphOverlaySchemaZ.safeParse(bad).success).toBe(false);
  });

  it("rejects self-edges and edges referencing unknown nodes", () => {
    expect(
      AgentGraphOverlaySchemaZ.safeParse(
        overlay([node("terminal.a")], {
          edges: [{ from: "terminal.a", to: "terminal.a", kind: "spawned" }],
        }),
      ).success,
    ).toBe(false);

    expect(
      AgentGraphOverlaySchemaZ.safeParse(
        overlay([node("terminal.a")], {
          edges: [{ from: "terminal.a", to: "terminal.ghost", kind: "mission" }],
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects group members that are not nodes, duplicated members, and duplicate group ids", () => {
    expect(
      AgentGraphOverlaySchemaZ.safeParse(
        overlay([node("terminal.a")], {
          groups: [{ id: VALID_GROUP_ID, label: "g", memberWindowIds: ["terminal.ghost"] }],
        }),
      ).success,
    ).toBe(false);

    expect(
      AgentGraphOverlaySchemaZ.safeParse(
        overlay([node("terminal.a")], {
          groups: [
            { id: VALID_GROUP_ID, label: "g", memberWindowIds: ["terminal.a", "terminal.a"] },
          ],
        }),
      ).success,
    ).toBe(false);

    expect(
      AgentGraphOverlaySchemaZ.safeParse(
        overlay([node("terminal.a")], {
          groups: [
            { id: VALID_GROUP_ID, label: "one", memberWindowIds: [] },
            { id: VALID_GROUP_ID, label: "two", memberWindowIds: [] },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects oversized edge and group payloads", () => {
    const tooManyEdges = Array.from({ length: AGENT_GRAPH_MAX_EDGES + 1 }, () => ({
      from: "terminal.a",
      to: "terminal.b",
      kind: "spawned" as const,
    }));
    expect(
      AgentGraphOverlaySchemaZ.safeParse(
        overlay([node("terminal.a"), node("terminal.b")], { edges: tooManyEdges }),
      ).success,
    ).toBe(false);

    const tooManyMembers = Array.from(
      { length: AGENT_GRAPH_MAX_GROUP_MEMBERS + 1 },
      (_, i) => `terminal.m${i}`,
    );
    expect(
      AgentGraphOverlaySchemaZ.safeParse(
        overlay([node("terminal.a")], {
          groups: [{ id: VALID_GROUP_ID, label: "g", memberWindowIds: tooManyMembers }],
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects unknown record keys on the overlay and its members (strict)", () => {
    expect(
      AgentGraphOverlaySchemaZ.safeParse({ nodes: {}, edges: [], groups: [], extra: 1 }).success,
    ).toBe(false);
  });
});

describe("resolveAgentStatusPresentation", () => {
  it("maps every fresh detect status exhaustively", () => {
    expect(resolveAgentStatusPresentation({ status: "working", stale: false })).toEqual({
      activity: "running",
      domainStatus: "running",
      attention: false,
    });
    expect(resolveAgentStatusPresentation({ status: "blocked", stale: false })).toEqual({
      activity: "waiting",
      domainStatus: "blocked",
      attention: true,
    });
    expect(resolveAgentStatusPresentation({ status: "done", stale: false })).toEqual({
      activity: "complete",
      domainStatus: "done",
      attention: false,
    });
    expect(resolveAgentStatusPresentation({ status: "idle", stale: false })).toEqual({
      activity: "idle",
      domainStatus: "idle",
      attention: false,
    });
    expect(resolveAgentStatusPresentation({ status: "unknown", stale: false })).toEqual({
      activity: "disconnected",
      domainStatus: "disconnected",
      attention: false,
    });
  });

  it("degrades stale working/blocked to recovering, leaving terminal states untouched", () => {
    expect(resolveAgentStatusPresentation({ status: "working", stale: true })).toEqual({
      activity: "disconnected",
      domainStatus: "recovering",
      attention: false,
    });
    expect(resolveAgentStatusPresentation({ status: "blocked", stale: true })).toEqual({
      activity: "disconnected",
      domainStatus: "recovering",
      attention: false,
    });
    // done/idle are terminal and never go stale.
    expect(resolveAgentStatusPresentation({ status: "done", stale: true }).domainStatus).toBe(
      "done",
    );
    expect(resolveAgentStatusPresentation({ status: "idle", stale: true }).domainStatus).toBe(
      "idle",
    );
  });

  it("only ever emits values within the renderer enums", () => {
    const activities = new Set<string>(AGENT_ACTIVITY_IDS);
    const domains = new Set<string>(CANONICAL_DOMAIN_STATUS_IDS);
    const statuses: AgentGraphDetectStatus[] = ["working", "blocked", "done", "idle", "unknown"];
    for (const status of statuses) {
      for (const stale of [false, true]) {
        const out = resolveAgentStatusPresentation({ status, stale });
        expect(activities.has(out.activity)).toBe(true);
        expect(domains.has(out.domainStatus)).toBe(true);
      }
    }
  });
});

describe("projectAgentGraphOverlay", () => {
  const pnode = (
    windowId: string,
    over: Partial<AgentGraphProjectionNode> = {},
  ): AgentGraphProjectionNode => ({
    windowId,
    status: "working",
    statusSource: "authority",
    attention: false,
    label: null,
    ...over,
  });

  it("produces a schema-valid overlay from clean inputs", () => {
    const { overlay: result, truncated } = projectAgentGraphOverlay({
      nodes: [pnode("terminal.pm"), pnode("terminal.sub", { status: "blocked" })],
      edges: [{ from: "terminal.pm", to: "terminal.sub", kind: "spawned" }],
      groups: [
        { id: VALID_GROUP_ID, label: "m", memberWindowIds: ["terminal.pm", "terminal.sub"] },
      ],
    });
    expect(truncated).toBe(false);
    expect(AgentGraphOverlaySchemaZ.safeParse(result).success).toBe(true);
    expect(Object.keys(result.nodes)).toHaveLength(2);
  });

  it("dedupes nodes (first wins) and flags truncation", () => {
    const { overlay: result, truncated } = projectAgentGraphOverlay({
      nodes: [pnode("terminal.a", { label: "first" }), pnode("terminal.a", { label: "second" })],
      edges: [],
      groups: [],
    });
    expect(truncated).toBe(true);
    expect(Object.keys(result.nodes)).toHaveLength(1);
    expect(result.nodes["terminal.a"]!.label).toBe("first");
  });

  it("drops self-edges, dangling edges, and duplicate edges without throwing", () => {
    const { overlay: result, truncated } = projectAgentGraphOverlay({
      nodes: [pnode("terminal.a"), pnode("terminal.b")],
      edges: [
        { from: "terminal.a", to: "terminal.a", kind: "spawned" }, // self
        { from: "terminal.a", to: "terminal.ghost", kind: "spawned" }, // dangling
        { from: "terminal.a", to: "terminal.b", kind: "mission" },
        { from: "terminal.a", to: "terminal.b", kind: "mission" }, // duplicate
      ],
      groups: [],
    });
    expect(truncated).toBe(true);
    expect(result.edges).toHaveLength(1);
    expect(AgentGraphOverlaySchemaZ.safeParse(result).success).toBe(true);
  });

  it("keeps inferred edges distinct from ground-truth kinds and dedupes per kind", () => {
    const { overlay: result, truncated } = projectAgentGraphOverlay({
      nodes: [pnode("terminal.lead"), pnode("terminal.sub")],
      edges: [
        { from: "terminal.lead", to: "terminal.sub", kind: "spawned" },
        { from: "terminal.lead", to: "terminal.sub", kind: "inferred-role" },
        { from: "terminal.lead", to: "terminal.sub", kind: "inferred-role" }, // duplicate
        { from: "terminal.lead", to: "terminal.sub", kind: "inferred-mission" },
      ],
      groups: [],
    });
    // Dedup is per (kind, from, to): the two distinct inferred kinds and the
    // spawned edge all survive; only the repeated inferred-role collapses.
    expect(truncated).toBe(true);
    expect(result.edges.map((edge) => edge.kind).sort()).toEqual([
      "inferred-mission",
      "inferred-role",
      "spawned",
    ]);
    expect(AgentGraphOverlaySchemaZ.safeParse(result).success).toBe(true);
  });

  it("restricts group members to surviving nodes and dedupes group ids", () => {
    const { overlay: result, truncated } = projectAgentGraphOverlay({
      nodes: [pnode("terminal.a")],
      edges: [],
      groups: [
        {
          id: VALID_GROUP_ID,
          label: "g",
          memberWindowIds: ["terminal.a", "terminal.ghost", "terminal.a"],
        },
        { id: VALID_GROUP_ID, label: "dup", memberWindowIds: [] },
      ],
    });
    expect(truncated).toBe(true);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.memberWindowIds).toEqual(["terminal.a"]);
    expect(AgentGraphOverlaySchemaZ.safeParse(result).success).toBe(true);
  });

  it("enforces the node cap with honest truncation", () => {
    const nodes = Array.from({ length: AGENT_GRAPH_MAX_NODES + 5 }, (_, i) =>
      pnode(`terminal.n${i}`),
    );
    const { overlay: result, truncated } = projectAgentGraphOverlay({
      nodes,
      edges: [],
      groups: [],
    });
    expect(truncated).toBe(true);
    expect(Object.keys(result.nodes)).toHaveLength(AGENT_GRAPH_MAX_NODES);
    expect(AgentGraphOverlaySchemaZ.safeParse(result).success).toBe(true);
  });

  it("enforces the group cap with honest truncation", () => {
    const groups = Array.from({ length: AGENT_GRAPH_MAX_GROUPS + 2 }, (_, i) => ({
      id: `group.grp${String(i).padStart(13, "0")}`,
      label: `g${i}`,
      memberWindowIds: [] as string[],
    }));
    const { overlay: result, truncated } = projectAgentGraphOverlay({
      nodes: [pnode("terminal.a")],
      edges: [],
      groups,
    });
    expect(truncated).toBe(true);
    expect(result.groups).toHaveLength(AGENT_GRAPH_MAX_GROUPS);
    expect(AgentGraphOverlaySchemaZ.safeParse(result).success).toBe(true);
  });

  it("returns an empty, valid overlay for empty input", () => {
    const { overlay: result, truncated } = projectAgentGraphOverlay({
      nodes: [],
      edges: [],
      groups: [],
    });
    expect(truncated).toBe(false);
    expect(AgentGraphOverlaySchemaZ.safeParse(result).success).toBe(true);
  });
});
