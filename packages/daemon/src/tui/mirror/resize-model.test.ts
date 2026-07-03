import { describe, expect, it } from "vitest";
import {
  separatorAt,
  resizedSize,
  resizeCommand,
  MIN_PANE,
  type PaneRect,
} from "./resize-model.ts";

// A side-by-side layout: left pane [0..39], a 1-col separator at 40, right pane
// [41..79], both 24 rows tall. tmux excludes the border from pane_width, so the
// gap column is exactly `left.left + left.width`.
const sideBySide: PaneRect[] = [
  { id: "%0", left: 0, top: 0, width: 40, height: 24 },
  { id: "%1", left: 41, top: 0, width: 39, height: 24 },
];

// A stacked layout: top pane rows [0..11], separator row 12, bottom [13..23],
// both 80 cols wide.
const stacked: PaneRect[] = [
  { id: "%0", left: 0, top: 0, width: 80, height: 12 },
  { id: "%1", left: 0, top: 13, width: 80, height: 11 },
];

describe("separatorAt", () => {
  it("resolves a vertical separator between left/right panes", () => {
    expect(separatorAt(sideBySide, 40, 10)).toEqual({
      axis: "x",
      aId: "%0",
      bId: "%1",
      aSize: 40,
      bSize: 39,
    });
  });

  it("resolves the vertical separator at any covered row", () => {
    expect(separatorAt(sideBySide, 40, 0)?.axis).toBe("x");
    expect(separatorAt(sideBySide, 40, 23)?.axis).toBe("x");
  });

  it("resolves a horizontal separator between top/bottom panes", () => {
    expect(separatorAt(stacked, 30, 12)).toEqual({
      axis: "y",
      aId: "%0",
      bId: "%1",
      aSize: 12,
      bSize: 11,
    });
  });

  it("returns null inside a pane rect", () => {
    expect(separatorAt(sideBySide, 20, 10)).toBeNull(); // inside left
    expect(separatorAt(sideBySide, 60, 10)).toBeNull(); // inside right
    expect(separatorAt(stacked, 30, 5)).toBeNull(); // inside top
  });

  it("returns null off the separator (past the covered span)", () => {
    // Column 40 is the separator only where BOTH panes cover the row. Here they
    // both span all rows, so pick a row past the panes.
    expect(separatorAt(sideBySide, 40, 40)).toBeNull();
    // A column with no pane ending there is not a separator.
    expect(separatorAt(sideBySide, 39, 10)).toBeNull();
  });

  it("returns null when only one side is present (edge of the canvas)", () => {
    const single: PaneRect[] = [{ id: "%0", left: 0, top: 0, width: 40, height: 24 }];
    expect(separatorAt(single, 40, 10)).toBeNull();
  });

  it("returns null for an empty layout", () => {
    expect(separatorAt([], 40, 10)).toBeNull();
  });
});

describe("resizedSize", () => {
  const sep = separatorAt(sideBySide, 40, 10)!; // aSize 40, bSize 39, total 79

  it("adds a positive delta to a's starting size", () => {
    expect(resizedSize(sep, 10)).toBe(50);
  });

  it("adds a negative delta (drag left shrinks a)", () => {
    expect(resizedSize(sep, -15)).toBe(25);
  });

  it("clamps so a never drops below MIN_PANE", () => {
    expect(resizedSize(sep, -1000)).toBe(MIN_PANE);
  });

  it("clamps so b never drops below MIN_PANE", () => {
    // total 79, b floor MIN_PANE → a max 79 - MIN_PANE = 77.
    expect(resizedSize(sep, 1000)).toBe(79 - MIN_PANE);
  });
});

describe("resizeCommand", () => {
  it("emits an absolute -x for a vertical separator", () => {
    const sep = separatorAt(sideBySide, 40, 10)!;
    expect(resizeCommand(sep, 50)).toBe("resize-pane -t %0 -x 50");
  });

  it("emits an absolute -y for a horizontal separator", () => {
    const sep = separatorAt(stacked, 30, 12)!;
    expect(resizeCommand(sep, 16)).toBe("resize-pane -t %0 -y 16");
  });
});
