import { AppWindowDocumentV1SchemaZ, type AppWindowDocumentV1 } from "@tmux-ide/contracts";
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
});
