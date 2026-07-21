import { describe, expect, it } from "vitest";
import {
  FocusOverlayStateV1SchemaZ,
  closeTopOverlay,
  deterministicFocusFallback,
  resolveSemanticInputLayer,
  type FocusOverlayStateV1,
} from "../focus-overlay.ts";

const state = (overlays: FocusOverlayStateV1["overlays"] = []): FocusOverlayStateV1 => ({
  windowActivity: "active",
  focusZone: "terminal",
  appFocusedPaneId: "pane.b",
  terminalInputPaneId: "pane.b",
  layoutSelectedPaneId: null,
  overlays,
});

describe("focus and overlay semantics", () => {
  it("resolves modal, palette, context, app, and terminal ownership deterministically", () => {
    expect(
      resolveSemanticInputLayer(
        state([
          {
            id: "overlay.modal",
            kind: "modal-dialog",
            focusReturnTarget: { kind: "zone", zone: "canvas" },
          },
          {
            id: "overlay.context",
            kind: "context-menu",
            focusReturnTarget: { kind: "zone", zone: "canvas" },
          },
          {
            id: "overlay.palette",
            kind: "command-palette",
            focusReturnTarget: { kind: "zone", zone: "canvas" },
          },
        ]),
      ),
    ).toEqual({ kind: "modal-dialog", overlayId: "overlay.modal" });
    expect(resolveSemanticInputLayer(state())).toEqual({ kind: "terminal", paneId: "pane.b" });
    expect(resolveSemanticInputLayer({ ...state(), focusZone: "sidebar" })).toEqual({
      kind: "app",
      zone: "sidebar",
    });
  });

  it("restores a valid semantic target when closing only the top overlay", () => {
    const result = closeTopOverlay(
      state([
        {
          id: "overlay.palette",
          kind: "command-palette",
          focusReturnTarget: { kind: "zone", zone: "sidebar" },
        },
        {
          id: "overlay.context",
          kind: "context-menu",
          focusReturnTarget: { kind: "pane", paneId: "pane.a", input: "terminal" },
        },
      ]),
      { paneIds: new Set(["pane.a", "pane.b"]) },
    );
    expect(result.closedOverlayId).toBe("overlay.context");
    expect(result.restoredTarget).toEqual({ kind: "pane", paneId: "pane.a", input: "terminal" });
    expect(result.state.overlays.map(({ id }) => id)).toEqual(["overlay.palette"]);
    expect(result.state).toEqual(
      expect.objectContaining({
        focusZone: "terminal",
        appFocusedPaneId: "pane.a",
        terminalInputPaneId: "pane.a",
      }),
    );
  });

  it("falls back to focused, sorted available, then navigation targets", () => {
    expect(deterministicFocusFallback(state(), { paneIds: new Set(["pane.c", "pane.b"]) })).toEqual(
      {
        kind: "pane",
        paneId: "pane.b",
        input: "chrome",
      },
    );
    expect(
      deterministicFocusFallback(
        { ...state(), appFocusedPaneId: "pane.missing", terminalInputPaneId: null },
        { paneIds: new Set(["pane.c", "pane.a"]) },
      ),
    ).toEqual({ kind: "pane", paneId: "pane.a", input: "chrome" });
    expect(
      deterministicFocusFallback(
        { ...state(), appFocusedPaneId: null, terminalInputPaneId: null },
        { paneIds: new Set() },
      ),
    ).toEqual({ kind: "zone", zone: "primary-navigation" });
  });

  it("rejects ambiguous overlay and terminal ownership", () => {
    const duplicate = {
      id: "overlay.duplicate",
      kind: "context-menu" as const,
      focusReturnTarget: { kind: "zone" as const, zone: "canvas" as const },
    };
    expect(FocusOverlayStateV1SchemaZ.safeParse(state([duplicate, duplicate])).success).toBe(false);
    expect(
      FocusOverlayStateV1SchemaZ.safeParse({ ...state(), terminalInputPaneId: "pane.a" }).success,
    ).toBe(false);
  });
});
