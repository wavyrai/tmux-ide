import { describe, expect, it } from "vitest";

import {
  clampTerminalViewportOrigin,
  terminalLiveViewportOrigin,
  terminalViewportCell,
} from "./terminal-viewport.ts";

describe("client-local terminal viewport", () => {
  it("keeps the reproduced 77×49 pane cursor visible inside 53×40 content cells", () => {
    const source = { cols: 77, rows: 49, cursor: { x: 18, y: 42, hidden: false } };
    const viewport = { cols: 53, rows: 40 };
    const before = structuredClone(source);
    const origin = terminalLiveViewportOrigin(source, viewport);
    expect(origin).toEqual({ x: 0, y: 9 });
    expect(terminalViewportCell(viewport, origin, 18, 33)).toEqual({ col: 18, row: 42 });
    expect(terminalViewportCell(viewport, origin, 52, 39)).toEqual({ col: 52, row: 48 });
    expect(source).toEqual(before);
  });

  it("uses native tmux horizontal centering and vertical cursor-follow before the far edge", () => {
    const source = { cols: 200, rows: 150, cursor: { x: 90, y: 50, hidden: false } };
    expect(terminalLiveViewportOrigin(source, { cols: 60, rows: 40 })).toEqual({ x: 60, y: 11 });
    expect(
      terminalLiveViewportOrigin(
        { ...source, cursor: { ...source.cursor, x: 199, y: 149 } },
        { cols: 60, rows: 40 },
      ),
    ).toEqual({ x: 140, y: 110 });
  });

  it("preserves top-left when the cursor fits or is hidden, and resets when the client grows", () => {
    const source = { cols: 77, rows: 49, cursor: { x: 18, y: 39, hidden: false } };
    expect(terminalLiveViewportOrigin(source, { cols: 53, rows: 40 })).toEqual({ x: 0, y: 0 });
    expect(
      terminalLiveViewportOrigin(
        { ...source, cursor: { x: 76, y: 48, hidden: true } },
        { cols: 53, rows: 40 },
      ),
    ).toEqual({ x: 0, y: 0 });
    expect(
      terminalLiveViewportOrigin(
        { ...source, cursor: { x: 76, y: 48, hidden: false } },
        { cols: 100, rows: 60 },
      ),
    ).toEqual({ x: 0, y: 0 });
  });

  it("maps a retained history origin without following live cursor changes", () => {
    const viewport = { cols: 53, rows: 40 };
    const origin = { x: 12, y: -7 };
    expect(terminalViewportCell(viewport, origin, 0, 0)).toEqual({ col: 12, row: -7 });
    expect(terminalViewportCell(viewport, origin, 52, 39)).toEqual({ col: 64, row: 32 });
    for (const [col, row] of [
      [-1, 0],
      [53, 0],
      [0, -1],
      [0, 40],
      [0.5, 0],
      [NaN, 0],
    ]) {
      expect(terminalViewportCell(viewport, origin, col!, row!)).toBeNull();
    }
  });
});

it("clamps a retained reading origin after the native grid shrinks or the client grows", () => {
  expect(
    clampTerminalViewportOrigin(
      { cols: 20, rows: 10 },
      { cols: 15, rows: 8 },
      { x: 24, y: 6 },
      100,
    ),
  ).toEqual({ x: 5, y: 2 });
  expect(
    clampTerminalViewportOrigin(
      { cols: 20, rows: 10 },
      { cols: 30, rows: 20 },
      { x: 24, y: -5 },
      100,
    ),
  ).toEqual({ x: 0, y: -5 });
  expect(
    clampTerminalViewportOrigin(
      { cols: 20, rows: 10 },
      { cols: 15, rows: 8 },
      { x: 24, y: -105 },
      100,
    ),
  ).toEqual({ x: 5, y: -100 });
});
