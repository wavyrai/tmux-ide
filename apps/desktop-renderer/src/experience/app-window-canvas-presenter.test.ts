import {
  AppWindowDocumentV1SchemaZ,
  createClientViewStateV1,
  type AppWindowDockNodeShape,
  type AppWindowDocumentV1,
  type AppWindowInstance,
} from "@tmux-ide/contracts";
import { describe, expect, it } from "vitest";

import { appWindowFocusInvocation, projectAppWindowCanvas } from "./app-window-canvas-presenter.ts";

const NOW = "2026-07-22T10:00:00.000Z";

function scene(): AppWindowDocumentV1 {
  return AppWindowDocumentV1SchemaZ.parse({
    version: 1,
    revision: 7,
    updatedAt: NOW,
    windows: {
      "window.lead": {
        id: "window.lead",
        source: { kind: "terminal", terminalSourceId: "terminal.lead" },
        title: "Lead",
        placement: {
          mode: "docked",
          docked: { stackId: "stack.left", index: 0 },
          floating: null,
        },
      },
      "window.hidden": {
        id: "window.hidden",
        source: { kind: "terminal", terminalSourceId: "terminal.hidden" },
        title: "Hidden tab",
        placement: {
          mode: "docked",
          docked: { stackId: "stack.left", index: 1 },
          floating: null,
        },
      },
      "window.worker": {
        id: "window.worker",
        source: { kind: "terminal", terminalSourceId: "terminal.worker" },
        title: "Worker",
        placement: {
          mode: "docked",
          docked: { stackId: "stack.right", index: 0 },
          floating: null,
        },
      },
      "window.files": {
        id: "window.files",
        source: { kind: "native", surface: "files", resourceId: null },
        title: "Files",
        placement: {
          mode: "docked",
          docked: { stackId: "stack.native", index: 0 },
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
          floating: { x: 42, y: 36, width: 360, height: 220 },
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
          id: "stack.left",
          windowIds: ["window.lead", "window.hidden"],
          activeWindowId: "window.lead",
        },
        {
          type: "stack",
          id: "stack.right",
          windowIds: ["window.worker"],
          activeWindowId: "window.worker",
        },
        {
          type: "stack",
          id: "stack.native",
          windowIds: ["window.files"],
          activeWindowId: "window.files",
        },
      ],
      weights: [1, 2, 5],
    },
    dockState: { mode: "collapsed", preferredHeight: null, focusZone: "canvas" },
    floatingOrder: ["window.review"],
    focusedWindowId: "window.review",
    activeLayoutId: null,
    layouts: {},
  });
}

function manyDockWindowsScene(count: number): AppWindowDocumentV1 {
  const windows: Record<string, AppWindowInstance> = {};
  let nodes: AppWindowDockNodeShape[] = Array.from({ length: count }, (_, index) => {
    const windowId = `window.dock.${index}`;
    const stackId = `stack.dock.${index}`;
    windows[windowId] = {
      id: windowId,
      source: { kind: "terminal", terminalSourceId: `terminal.dock.${index}` },
      title: null,
      placement: {
        mode: "docked",
        docked: { stackId, index: 0 },
        floating: null,
      },
    };
    return { type: "stack", id: stackId, windowIds: [windowId], activeWindowId: windowId };
  });
  let level = 0;
  while (nodes.length > 1) {
    const next: AppWindowDockNodeShape[] = [];
    for (let index = 0; index < nodes.length; index += 8) {
      const children = nodes.slice(index, index + 8);
      if (children.length === 1) next.push(children[0]!);
      else {
        next.push({
          type: "split",
          id: `split.dock.${level}.${index / 8}`,
          axis: level % 2 === 0 ? "horizontal" : "vertical",
          children,
          weights: children.map(() => 1),
        });
      }
    }
    nodes = next;
    level += 1;
  }
  windows["window.float"] = {
    id: "window.float",
    source: { kind: "terminal", terminalSourceId: "terminal.float" },
    title: null,
    placement: {
      mode: "floating",
      docked: null,
      floating: { x: 10, y: 10, width: 320, height: 200 },
    },
  };
  return AppWindowDocumentV1SchemaZ.parse({
    version: 1,
    revision: 0,
    updatedAt: NOW,
    windows,
    dockRoot: nodes[0],
    dockState: { mode: "collapsed", preferredHeight: null, focusZone: "canvas" },
    floatingOrder: ["window.float"],
    focusedWindowId: "window.float",
    activeLayoutId: null,
    layouts: {},
  });
}

