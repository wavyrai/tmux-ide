import { describe, expect, it } from "vitest";
import {
  resolvePaneAppearance,
  statusToneForDomainStatus,
  type PaneVisualStateV1,
} from "../pane-appearance.ts";

const baseState = (): PaneVisualStateV1 => ({
  structure: "docked",
  applicationFocus: { pane: false, terminalInput: false, windowActive: true },
  agentActivity: "idle",
  domainStatus: "idle",
  attention: "none",
  layoutInteraction: {
    editable: true,
    selected: false,
    dragging: false,
    resizing: false,
    previewing: false,
  },
  controlInteraction: {
    hover: false,
    focusVisible: false,
    pressed: false,
    disabled: false,
    loading: false,
  },
});

describe("pane appearance composition", () => {
  it("maps canonical domain statuses to stable tones", () => {
    expect(
      Object.fromEntries(
        (
          ["idle", "running", "blocked", "review", "done", "disconnected", "recovering"] as const
        ).map((status) => [status, statusToneForDomainStatus(status)]),
      ),
    ).toEqual({
      idle: "neutral",
      running: "info",
      blocked: "warning",
      review: "info",
      done: "success",
      disconnected: "danger",
      recovering: "danger",
    });
  });

  it("preserves focus, selection, attention, and action states in separate slots", () => {
    const state: PaneVisualStateV1 = {
      ...baseState(),
      structure: "floating",
      applicationFocus: { pane: true, terminalInput: true, windowActive: true },
      agentActivity: "running",
      domainStatus: "blocked",
      attention: "destructive",
      layoutInteraction: {
        editable: true,
        selected: true,
        dragging: true,
        resizing: false,
        previewing: true,
      },
      controlInteraction: {
        hover: true,
        focusVisible: true,
        pressed: true,
        disabled: true,
        loading: true,
      },
    };
    const appearance = resolvePaneAppearance(state);

    expect(appearance.header).toEqual(
      expect.objectContaining({ surface: "headerActive", focused: true, attention: "destructive" }),
    );
    expect(appearance.border).toEqual({
      role: "focused",
      strength: "decisive",
      ownsApplicationFocus: true,
    });
    expect(appearance.outerOutline).toEqual({
      visible: true,
      role: "selected",
      intent: "layout-selection",
    });
    expect(appearance.status).toEqual({
      domainStatus: "blocked",
      domainTone: "warning",
      attentionTone: "danger",
      tone: "danger",
      attention: "destructive",
    });
    expect(appearance.action).toEqual(
      expect.objectContaining({
        background: "disabled",
        focusOutline: "focused",
        hover: true,
        pressed: true,
        disabled: true,
        loading: true,
        interactive: false,
      }),
    );
    expect(appearance.accessibility).toEqual(
      expect.objectContaining({
        focused: true,
        terminalInputOwner: true,
        layoutSelected: true,
        hasAttention: true,
        busy: true,
        disabled: true,
      }),
    );
  });

  it("does not confuse terminal input ownership with application focus styling", () => {
    const state = baseState();
    state.applicationFocus = { pane: true, terminalInput: false, windowActive: true };
    const appFocused = resolvePaneAppearance(state);
    state.applicationFocus = { pane: true, terminalInput: true, windowActive: true };
    const terminalFocused = resolvePaneAppearance(state);

    expect(terminalFocused.border).toEqual(appFocused.border);
    expect(terminalFocused.header).toEqual(appFocused.header);
    expect(terminalFocused.accessibility.terminalInputOwner).toBe(true);
  });

  it("renders inactive-window focus quietly and remains pure", () => {
    const state = baseState();
    state.applicationFocus = { pane: true, terminalInput: true, windowActive: false };
    state.attention = "warning";
    const before = JSON.stringify(state);
    const first = resolvePaneAppearance(state);
    const second = resolvePaneAppearance(state);

    expect(first).toEqual(second);
    expect(JSON.stringify(state)).toBe(before);
    expect(first.header).toEqual(expect.objectContaining({ surface: "header", text: "muted" }));
    expect(first.border).toEqual({
      role: "attention",
      strength: "decisive",
      ownsApplicationFocus: false,
    });
  });
});
