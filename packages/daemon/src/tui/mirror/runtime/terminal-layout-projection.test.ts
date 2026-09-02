import { describe, expect, it } from "vitest";

import {
  projectOpenTuiPaneFrames,
  type OpenTuiTerminalLayout,
} from "./terminal-layout-projection.ts";

const layout: OpenTuiTerminalLayout = {
  type: "layout",
  semanticWindowId: null,
  windowName: "main",
  currentWindow: true,
  cols: 20,
  rows: 10,
  zoomed: false,
  paneBorderStatus: "off",
  panes: [
    { pane: "pane.editor", left: 0, top: 0, width: 10, height: 10, active: true },
    { pane: "pane.tests", left: 10, top: 0, width: 10, height: 10, active: false },
  ],
};

describe("OpenTUI terminal layout projection", () => {
  it("reserves chrome inside each pane and never paints below the canvas", () => {
    expect(projectOpenTuiPaneFrames(layout, { width: 20, height: 10 })).toEqual([
      {
        paneId: "pane.editor",
        left: 0,
        top: 0,
        width: 10,
        height: 10,
        contentHeight: 9,
        active: true,
      },
      {
        paneId: "pane.tests",
        left: 10,
        top: 0,
        width: 10,
        height: 10,
        contentHeight: 9,
        active: false,
      },
    ]);
  });

  it("drops unverified panes and clamps stale geometry after a host resize", () => {
    const stale = {
      ...layout,
      panes: [
        { pane: null, left: 0, top: 0, width: 1, height: 1, active: false },
        { pane: "pane.editor", left: 18, top: 8, width: 10, height: 8, active: true },
      ],
    };
    expect(projectOpenTuiPaneFrames(stale, { width: 20, height: 10 })).toEqual([
      {
        paneId: "pane.editor",
        left: 18,
        top: 8,
        width: 2,
        height: 2,
        contentHeight: 1,
        active: true,
      },
    ]);
  });
});
