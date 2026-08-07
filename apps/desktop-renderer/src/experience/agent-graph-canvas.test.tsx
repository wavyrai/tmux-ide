/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import { AppWindowCanvas } from "./app-window-canvas.tsx";
import {
  agentGraphCanvasDocument,
  agentGraphCanvasInventory,
  agentGraphCanvasOverlay,
  agentGraphCanvasPaneFrames,
  type AgentGraphCanvasScenario,
} from "./agent-graph-canvas-fixture.ts";

const disposers: Array<() => void> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
});

function mount(scenario: AgentGraphCanvasScenario, reducedMotion = false): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  disposers.push(
    render(
      () => (
        <AppWindowCanvas
          document={agentGraphCanvasDocument()}
          paneFrames={agentGraphCanvasPaneFrames()}
          terminalInventory={agentGraphCanvasInventory()}
          workspaceName="workspace.graph"
          viewport={{ width: 960, height: 600 }}
          reducedMotion={reducedMotion}
          overlay={agentGraphCanvasOverlay(scenario)}
          onCommand={() => undefined}
        />
      ),
      root,
    ),
  );
  return root;
}

describe("AppWindowCanvas agent-graph overlay", () => {
  it("renders exactly as today when no overlay is supplied", () => {
    const root = mount("no-overlay");
    expect(root.querySelector(".agent-graph")).toBeNull();
    expect(root.querySelector(".canvas-minimap")).toBeNull();
    expect(root.querySelector(".agent-graph__edge")).toBeNull();
    for (const card of root.querySelectorAll(".app-window-card")) {
      expect(card.getAttribute("data-agent-status")).toBeNull();
      expect(card.getAttribute("data-agent-attention")).toBeNull();
    }
  });

  it("carries node status onto window chrome and shows the minimap for a nodes-only overlay", () => {
    const root = mount("nodes-only");
    expect(root.querySelector(".agent-graph")).not.toBeNull();
    expect(root.querySelector(".agent-graph__edge")).toBeNull();
    const lead = root.querySelector<HTMLElement>('.app-window-card[data-window-id="window.lead"]')!;
    expect(lead.dataset.agentStatus).toBe("working");
    const worker = root.querySelector<HTMLElement>(
      '.app-window-card[data-window-id="window.worker"]',
    )!;
    expect(worker.dataset.agentStatus).toBe("done");
    const minimap = root.querySelector(".canvas-minimap")!;
    expect(minimap).not.toBeNull();
    expect(minimap.querySelectorAll(".canvas-minimap__window")).toHaveLength(4);
    expect(minimap.querySelector(".canvas-minimap__viewport")).not.toBeNull();
  });

  it("draws directed, kind-differentiated spawn edges with arrowheads", () => {
    const root = mount("spawned-edges");
    const edges = root.querySelectorAll(".agent-graph__edge");
    expect(edges).toHaveLength(3);
    for (const edge of edges) {
      expect(edge.getAttribute("data-kind")).toBe("spawned");
      expect(edge.getAttribute("d")?.startsWith("M ")).toBe(true);
    }
    const arrows = root.querySelectorAll(".agent-graph__arrow");
    expect(arrows).toHaveLength(3);
    expect(arrows[0]!.getAttribute("d")?.endsWith("Z")).toBe(true);
  });

  it("frames a mission group with a label and paints its mission edge", () => {
    const root = mount("mission-group");
    const group = root.querySelector(".agent-graph__group")!;
    expect(group).not.toBeNull();
    expect(group.querySelector(".agent-graph__group-frame")).not.toBeNull();
    expect(group.querySelector(".agent-graph__group-label")?.textContent).toBe("Ship the release");
    const mission = root.querySelector('.agent-graph__edge[data-kind="mission"]');
    expect(mission).not.toBeNull();
    const spawned = root.querySelectorAll('.agent-graph__edge[data-kind="spawned"]');
    expect(spawned.length).toBeGreaterThan(0);
  });

  it("draws dashed inferred-role edges tagged by their inferred kind", () => {
    const root = mount("inferred-role");
    const edges = root.querySelectorAll('.agent-graph__edge[data-kind="inferred-role"]');
    expect(edges).toHaveLength(2);
    // No ground-truth kinds are present in a purely-inferred scene.
    expect(root.querySelector('.agent-graph__edge[data-kind="spawned"]')).toBeNull();
    expect(root.querySelector('.agent-graph__edge[data-kind="mission"]')).toBeNull();
    for (const edge of edges) {
      expect(edge.getAttribute("d")?.startsWith("M ")).toBe(true);
      expect(edge.closest(".agent-graph__edge-group")?.getAttribute("data-from")).toBe(
        "window.lead",
      );
    }
    const arrows = root.querySelectorAll('.agent-graph__arrow[data-kind="inferred-role"]');
    expect(arrows).toHaveLength(2);
  });

  it("draws inferred-mission edges without a labeled group frame", () => {
    const root = mount("inferred-mission");
    expect(root.querySelectorAll('.agent-graph__edge[data-kind="inferred-mission"]')).toHaveLength(
      2,
    );
    // Inferred membership never paints a ground-truth mission group.
    expect(root.querySelector(".agent-graph__group")).toBeNull();
  });

  it("gives a blocked node a restrained attention treatment on chrome and its edge", () => {
    const root = mount("blocked-attention");
    const worker = root.querySelector<HTMLElement>(
      '.app-window-card[data-window-id="window.worker"]',
    )!;
    expect(worker.dataset.agentAttention).toBe("true");
    expect(worker.dataset.agentStatus).toBe("blocked");
    const attentionEdge = root.querySelector(
      '.agent-graph__edge-group[data-to="window.worker"] .agent-graph__edge[data-attention="true"]',
    );
    expect(attentionEdge).not.toBeNull();
    // The other spawn edge (lead -> plan) touches no blocked node.
    const calmEdge = root.querySelector(
      '.agent-graph__edge-group[data-to="window.plan"] .agent-graph__edge[data-attention="false"]',
    );
    expect(calmEdge).not.toBeNull();
  });

  it("degrades overlay entries that reference windows absent from the document", () => {
    const root = mount("missing-windows");
    // Only the lead -> worker spawn edge has both endpoints on the canvas.
    const edges = root.querySelectorAll(".agent-graph__edge");
    expect(edges).toHaveLength(1);
    expect(edges[0]!.closest(".agent-graph__edge-group")?.getAttribute("data-to")).toBe(
      "window.worker",
    );
    // The group still frames its resolvable members; the ghost members are gone.
    expect(root.querySelector(".agent-graph__group")).not.toBeNull();
    // The detached ghost windows never became cards.
    expect(root.querySelector('[data-window-id="window.ghostA"]')).toBeNull();
    expect(root.querySelector('[data-window-id="window.ghostB"]')).toBeNull();
  });

  it("renders the honestly-trimmed subset of a truncated overlay", () => {
    const root = mount("truncated");
    // The self-edge and duplicate spawn edge were dropped by the projector.
    const spawned = root.querySelectorAll('.agent-graph__edge[data-kind="spawned"]');
    expect(spawned).toHaveLength(2);
    expect(root.querySelectorAll('.agent-graph__edge[data-kind="mission"]')).toHaveLength(1);
    expect(root.querySelector(".agent-graph__group")).not.toBeNull();
  });

  it("frames a window on a double header tap without emitting a durable command", () => {
    const root = mount("mission-group", true);
    const canvas = root.querySelector<HTMLElement>(".app-window-canvas")!;
    const beforeScale = canvas.dataset.viewportScale;
    const beforeX = canvas.dataset.viewportX;
    const header = root
      .querySelector('.app-window-card[data-window-id="window.lead"]')!
      .querySelector<HTMLElement>(".web-pane-frame__title")!;
    const tap = () =>
      header.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          pointerId: 4,
          button: 0,
          clientX: 100,
          clientY: 40,
        }),
      );
    tap();
    tap();
    // A docked header double-tap frames the window: the viewport transform moves.
    expect(
      canvas.dataset.viewportScale !== beforeScale || canvas.dataset.viewportX !== beforeX,
    ).toBe(true);
  });

  it("pans to a clicked minimap point", () => {
    const root = mount("spawned-edges");
    const canvas = root.querySelector<HTMLElement>(".app-window-canvas")!;
    const surface = root.querySelector<SVGSVGElement>(".canvas-minimap__surface")!;
    surface.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 168,
        height: 108,
        right: 168,
        bottom: 108,
        x: 0,
        y: 0,
      }) as DOMRect;
    const beforeX = canvas.dataset.viewportX;
    const beforeY = canvas.dataset.viewportY;
    surface.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 150,
        clientY: 90,
      }),
    );
    expect(canvas.dataset.viewportX !== beforeX || canvas.dataset.viewportY !== beforeY).toBe(true);
  });
});
