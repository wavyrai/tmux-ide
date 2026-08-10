import { describe, expect, it } from "vitest";
import type { LivePane } from "./session-mirror.ts";
import { livePaneRuntime, sameLivePaneStructure, sameLivePaneRuntime } from "./pane-frame-state.ts";

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
    expect(sameLivePaneRuntime(livePaneRuntime(previous), livePaneRuntime(next))).toBe(false);
  });

  it.each([
    { width: 79 },
    { height: 23 },
    { left: 1 },
    { top: 1 },
    { active: false },
    { appMouse: true },
    { zoomed: true },
    { snapshot: { rows: [], cursorX: 0, cursorY: 0, scrollOffset: 1 } },
  ] satisfies Array<Partial<LivePane>>)("publishes structural change %#", (change) => {
    expect(sameLivePaneStructure([pane()], [pane(change)])).toBe(false);
  });

  it("keeps scrollback depth in runtime rather than shell structure", () => {
    const previous = [pane()];
    const next = [pane({ version: 2, scrollbackDepth: 40 })];

    expect(sameLivePaneStructure(previous, next)).toBe(true);
    expect(sameLivePaneRuntime(livePaneRuntime(previous), livePaneRuntime(next))).toBe(false);
  });

  it("compares pane runtime by identity and value", () => {
    expect(
      sameLivePaneRuntime(
        new Map([
          ["%1", { version: 4, scrollbackDepth: 10 }],
          ["%2", { version: 9, scrollbackDepth: 20 }],
        ]),
        new Map([
          ["%1", { version: 4, scrollbackDepth: 10 }],
          ["%2", { version: 9, scrollbackDepth: 20 }],
        ]),
      ),
    ).toBe(true);
    expect(
      sameLivePaneRuntime(
        new Map([["%1", { version: 4, scrollbackDepth: 10 }]]),
        new Map([["%2", { version: 4, scrollbackDepth: 10 }]]),
      ),
    ).toBe(false);
  });
});
