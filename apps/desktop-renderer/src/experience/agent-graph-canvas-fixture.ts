import {
  AppWindowDocumentV1SchemaZ,
  projectAgentGraphOverlay,
  resolvePaneAppearance,
  type AgentGraphOverlay,
  type ApplicationShellTerminalInventory,
  type AppWindowDocumentV1,
} from "@tmux-ide/contracts";

import type { PaneFrameModel } from "../../../../packages/daemon/src/ui/pane-frame/presenter.tsx";

/**
 * Shared fixture data for the agent-graph canvas overlay. One document with four
 * terminal windows (three docked in a horizontal split, one floating) plus a set
 * of overlay scenarios keyed by their durable window ids. Consumed by both the
 * visual fixture and the component test so the two stay in lockstep.
 */

export type AgentGraphCanvasScenario =
  | "no-overlay"
  | "nodes-only"
  | "spawned-edges"
  | "mission-group"
  | "inferred-role"
  | "inferred-mission"
  | "blocked-attention"
  | "missing-windows"
  | "truncated";

const NOW = "2026-07-22T10:00:00.000Z";

const TERMINAL_WINDOWS = [
  { windowId: "window.lead", terminalSourceId: "terminal.lead", title: "Lead" },
  { windowId: "window.plan", terminalSourceId: "terminal.plan", title: "Planner" },
  { windowId: "window.worker", terminalSourceId: "terminal.worker", title: "Worker" },
  { windowId: "window.review", terminalSourceId: "terminal.review", title: "Review" },
] as const;

export function agentGraphCanvasDocument(): AppWindowDocumentV1 {
  return AppWindowDocumentV1SchemaZ.parse({
    version: 1,
    revision: 5,
    updatedAt: NOW,
    windows: {
      "window.lead": {
        id: "window.lead",
        source: { kind: "terminal", terminalSourceId: "terminal.lead" },
        title: "Lead",
        placement: { mode: "docked", docked: { stackId: "stack.lead", index: 0 }, floating: null },
      },
      "window.plan": {
        id: "window.plan",
        source: { kind: "terminal", terminalSourceId: "terminal.plan" },
        title: "Planner",
        placement: { mode: "docked", docked: { stackId: "stack.plan", index: 0 }, floating: null },
      },
      "window.worker": {
        id: "window.worker",
        source: { kind: "terminal", terminalSourceId: "terminal.worker" },
        title: "Worker",
        placement: {
          mode: "docked",
          docked: { stackId: "stack.worker", index: 0 },
          floating: null,
        },
      },
      "window.review": {
        id: "window.review",
        source: { kind: "terminal", terminalSourceId: "terminal.review" },
        title: "Review",
        placement: {
          mode: "floating",
          docked: null,
          floating: { x: 540, y: 300, width: 320, height: 200 },
        },
      },
    },
    dockRoot: {
      type: "split",
      id: "split.root",
      axis: "horizontal",
      children: [
        {
          type: "stack",
          id: "stack.lead",
          windowIds: ["window.lead"],
          activeWindowId: "window.lead",
        },
        {
          type: "stack",
          id: "stack.plan",
          windowIds: ["window.plan"],
          activeWindowId: "window.plan",
        },
        {
          type: "stack",
          id: "stack.worker",
          windowIds: ["window.worker"],
          activeWindowId: "window.worker",
        },
      ],
      weights: [1, 1, 1],
    },
    dockState: { mode: "collapsed", preferredHeight: null, focusZone: "canvas" },
    floatingOrder: ["window.review"],
    focusedWindowId: "window.lead",
    activeLayoutId: null,
    layouts: {},
  });
}

function paneFrame(terminalSourceId: string, title: string): PaneFrameModel {
  const appearance = resolvePaneAppearance({
    structure: "docked",
    applicationFocus: { pane: false, terminalInput: false, windowActive: true },
    agentActivity: "running",
    domainStatus: "running",
    attention: "none",
    layoutInteraction: {
      editable: true,
      selected: false,
      dragging: false,
      resizing: false,
      previewing: false,
    },
    controlInteraction: {
      hover: false,
      focusVisible: false,
      pressed: false,
      disabled: false,
      loading: false,
    },
  });
  return {
    pane: { id: terminalSourceId, kind: "terminal" },
    appearance,
    title,
    subtitle: "Claude",
    status: {
      id: `${terminalSourceId}.status`,
      label: "Running",
      description: "Terminal is running",
      tone: appearance.status.tone,
      busy: true,
    },
    chips: [],
    actions: [],
  };
}

export function agentGraphCanvasPaneFrames(): PaneFrameModel[] {
  return TERMINAL_WINDOWS.map((window) => paneFrame(window.terminalSourceId, window.title));
}

export function agentGraphCanvasInventory(): ApplicationShellTerminalInventory {
  return {
    activeResourceId: "terminal.lead",
    resources: TERMINAL_WINDOWS.map((window, index) => ({
      id: window.terminalSourceId,
      title: window.title,
      kind: "agent" as const,
      active: index === 0,
      attachability: { status: "available" as const, semanticPaneId: window.terminalSourceId },
    })),
  };
}

const GROUP_ID = "group.shiprelease000001";

