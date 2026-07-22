import {
  AppWindowDocumentV1SchemaZ,
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
