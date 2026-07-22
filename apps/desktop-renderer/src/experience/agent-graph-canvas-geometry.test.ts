import { projectAgentGraphOverlay, type AgentGraphOverlay } from "@tmux-ide/contracts";
import { describe, expect, it } from "vitest";

import type { CanvasRect } from "./canvas-interaction-geometry.ts";
import {
  agentGraphMinimapPanTransform,
  projectAgentGraphMinimap,
  projectAgentGraphScene,
  type AgentGraphSceneRect,
} from "./agent-graph-canvas-geometry.ts";

function overlay(input: {
  readonly nodes: ReadonlyArray<{
    readonly windowId: string;
    readonly status?: "working" | "blocked" | "done" | "idle";
    readonly attention?: boolean;
    readonly label?: string | null;
  }>;
  readonly edges?: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
    readonly kind: "spawned" | "mission";
  }>;
  readonly groups?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly memberWindowIds: readonly string[];
  }>;
}): AgentGraphOverlay {
  return projectAgentGraphOverlay({
    nodes: input.nodes.map((node) => ({
      windowId: node.windowId,
      status: node.status ?? "working",
      statusSource: "authority" as const,
      attention: node.attention ?? false,
      label: node.label ?? null,
    })),
    edges: input.edges ?? [],
    groups: input.groups ?? [],
  }).overlay;
}

function rect(windowId: string, value: CanvasRect): AgentGraphSceneRect {
  return { windowId, rect: value };
}

const A: CanvasRect = { x: 0, y: 0, width: 100, height: 80 };
const B: CanvasRect = { x: 300, y: 0, width: 100, height: 80 };
const C: CanvasRect = { x: 0, y: 300, width: 100, height: 80 };

describe("projectAgentGraphScene", () => {
  it("places nodes on their window rects and reports nothing skipped", () => {
    const scene = projectAgentGraphScene(
      overlay({ nodes: [{ windowId: "window.a", status: "blocked", attention: true }] }),
      [rect("window.a", A)],
    );
    expect(scene.nodes).toEqual([
      {
        windowId: "window.a",
        rect: A,
        status: "blocked",
        statusSource: "authority",
        attention: true,
        label: null,
      },
    ]);
    expect(scene.skipped).toEqual({ nodes: 0, edges: 0, groups: 0, groupMembers: 0 });
  });

  it("anchors an edge on the source and target borders, not their centers", () => {
    const scene = projectAgentGraphScene(
      overlay({
        nodes: [{ windowId: "window.a" }, { windowId: "window.b" }],
        edges: [{ from: "window.a", to: "window.b", kind: "spawned" }],
      }),
      [rect("window.a", A), rect("window.b", B)],
    );
    const edge = scene.edges[0]!;
    // A spans x:[0,100], centered vertically at y=40; B spans x:[300,400].
    // The horizontal ray exits A at its right border and enters B at its left.
    expect(edge.source).toEqual({ x: 100, y: 40 });
    expect(edge.target).toEqual({ x: 300, y: 40 });
    expect(edge.path.startsWith("M 100 40 Q")).toBe(true);
    expect(edge.arrow.startsWith("M 300 40 L")).toBe(true);
    expect(edge.attention).toBe(false);
  });

  it("bows spawned and mission edges to opposite sides of the same axis", () => {
    const scene = projectAgentGraphScene(
      overlay({
        nodes: [{ windowId: "window.a" }, { windowId: "window.b" }],
        edges: [
          { from: "window.a", to: "window.b", kind: "spawned" },
          { from: "window.a", to: "window.b", kind: "mission" },
        ],
      }),
      [rect("window.a", A), rect("window.b", B)],
    );
    const controlY = (path: string) => Number(path.split("Q ")[1]!.split(" ")[1]);
    const spawned = scene.edges.find((edge) => edge.kind === "spawned")!;
    const mission = scene.edges.find((edge) => edge.kind === "mission")!;
    // Horizontal edge: the perpendicular bow moves the control point in Y.
    expect(controlY(spawned.path)).toBeGreaterThan(40);
    expect(controlY(mission.path)).toBeLessThan(40);
  });

  it("marks an edge as attention when either endpoint node is blocked", () => {
    const scene = projectAgentGraphScene(
      overlay({
        nodes: [
          { windowId: "window.a" },
          { windowId: "window.b", status: "blocked", attention: true },
        ],
        edges: [{ from: "window.a", to: "window.b", kind: "spawned" }],
      }),
      [rect("window.a", A), rect("window.b", B)],
    );
    expect(scene.edges[0]!.attention).toBe(true);
  });

  it("frames a group as a padded bounding box around resolvable members", () => {
    const scene = projectAgentGraphScene(
      overlay({
        nodes: [{ windowId: "window.a" }, { windowId: "window.c" }],
        groups: [
          {
            id: "group.mission0000000001",
            label: "Ship the release",
            memberWindowIds: ["window.a", "window.c"],
          },
        ],
      }),
      [rect("window.a", A), rect("window.c", C)],
      { groupPadding: 10 },
    );
    // Bounds of A + C = x:[0,100], y:[0,380]; padded by 10 on each side.
    expect(scene.groups).toEqual([
      {
        id: "group.mission0000000001",
        label: "Ship the release",
        rect: { x: -10, y: -10, width: 120, height: 400 },
        memberCount: 2,
      },
    ]);
  });

  it("degrades overlay entries that reference windows without a rect", () => {
    const scene = projectAgentGraphScene(
      overlay({
        nodes: [{ windowId: "window.a" }, { windowId: "window.ghost" }],
        edges: [{ from: "window.a", to: "window.ghost", kind: "spawned" }],
        groups: [
          {
            id: "group.mission0000000001",
            label: "Partly missing",
            memberWindowIds: ["window.a", "window.ghost"],
          },
          {
            id: "group.mission0000000002",
            label: "Entirely missing",
            memberWindowIds: ["window.ghost"],
          },
        ],
      }),
      [rect("window.a", A)],
    );
    expect(scene.nodes).toHaveLength(1);
    expect(scene.edges).toHaveLength(0);
    expect(scene.groups).toHaveLength(1);
    expect(scene.groups[0]!.memberCount).toBe(1);
    expect(scene.skipped).toEqual({ nodes: 1, edges: 1, groups: 1, groupMembers: 2 });
  });

  it("returns an empty scene for an empty overlay without throwing", () => {
    const scene = projectAgentGraphScene(overlay({ nodes: [] }), []);
    expect(scene.nodes).toHaveLength(0);
    expect(scene.edges).toHaveLength(0);
    expect(scene.groups).toHaveLength(0);
    expect(scene.skipped).toEqual({ nodes: 0, edges: 0, groups: 0, groupMembers: 0 });
  });

  it("still produces a directed connector when the two rects overlap", () => {
    const scene = projectAgentGraphScene(
      overlay({
        nodes: [{ windowId: "window.a" }, { windowId: "window.b" }],
        edges: [{ from: "window.a", to: "window.b", kind: "spawned" }],
      }),
      [rect("window.a", A), rect("window.b", { x: 10, y: 10, width: 100, height: 80 })],
    );
    const edge = scene.edges[0]!;
    expect(edge.path.startsWith("M ")).toBe(true);
    expect(edge.arrow.endsWith("Z")).toBe(true);
    expect(Number.isFinite(edge.target.x)).toBe(true);
    expect(Number.isFinite(edge.target.y)).toBe(true);
  });
});

