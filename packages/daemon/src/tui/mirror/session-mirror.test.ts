import { describe, expect, it } from "vitest";
import { parsePaneGeometry, diffPanes, type PaneGeometry } from "./session-mirror.ts";

const g = (id: string, left: number, top: number, w: number, h: number, active = false) =>
  ({ id, left, top, width: w, height: h, active, appMouse: false }) as PaneGeometry;

describe("parsePaneGeometry", () => {
  it("parses list-panes lines", () => {
    expect(parsePaneGeometry(["%1 0 0 80 20 1", "%2 81 0 79 20 0"])).toEqual([
      g("%1", 0, 0, 80, 20, true),
      g("%2", 81, 0, 79, 20),
    ]);
  });
  it("skips malformed lines", () => {
    expect(parsePaneGeometry(["junk", "%3 0 0 x 20 0", "", "%4 1 2 3 4 0 0"])).toEqual([
      g("%4", 1, 2, 3, 4),
    ]);
  });
});

describe("diffPanes", () => {
  const prev = [g("%1", 0, 0, 80, 20), g("%2", 81, 0, 79, 20)];
  it("detects adds and removes", () => {
    const d = diffPanes(prev, [g("%1", 0, 0, 80, 20), g("%3", 0, 21, 160, 10)]);
    expect(d.added.map((p) => p.id)).toEqual(["%3"]);
    expect(d.removed).toEqual(["%2"]);
  });
  it("detects resizes and pure moves separately", () => {
    const d = diffPanes(prev, [g("%1", 0, 0, 100, 20), g("%2", 101, 0, 79, 20)]);
    expect(d.resized.map((p) => p.id)).toEqual(["%1"]);
    expect(d.moved.map((p) => p.id)).toEqual(["%2"]);
  });
  it("empty diff when identical", () => {
    const d = diffPanes(prev, prev);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.resized).toEqual([]);
  });
});
