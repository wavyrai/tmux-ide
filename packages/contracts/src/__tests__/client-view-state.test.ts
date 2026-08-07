import { describe, expect, it } from "vitest";

import { AppWindowDocumentV1SchemaZ } from "../app-window-state.ts";
import {
  ClientViewStateV1SchemaZ,
  createClientViewStateV1,
  reconcileClientViewStateV1,
} from "../client-view-state.ts";

const shared = AppWindowDocumentV1SchemaZ.parse({
  version: 1,
  revision: 4,
  updatedAt: "2026-08-07T08:00:00.000Z",
  windows: {
    "window.one": {
      id: "window.one",
      source: { kind: "terminal", terminalSourceId: "pane.one" },
      title: "One",
      placement: { mode: "docked", docked: { stackId: "stack.main", index: 0 }, floating: null },
    },
    "window.two": {
      id: "window.two",
      source: { kind: "terminal", terminalSourceId: "pane.two" },
      title: "Two",
      placement: { mode: "docked", docked: { stackId: "stack.main", index: 1 }, floating: null },
    },
  },
  dockRoot: {
    type: "stack",
    id: "stack.main",
    windowIds: ["window.one", "window.two"],
    activeWindowId: "window.one",
  },
  dockState: { mode: "open", preferredHeight: 320, focusZone: "canvas" },
  floatingOrder: [],
  focusedWindowId: "window.one",
  activeLayoutId: null,
  layouts: {},
});

describe("ClientViewStateV1", () => {
  it("lets two views retain different presentation over one shared layout", () => {
    const first = ClientViewStateV1SchemaZ.parse({
      ...createClientViewStateV1({
        clientId: "client.browser",
        viewId: "view.first",
        workspaceId: "workspace.shared",
        legacyDocument: shared,
      }),
      focusedWindowId: "window.one",
      selectedWindowIds: ["window.one"],
      activeWindowIdsByStack: { "stack.main": "window.one" },
      dock: {
        mode: "open",
        preferredHeight: 320,
        focusZone: "dock-body",
        activeTabId: "changes",
      },
      viewport: { x: -100, y: 20, scale: 1.25 },
    });
    const second = ClientViewStateV1SchemaZ.parse({
      ...first,
      viewId: "view.second",
      focusedWindowId: "window.two",
      selectedWindowIds: ["window.two"],
      activeWindowIdsByStack: { "stack.main": "window.two" },
      dock: {
        mode: "collapsed",
        preferredHeight: 180,
        focusZone: "canvas",
        activeTabId: "activity",
      },
      viewport: { x: 40, y: -60, scale: 0.8 },
    });

    expect(first.focusedWindowId).toBe("window.one");
    expect(second.focusedWindowId).toBe("window.two");
    expect(first.dock).not.toEqual(second.dock);
    expect(first.viewport).not.toEqual(second.viewport);
    expect(shared.focusedWindowId).toBe("window.one");
    expect(shared.dockRoot?.type === "stack" && shared.dockRoot.activeWindowId).toBe("window.one");
  });

  it("drops stale shared-layout references while retaining local presentation", () => {
    const state = ClientViewStateV1SchemaZ.parse({
      ...createClientViewStateV1({
        clientId: "client.browser",
        viewId: "view.first",
        workspaceId: "workspace.shared",
        legacyDocument: shared,
      }),
      focusedWindowId: "window.two",
      selectedWindowIds: ["window.two"],
      activeWindowIdsByStack: { "stack.main": "window.two" },
      viewport: { x: 10, y: 20, scale: 1.5 },
    });
    const oneOnly = AppWindowDocumentV1SchemaZ.parse({
      ...shared,
      windows: { "window.one": shared.windows["window.one"] },
      dockRoot: {
        type: "stack",
        id: "stack.main",
        windowIds: ["window.one"],
        activeWindowId: "window.one",
      },
    });

    const reconciled = reconcileClientViewStateV1(state, oneOnly);

    expect(reconciled.focusedWindowId).toBeNull();
    expect(reconciled.selectedWindowIds).toEqual([]);
    expect(reconciled.activeWindowIdsByStack).toEqual({});
    expect(reconciled.viewport).toEqual({ x: 10, y: 20, scale: 1.5 });
  });
});
