import { describe, expect, it } from "vitest";
import type { LivePane } from "./session-mirror.ts";
import {
  activeLivePaneId,
  livePaneRuntime,
  sameLivePaneRuntime,
  sameLivePaneStructure,
  withLivePaneFocus,
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
    expect(sameLivePaneRuntime(livePaneRuntime(previous), livePaneRuntime(next))).toBe(false);
  });

  it.each([
    { width: 79 },
    { height: 23 },
    { left: 1 },
    { top: 1 },
    { appMouse: true },
    { zoomed: true },
    { snapshot: { rows: [], cursorX: 0, cursorY: 0, scrollOffset: 1 } },
  ] satisfies Array<Partial<LivePane>>)("publishes structural change %#", (change) => {
    expect(sameLivePaneStructure([pane()], [pane(change)])).toBe(false);
  });

  it("keeps focus changes out of the structural invalidation domain", () => {
    expect(
      sameLivePaneStructure(
        [pane({ id: "%1", active: true }), pane({ id: "%2", active: false })],
        [pane({ id: "%1", active: false }), pane({ id: "%2", active: true })],
      ),
    ).toBe(true);
  });

  it("projects optimistic focus without mutating structural panes", () => {
    const panes = [pane({ id: "%1", active: true }), pane({ id: "%2", active: false })];
    const projected = withLivePaneFocus(panes, "%2");

    expect(activeLivePaneId(panes, "%2")).toBe("%2");
    expect(projected.map(({ id, active }) => [id, active])).toEqual([
      ["%1", false],
      ["%2", true],
    ]);
    expect(panes[0]!.active).toBe(true);
  });

  it("falls back to authoritative focus when an explicit pane is absent", () => {
    const panes = [pane({ id: "%1", active: false }), pane({ id: "%2", active: true })];
    expect(activeLivePaneId(panes, "%closed")).toBe("%2");
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
