import { describe, expect, it } from "vitest";
import {
  tuiEscapeFocusTarget,
  tuiInteractionPresentation,
  type TuiInteractionContext,
} from "./interaction-flow.ts";

function context(overrides: Partial<TuiInteractionContext> = {}): TuiInteractionContext {
  return {
    dialogOpen: false,
    menuOpen: false,
    paletteOpen: false,
    searchOpen: false,
    surface: "mirror",
    focusZone: "canvas",
    dockMode: "open",
    activeDockTab: "files",
    missionMode: "board",
    editorFocus: "list",
    editorFilterOpen: false,
    diffFilterOpen: false,
    homePromptOpen: false,
    hosted: false,
    ...overrides,
  };
}

describe("TUI interaction flow", () => {
  it.each([
    [context({ dialogOpen: true, paletteOpen: true }), "DIALOG", "dialog"],
    [context({ menuOpen: true, paletteOpen: true }), "MENU", "menu"],
    [context({ paletteOpen: true }), "COMMANDS", "command palette"],
    [context({ searchOpen: true }), "SEARCH", "terminal search"],
    [context({ focusZone: "dock-tabs" }), "TOOL TABS", "tool tabs"],
    [context({ surface: "editor", editorFilterOpen: true }), "FILTER", "file filter"],
    [context({ surface: "editor", editorFocus: "editor" }), "EDITOR", "file editor"],
    [context({ surface: "diff" }), "CHANGES", "changes"],
    [context({ surface: "missions", missionMode: "detail" }), "MISSION", "mission detail"],
    [context({ surface: "home" }), "HOME", "workspace list"],
    [context(), "TERMINAL INPUT", "terminal"],
  ] as const)("projects the active input owner", (input, mode, focus) => {
    expect(tuiInteractionPresentation(input)).toMatchObject({ mode, focus });
  });

  it("only advertises commands valid in the current mode", () => {
    expect(tuiInteractionPresentation(context()).help).toContain("F8 focus tools");
    expect(tuiInteractionPresentation(context({ surface: "editor" })).help).toContain("/ filter");
    expect(
      tuiInteractionPresentation(context({ surface: "editor", editorFocus: "editor" })).help,
    ).toContain("esc file list");
    expect(tuiInteractionPresentation(context({ hosted: true })).help).toContain("^q detach");
  });

  it("backs out through local state, dock body, dock tabs, then workspace", () => {
    expect(tuiEscapeFocusTarget({ focusZone: "dock-body", layer: "editor-input" })).toBeNull();
    expect(tuiEscapeFocusTarget({ focusZone: "dock-body", layer: "editor-list" })).toBe(
      "dock-tabs",
    );
    expect(tuiEscapeFocusTarget({ focusZone: "dock-tabs", layer: "terminal" })).toBe("canvas");
    expect(tuiEscapeFocusTarget({ focusZone: "canvas", layer: "terminal" })).toBeNull();
  });
});
