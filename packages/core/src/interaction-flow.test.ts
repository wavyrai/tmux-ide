import { describe, expect, it } from "vitest";
import {
  cycleWorkspaceFocusZone,
  workspaceEscapeFocusTarget,
  workspaceInteractionPresentation,
  type WorkspaceInteractionContext,
} from "./interaction-flow.ts";

function context(
  overrides: Partial<WorkspaceInteractionContext> = {},
): WorkspaceInteractionContext {
  return {
    overlay: null,
    surface: "terminals",
    focusZone: "canvas",
    dockMode: "open",
    missionMode: "board",
    editorFocus: "list",
    editorFilterOpen: false,
    diffFilterOpen: false,
    homePromptOpen: false,
    hosted: false,
    ...overrides,
  };
}

describe("renderer-neutral workspace interaction flow", () => {
  it.each([
    [context({ overlay: "dialog" }), "DIALOG", "dialog"],
    [context({ overlay: "commands" }), "COMMANDS", "command palette"],
    [context({ focusZone: "dock-tabs" }), "TOOL TABS", "tool tabs"],
    [context({ surface: "files", editorFilterOpen: true }), "FILTER", "file filter"],
    [context({ surface: "files", editorFocus: "editor" }), "EDITOR", "file editor"],
    [context({ surface: "changes" }), "CHANGES", "changes"],
    [context({ surface: "missions", missionMode: "detail" }), "MISSION", "mission detail"],
    [context({ surface: "home" }), "HOME", "workspace list"],
    [context(), "TERMINAL INPUT", "terminal"],
  ] as const)("projects the active input owner", (input, mode, focus) => {
    expect(workspaceInteractionPresentation(input)).toMatchObject({ mode, focus });
  });

  it("walks the same reversible focus ring for every renderer", () => {
    expect(cycleWorkspaceFocusZone("canvas", "open")).toBe("dock-tabs");
    expect(cycleWorkspaceFocusZone("dock-tabs", "open")).toBe("dock-body");
    expect(cycleWorkspaceFocusZone("dock-body", "open")).toBe("canvas");
    expect(cycleWorkspaceFocusZone("dock-tabs", "collapsed")).toBe("canvas");
    expect(cycleWorkspaceFocusZone("canvas", "open", "previous")).toBe("dock-body");
  });

  it("advertises the tmux-safe focus key", () => {
    expect(workspaceInteractionPresentation(context()).help).toContain("F8 focus tools");
    expect(workspaceInteractionPresentation(context()).help).not.toContain("^tab");
  });

  it("backs out through local state before parent focus zones", () => {
    expect(
      workspaceEscapeFocusTarget({ focusZone: "dock-body", layer: "editor-input" }),
    ).toBeNull();
    expect(workspaceEscapeFocusTarget({ focusZone: "dock-body", layer: "editor-list" })).toBe(
      "dock-tabs",
    );
    expect(workspaceEscapeFocusTarget({ focusZone: "dock-tabs", layer: "terminal" })).toBe(
      "canvas",
    );
  });
});