const WINDOW_GROUP_ID = "terminal-window.0123456789abcdef0123";

/** A window whose `count` panes are separate floating AppWindows (the daemon
 *  still projects one per pane), plus one lone single-pane window for contrast. */
function multiPaneScene(count: number, focusedIndex: number): AppWindowDocumentV1 {
  const windows: Record<string, AppWindowInstance> = {};
  const floatingOrder: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const windowId = `window.pane.${index}`;
    windows[windowId] = {
      id: windowId,
      source: { kind: "terminal", terminalSourceId: `terminal.pane.${index}` },
      title: null,
      placement: {
        mode: "floating",
        docked: null,
        floating: { x: 40 + index * 30, y: 30 + index * 26, width: 360, height: 220 },
      },
    };
    floatingOrder.push(windowId);
  }
  windows["window.solo"] = {
    id: "window.solo",
    source: { kind: "terminal", terminalSourceId: "terminal.solo" },
    title: "Solo",
    placement: {
      mode: "floating",
      docked: null,
      floating: { x: 600, y: 400, width: 320, height: 200 },
    },
  };
  floatingOrder.push("window.solo");
  // A focused floating window must be top-most (last in the stacking order).
  const focusedWindowId = `window.pane.${focusedIndex}`;
  return AppWindowDocumentV1SchemaZ.parse({
    version: 1,
    revision: 4,
    updatedAt: NOW,
    windows,
    dockRoot: null,
    dockState: { mode: "collapsed", preferredHeight: null, focusZone: "canvas" },
    floatingOrder: [...floatingOrder.filter((id) => id !== focusedWindowId), focusedWindowId],
    focusedWindowId,
    activeLayoutId: null,
    layouts: {},
  });
}

function paneGroup(count: number): Map<string, string> {
  const map = new Map<string, string>();
  for (let index = 0; index < count; index += 1) {
    map.set(`terminal.pane.${index}`, WINDOW_GROUP_ID);
  }
  return map;
}

describe("projectAppWindowCanvas client-local presentation", () => {
  it("projects distinct focus and active stack tabs without changing shared layout", () => {
    const document = scene();
    const base = createClientViewStateV1({
      clientId: "client.browser",
      viewId: "view.one",
      workspaceId: "workspace.shared",
      legacyDocument: document,
    });
    const first = projectAppWindowCanvas(
      document,
      { width: 900, height: 540 },
      {
        clientViewState: {
          ...base,
          focusedWindowId: "window.lead",
          selectedWindowIds: ["window.lead"],
          activeWindowIdsByStack: { ...base.activeWindowIdsByStack, "stack.left": "window.lead" },
        },
      },
    );
    const second = projectAppWindowCanvas(
      document,
      { width: 900, height: 540 },
      {
        clientViewState: {
          ...base,
          viewId: "view.two",
          focusedWindowId: "window.hidden",
          selectedWindowIds: ["window.hidden"],
          activeWindowIdsByStack: { ...base.activeWindowIdsByStack, "stack.left": "window.hidden" },
        },
      },
    );

    expect(first.focusedWindowId).toBe("window.lead");
    expect(first.windows.some(({ windowId }) => windowId === "window.lead")).toBe(true);
    expect(second.focusedWindowId).toBe("window.hidden");
    expect(second.windows.some(({ windowId }) => windowId === "window.hidden")).toBe(true);
    expect(document.focusedWindowId).toBe("window.review");
    expect(document.dockRoot?.type === "split" && document.dockRoot.children[0]).toMatchObject({
      type: "stack",
      activeWindowId: "window.lead",
    });
  });
});

