import { describe, expect, it } from "vitest";
import {
  terminalPaneSeparatorAt,
  terminalPaneResizePreview,
} from "./application-terminal-workspace-policy.ts";

import {
  nativePaneGeometries,
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
  it.each([
    ["off", 4, 5],
    ["top", 3, 5],
    ["bottom", 4, 4],
  ] as const)(
    "retains all native pane sizes with %s borders before compact clipping",
    (status, firstRows, secondRows) => {
      const stacked = {
        ...layout,
        paneBorderStatus: status,
        panes: [
          { pane: "a", left: 0, top: 0, width: 20, height: 4, active: true },
          { pane: "b", left: 0, top: 5, width: 20, height: 5, active: false },
          { pane: null, left: 0, top: 0, width: 20, height: 1, active: false },
        ],
      };
      expect(projectOpenTuiPaneFrames(stacked, { width: 5, height: 3 }, "b")).toHaveLength(1);
      expect(nativePaneGeometries(stacked)).toEqual([
        { paneId: "a", cols: 20, rows: firstRows },
        { paneId: "b", cols: 20, rows: secondRows },
      ]);
    },
  );
  it("keeps the selected pane reachable when stacked headers cannot fit", () => {
    const stacked = {
      ...layout,
      panes: [
        { pane: "a", left: 0, top: 0, width: 20, height: 4, active: true },
        { pane: "b", left: 0, top: 5, width: 20, height: 5, active: false },
      ],
    };
    const before = structuredClone(stacked);
    for (const [selected, index] of [
      ["a", 1],
      ["b", 2],
    ] as const) {
      const frames = projectOpenTuiPaneFrames(stacked, { width: 20, height: 3 }, selected);
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({
        paneId: selected,
        left: 0,
        top: 0,
        width: 20,
        height: 3,
        contentHeight: 2,
        compactPosition: `${index}/2`,
      });
    }
    expect(projectOpenTuiPaneFrames(stacked, { width: 20, height: 3 }, "removed")[0]?.paneId).toBe(
      "a",
    );
    expect(projectOpenTuiPaneFrames(stacked, { width: 20, height: 11 }, "b")).toHaveLength(2);
    expect(stacked).toEqual(before);
  });
  it("reserves chrome inside each pane and never paints below the canvas", () => {
    expect(projectOpenTuiPaneFrames(layout, { width: 20, height: 10 })).toEqual([
      {
        paneId: "pane.editor",
        left: 0,
        top: 0,
        width: 10,
        height: 10,
        contentHeight: 9,
        nativeHeight: 10,
        active: true,
      },
      {
        paneId: "pane.tests",
        left: 10,
        top: 0,
        width: 10,
        height: 10,
        contentHeight: 9,
        nativeHeight: 10,
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
        nativeHeight: 8,
        nativeWidth: 10,
        active: true,
      },
    ]);
  });
  it("fits both panes into a smaller observer without mutating native geometry", () => {
    const before = structuredClone(layout);
    const frames = projectOpenTuiPaneFrames(layout, { width: 8, height: 6 });
    expect(
      frames.map((frame) => [
        frame.paneId,
        frame.left,
        frame.width,
        frame.contentHeight,
        frame.nativeWidth,
      ]),
    ).toEqual([
      ["pane.editor", 0, 4, 5, 10],
      ["pane.tests", 4, 4, 5, 10],
    ]);
    expect(layout).toEqual(before);
  });
  it("preserves the vertical separator and stacked header boundaries when fitting nested splits", () => {
    const nested = {
      ...layout,
      cols: 132,
      rows: 41,
      paneBorderStatus: "top" as const,
      panes: [
        { pane: "a", left: 0, top: 0, width: 69, height: 41, active: true },
        { pane: "b", left: 70, top: 0, width: 62, height: 20, active: false },
        { pane: "c", left: 70, top: 21, width: 62, height: 20, active: false },
      ],
    };
    const [a, b, c] = projectOpenTuiPaneFrames(nested, { width: 70, height: 21 });
    expect(a!.left + a!.width + 1).toBe(b!.left);
    expect(b!.left).toBe(c!.left);
    expect(b!.top + b!.height).toBe(c!.top);
    expect(a!.height).toBe(21);
    expect(c!.top + c!.height).toBe(21);
    expect(c!.left + c!.width).toBe(70);
    expect([a, b, c].every((frame) => frame!.contentHeight > 0)).toBe(true);
    const frames = [a!, b!, c!];
    const horizontal = terminalPaneSeparatorAt(frames, "top", a!.width, 2)!;
    expect(horizontal.initialCells).toBe(69);
    const preview = terminalPaneResizePreview(
      horizontal,
      horizontal.position + 3,
      horizontal.position,
    );
    expect(preview.cells).toBe(75);
    expect(preview.guide.x).toBe(horizontal.position + 3);
    const vertical = terminalPaneSeparatorAt(frames, "top", c!.left, c!.top)!;
    expect(vertical.initialCells).toBe(19);
    const resized = terminalPaneResizePreview(vertical, vertical.position + 2, vertical.position);
    expect(resized.cells).toBe(23);
    expect(resized.guide.y).toBe(vertical.position + 2);
  });
});

for (const status of ["off", "top", "bottom"] as const) {
  it(`preserves every native content row in stacked panes with ${status} borders`, () => {
    const window = {
      ...layout,
      rows: 21,
      paneBorderStatus: status,
      panes: [
        { pane: "a", left: 0, top: 0, width: 20, height: 10, active: true },
        { pane: "b", left: 0, top: 11, width: 20, height: 10, active: false },
      ],
    };
    const frames = projectOpenTuiPaneFrames(window, {
      width: 20,
      height: status === "off" ? 22 : 21,
    });
    expect(frames.map((f) => f.contentHeight)).toEqual(
      status === "top" ? [9, 10] : status === "bottom" ? [10, 9] : [10, 10],
    );
    expect(frames[1]!.top).toBe(frames[0]!.top + frames[0]!.height);
    expect(frames[1]!.top + frames[1]!.height).toBe(status === "off" ? 22 : 21);
  });
}