export function agentGraphCanvasOverlay(
  scenario: AgentGraphCanvasScenario,
): AgentGraphOverlay | undefined {
  if (scenario === "no-overlay") return undefined;

  const node = (
    windowId: string,
    status: "working" | "blocked" | "done" | "idle",
    attention: boolean,
    label: string | null,
  ) => ({ windowId, status, statusSource: "authority" as const, attention, label });

  if (scenario === "nodes-only") {
    return projectAgentGraphOverlay({
      nodes: [
        node("window.lead", "working", false, "PM"),
        node("window.plan", "idle", false, "Planner"),
        node("window.worker", "done", false, "Worker"),
        node("window.review", "working", false, "Review"),
      ],
      edges: [],
      groups: [],
    }).overlay;
  }

  if (scenario === "spawned-edges") {
    return projectAgentGraphOverlay({
      nodes: [
        node("window.lead", "working", false, "PM"),
        node("window.plan", "working", false, "Planner"),
        node("window.worker", "working", false, "Worker"),
        node("window.review", "done", false, "Review"),
      ],
      edges: [
        { from: "window.lead", to: "window.plan", kind: "spawned" },
        { from: "window.lead", to: "window.worker", kind: "spawned" },
        { from: "window.lead", to: "window.review", kind: "spawned" },
      ],
      groups: [],
    }).overlay;
  }

  if (scenario === "mission-group") {
    return projectAgentGraphOverlay({
      nodes: [
        node("window.lead", "working", false, "PM"),
        node("window.plan", "done", false, "Planner"),
        node("window.worker", "working", false, "Worker"),
        node("window.review", "idle", false, "Review"),
      ],
      edges: [
        { from: "window.lead", to: "window.plan", kind: "spawned" },
        { from: "window.lead", to: "window.worker", kind: "spawned" },
        { from: "window.lead", to: "window.review", kind: "mission" },
      ],
      groups: [
        {
          id: GROUP_ID,
          label: "Ship the release",
          memberWindowIds: ["window.lead", "window.plan", "window.worker"],
        },
      ],
    }).overlay;
  }

  if (scenario === "inferred-role") {
    // No mission resource: a lead pane's role stamp yields dashed inferred edges
    // to each subordinate pane, distinct from a solid ground-truth spawn edge.
    return projectAgentGraphOverlay({
      nodes: [
        node("window.lead", "working", false, "Lead"),
        node("window.plan", "working", false, "Planner"),
        node("window.worker", "done", false, "Worker"),
      ],
      edges: [
        { from: "window.lead", to: "window.plan", kind: "inferred-role" },
        { from: "window.lead", to: "window.worker", kind: "inferred-role" },
      ],
      groups: [],
    }).overlay;
  }

  if (scenario === "inferred-mission") {
    // Panes sharing a mission stamp with no mission resource: dashed inferred
    // co-membership edges, no labeled group frame.
    return projectAgentGraphOverlay({
      nodes: [
        node("window.lead", "working", false, "Alpha"),
        node("window.plan", "working", false, "Bravo"),
        node("window.worker", "blocked", true, "Charlie"),
      ],
      edges: [
        { from: "window.lead", to: "window.plan", kind: "inferred-mission" },
        { from: "window.lead", to: "window.worker", kind: "inferred-mission" },
      ],
      groups: [],
    }).overlay;
  }

  if (scenario === "blocked-attention") {
    return projectAgentGraphOverlay({
      nodes: [
        node("window.lead", "working", false, "PM"),
        node("window.plan", "working", false, "Planner"),
        node("window.worker", "blocked", true, "Worker"),
        node("window.review", "done", false, "Review"),
      ],
      edges: [
        { from: "window.lead", to: "window.worker", kind: "spawned" },
        { from: "window.lead", to: "window.plan", kind: "spawned" },
      ],
      groups: [],
    }).overlay;
  }

  if (scenario === "missing-windows") {
    // Two of the nodes reference windows the document does not contain. They are
    // valid overlay nodes but have no rect, so the scene projection degrades them.
    return projectAgentGraphOverlay({
      nodes: [
        node("window.lead", "working", false, "PM"),
        node("window.worker", "working", false, "Worker"),
        node("window.ghostA", "working", false, "Detached A"),
        node("window.ghostB", "blocked", true, "Detached B"),
      ],
      edges: [
        { from: "window.lead", to: "window.worker", kind: "spawned" },
        { from: "window.lead", to: "window.ghostA", kind: "spawned" },
        { from: "window.ghostB", to: "window.ghostA", kind: "mission" },
      ],
      groups: [
        {
          id: GROUP_ID,
          label: "Partly detached",
          memberWindowIds: ["window.lead", "window.ghostA", "window.ghostB"],
        },
      ],
    }).overlay;
  }

  // "truncated": the projector drops a self-edge and a duplicate edge; the
  // surviving overlay is a valid, honestly-trimmed subset of a busier fleet.
  return projectAgentGraphOverlay({
    nodes: [
      node("window.lead", "working", false, "PM"),
      node("window.plan", "working", false, "Planner"),
      node("window.worker", "done", false, "Worker"),
      node("window.review", "working", false, "Review"),
    ],
    edges: [
      { from: "window.lead", to: "window.plan", kind: "spawned" },
      { from: "window.lead", to: "window.plan", kind: "spawned" },
      { from: "window.lead", to: "window.lead", kind: "spawned" },
      { from: "window.lead", to: "window.worker", kind: "spawned" },
      { from: "window.plan", to: "window.review", kind: "mission" },
    ],
    groups: [
      {
        id: GROUP_ID,
        label: "Ship the release",
        memberWindowIds: ["window.lead", "window.plan", "window.worker", "window.review"],
      },
    ],
  }).overlay;
}
