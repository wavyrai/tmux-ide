import { describe, expect, it } from "vitest";
import type { LivePane } from "./semantic-session-view.ts";
import {
  activeLivePaneId,
  livePaneRuntime,
  paneChromeInteractionState,
  projectPaneChromeState,
  resolvePaneChromeVisualState,
  samePaneChromeState,
  sameLivePaneRuntime,
  sameLivePaneStructure,
  withLivePaneFocus,
} from "./pane-frame-state.ts";
import type { PaneInteractionProjection } from "@tmux-ide/core";

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

function interaction(
  overrides: Partial<PaneInteractionProjection> = {},
): PaneInteractionProjection {
  return {
    paneId: "pane.tests",
    direction: "incoming",
    sourcePaneId: "pane.editor",
    destinationPaneId: "pane.tests",
    operationKind: "workspace.pane.send",
    operationId: "00000000-0000-4000-8000-000000000001",
    phase: "accepted",
    origin: "tui",
    label: "tui accepted · send 1 character",
    sequence: 1,
    at: "2026-08-11T18:00:00.000Z",
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

  it("keeps keyboard focus, controller ownership and attention orthogonal", () => {
    const controller = projectPaneChromeState({
      keyboardFocused: false,
      inputOwned: true,
      attention: "warning",
    });
    expect(controller).toMatchObject({
      keyboardFocus: "blurred",
      inputOwnership: "controller",
      reading: null,
      sending: null,
      attention: "warning",
    });
    expect(resolvePaneChromeVisualState(controller).primaryMarker).toBe("input-owner");

    const attention = projectPaneChromeState({
      keyboardFocused: true,
      inputOwned: false,
      attention: "requested",
    });
    expect(resolvePaneChromeVisualState(attention).primaryMarker).toBe("attention");

    const focus = projectPaneChromeState({ keyboardFocused: true, inputOwned: false });
    expect(resolvePaneChromeVisualState(focus).primaryMarker).toBe("keyboard-focus");
  });

  it("uses the canonical receipt vocabulary for read and send state", () => {
    const read = projectPaneChromeState({
      keyboardFocused: false,
      inputOwned: false,
      interaction: interaction({
        direction: "outgoing",
        operationKind: "workspace.pane.read",
        phase: "observed",
      }),
      paneLabel: (paneId) => (paneId === "pane.editor" ? "Editor" : "Tests"),
    });
    expect(read.reading).toMatchObject({
      role: "read-source",
      kind: "read",
      endpoint: "source",
      treatment: "observation",
      badge: "READING",
      tone: "info",
      label: "Editor reads Tests",
    });
    expect(read.sending).toBeNull();
    expect(resolvePaneChromeVisualState(read)).toMatchObject({
      primaryMarker: "idle",
      communication: { role: "read-source" },
    });

    const send = projectPaneChromeState({
      keyboardFocused: false,
      inputOwned: false,
      interaction: interaction({ direction: "incoming", phase: "rejected" }),
    });
    expect(send.sending).toMatchObject({
      role: "send-target",
      treatment: "transfer",
      badge: "FAILED",
      tone: "danger",
    });
    expect(send.keyboardFocus).toBe("blurred");
  });

  it("resolves overlapping send before read without discarding either fact", () => {
    const read = paneChromeInteractionState(
      interaction({ direction: "outgoing", operationKind: "workspace.pane.read" }),
    );
    const send = paneChromeInteractionState(interaction({ direction: "incoming" }));
    const state = {
      ...projectPaneChromeState({ keyboardFocused: false, inputOwned: false }),
      reading: read,
      sending: send,
    };
    expect(resolvePaneChromeVisualState(state).communication).toBe(send);
    expect(state.reading).toBe(read);
  });

  it("compares chrome independently and never mutates terminal content runtime", () => {
    const live = [pane({ version: 14, scrollbackDepth: 8 })];
    const runtimeBefore = livePaneRuntime(live);
    const first = projectPaneChromeState({ keyboardFocused: false, inputOwned: false });
    const equal = projectPaneChromeState({ keyboardFocused: false, inputOwned: false });
    const focused = projectPaneChromeState({ keyboardFocused: true, inputOwned: false });

    expect(samePaneChromeState(first, equal)).toBe(true);
    expect(samePaneChromeState(first, focused)).toBe(false);
    expect(live[0]!.version).toBe(14);
    expect(sameLivePaneRuntime(runtimeBefore, livePaneRuntime(live))).toBe(true);
  });
});