describe("projectAppWindowCanvas window coalescing", () => {
  it("collapses the panes of one durable window into a single representative card", () => {
    const projection = projectAppWindowCanvas(
      multiPaneScene(9, 0),
      { width: 1_200, height: 720 },
      { windowGroupBySourceId: paneGroup(9) },
    );
    const cards = projection.windows.map(({ windowId }) => windowId).sort();
    // Nine panes + the solo window collapse to one representative card + solo.
    expect(cards).toEqual(["window.pane.0", "window.solo"]);
    const representative = projection.windows.find(({ windowId }) => windowId === "window.pane.0")!;
    expect(representative.windowGroupPaneCount).toBe(9);
    expect(representative.rect).toEqual({ x: 40, y: 30, width: 360, height: 220 });
    expect([...projection.hiddenWindowIds].sort()).toEqual([
      "window.pane.1",
      "window.pane.2",
      "window.pane.3",
      "window.pane.4",
      "window.pane.5",
      "window.pane.6",
      "window.pane.7",
      "window.pane.8",
    ]);
    const solo = projection.windows.find(({ windowId }) => windowId === "window.solo")!;
    expect(solo.windowGroupPaneCount).toBeUndefined();
  });

  it("folds selection and remaps a focus that landed on a coalesced-away pane", () => {
    const projection = projectAppWindowCanvas(
      multiPaneScene(3, 2),
      { width: 1_200, height: 720 },
      { windowGroupBySourceId: paneGroup(3) },
    );
    // Focus was on window.pane.2 (a hidden member); it resolves to the card.
    expect(projection.focusedWindowId).toBe("window.pane.0");
    const representative = projection.windows.find(({ windowId }) => windowId === "window.pane.0")!;
    expect(representative.selected).toBe(true);
    expect(representative.active).toBe(true);
  });

  it("leaves a single-pane window untouched even when it carries a window id", () => {
    const projection = projectAppWindowCanvas(
      multiPaneScene(1, 0),
      { width: 1_200, height: 720 },
      { windowGroupBySourceId: paneGroup(1) },
    );
    expect(projection.windows.map(({ windowId }) => windowId).sort()).toEqual([
      "window.pane.0",
      "window.solo",
    ]);
    expect(
      projection.windows.every(({ windowGroupPaneCount }) => windowGroupPaneCount === undefined),
    ).toBe(true);
    expect(projection.hiddenWindowIds).toEqual([]);
  });

  it("is a no-op without a grouping map (single card per pane)", () => {
    const projection = projectAppWindowCanvas(multiPaneScene(3, 0), { width: 1_200, height: 720 });
    expect(projection.windows).toHaveLength(4);
    expect(projection.hiddenWindowIds).toEqual([]);
  });
});

describe("projectAppWindowCanvas", () => {
  it("projects canonical dock, tab, floating, focus, and z-order state at 800x500", () => {
    expect(
      projectAppWindowCanvas(scene(), { width: 800, height: 500 }, { gap: 8 }),
    ).toMatchSnapshot();
  });

  it("allocates the same semantic scene deterministically at 1440x900", () => {
    expect(
      projectAppWindowCanvas(scene(), { width: 1_440, height: 900 }, { gap: 8 }),
    ).toMatchSnapshot();
  });

  it("creates a stable canonical focus command without leaking terminal identity", () => {
    expect(appWindowFocusInvocation("window.worker", "mouse")).toEqual({
      command: { type: "window.focus", windowId: "window.worker" },
      source: "mouse",
    });
  });

  it("keeps every floating window above a large dock inventory", () => {
    const projection = projectAppWindowCanvas(manyDockWindowsScene(110), {
      width: 1_920,
      height: 1_080,
    });
    const floating = projection.windows.find(({ windowId }) => windowId === "window.float")!;
    const dockZ = projection.windows
      .filter(({ placement }) => placement === "docked")
      .map(({ zIndex }) => zIndex);

    expect(dockZ).toHaveLength(110);
    expect(floating.zIndex).toBeGreaterThan(Math.max(...dockZ));
  });
});