describe("projectAgentGraphMinimap", () => {
  const input = {
    windows: [rect("window.a", A), rect("window.b", B)],
    statusById: new Map([
      ["window.a", "working" as const],
      ["window.b", "blocked" as const],
    ]),
    attentionById: new Map([["window.b", true]]),
    viewport: { width: 800, height: 500 },
    transform: { x: 0, y: 0, scale: 1 },
    size: { width: 160, height: 100 },
  };

  it("scales window rects and carries node status into the fills", () => {
    const minimap = projectAgentGraphMinimap(input)!;
    expect(minimap).not.toBeNull();
    expect(minimap.windows).toHaveLength(2);
    const a = minimap.windows.find((window) => window.windowId === "window.a")!;
    const b = minimap.windows.find((window) => window.windowId === "window.b")!;
    expect(a.status).toBe("working");
    expect(b.status).toBe("blocked");
    expect(b.attention).toBe(true);
    // Every fill stays inside the minimap box.
    for (const window of minimap.windows) {
      expect(window.rect.x).toBeGreaterThanOrEqual(0);
      expect(window.rect.y).toBeGreaterThanOrEqual(0);
      expect(window.rect.x + window.rect.width).toBeLessThanOrEqual(160);
      expect(window.rect.y + window.rect.height).toBeLessThanOrEqual(100);
    }
  });

  it("keeps the viewport rectangle within the fitted bounds", () => {
    const minimap = projectAgentGraphMinimap({
      ...input,
      // Pan far away from the windows: the viewport region must still be shown.
      transform: { x: -2_000, y: -2_000, scale: 1 },
    })!;
    expect(minimap.viewportRect.width).toBeGreaterThan(0);
    expect(minimap.viewportRect.height).toBeGreaterThan(0);
  });

  it("round-trips a minimap point back to a centering pan transform", () => {
    const minimap = projectAgentGraphMinimap(input)!;
    const a = minimap.windows.find((window) => window.windowId === "window.a")!;
    const clickCenter = {
      x: a.rect.x + a.rect.width / 2,
      y: a.rect.y + a.rect.height / 2,
    };
    const next = agentGraphMinimapPanTransform(
      minimap,
      clickCenter,
      input.transform,
      input.viewport,
    );
    // Window A's center (50,40) should map to the viewport center after panning.
    expect(50 * next.scale + next.x).toBeCloseTo(400, 0);
    expect(40 * next.scale + next.y).toBeCloseTo(250, 0);
    expect(next.scale).toBe(1);
  });

  it("returns null when there is nothing to fit", () => {
    expect(
      projectAgentGraphMinimap({
        ...input,
        windows: [],
        viewport: { width: 0, height: 0 },
        transform: { x: 0, y: 0, scale: 1 },
      }),
    ).toBeNull();
  });
});
