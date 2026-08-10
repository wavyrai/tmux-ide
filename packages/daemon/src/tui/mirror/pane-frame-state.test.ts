import { describe, expect, it } from "vitest";
import type { LivePane } from "./session-mirror.ts";
import {
  livePaneVersions,
  sameLivePaneStructure,
  sameLivePaneVersions,
} from "./pane-frame-state.ts";

function pane(overrides: Partial<LivePane> = {}): LivePane {
  return {
    id: "%1",
    left: 0,
    top: 0,
    width: 80,
    height: 24,
    active: true,
    appMouse: false,
    zoomed: false,
    scrollbackDepth: 0,
    version: 1,
    snapshot: { rows: [], cursorX: 0, cursorY: 0, scrollOffset: 0 },
    ...overrides,
  };
}

describe("pane frame state", () => {
  it("keeps shell structure stable for cell and cursor-only updates", () => {
    const previous = [pane()];
    const next = [
      pane({
        version: 2,
        snapshot: { rows: [], cursorX: 12, cursorY: 8, scrollOffset: 0 },
      }),
    ];

    expect(sameLivePaneStructure(previous, next)).toBe(true);
    expect(sameLivePaneVersions(livePaneVersions(previous), livePaneVersions(next))).toBe(false);
  });

  it.each([
    { width: 79 },
    { height: 23 },
    { left: 1 },
    { top: 1 },
    { active: false },
    { appMouse: true },
    { zoomed: true },
    { scrollbackDepth: 1 },
    { snapshot: { rows: [], cursorX: 0, cursorY: 0, scrollOffset: 1 } },
  ] satisfies Array<Partial<LivePane>>)("publishes structural change %#", (change) => {
    expect(sameLivePaneStructure([pane()], [pane(change)])).toBe(false);
  });

  it("compares pane versions by identity and value", () => {
    expect(
      sameLivePaneVersions(
        new Map([
          ["%1", 4],
          ["%2", 9],
        ]),
        new Map([
          ["%1", 4],
          ["%2", 9],
        ]),
      ),
    ).toBe(true);
    expect(sameLivePaneVersions(new Map([["%1", 4]]), new Map([["%2", 4]]))).toBe(false);
  });
});
