import {
  workspaceEscapeFocusTarget,
  workspaceInteractionPresentation,
  type WorkspaceInteractionLayer,
} from "@tmux-ide/core";
import type { TuiInputLayer, TuiInputMode, TuiMissionMode } from "./input-lifecycle.ts";
import type {
  WorkbenchDockMode,
  WorkbenchDockTabId,
  WorkbenchFocusZone,
} from "./workspace/workbench-shell.ts";

export interface TuiInteractionContext {
  dialogOpen: boolean;
  menuOpen: boolean;
  paletteOpen: boolean;
  searchOpen: boolean;
  surface: TuiInputMode;
  focusZone: WorkbenchFocusZone;
  dockMode: WorkbenchDockMode;
  activeDockTab: WorkbenchDockTabId;
  missionMode: TuiMissionMode;
  editorFocus: "list" | "editor";
  editorFilterOpen: boolean;
  diffFilterOpen: boolean;
  homePromptOpen: boolean;
  hosted: boolean;
}

export interface TuiInteractionPresentation {
  mode: string;
  focus: string;
  help: string;
}

/** Thin OpenTUI adapter over the renderer-neutral core interaction policy. */
export function tuiInteractionPresentation(
  context: TuiInteractionContext,
): TuiInteractionPresentation {
  const overlay = context.dialogOpen
    ? "dialog"
    : context.menuOpen
      ? "menu"
      : context.paletteOpen
        ? "commands"
        : context.searchOpen
          ? "search"
          : null;
  const surface =
    context.surface === "editor"
      ? "files"
      : context.surface === "diff"
        ? "changes"
        : context.surface === "mirror"
          ? "terminals"
          : context.surface;
  return workspaceInteractionPresentation({
    overlay,
    surface:
      context.focusZone === "dock-body" && context.activeDockTab === "activity"
        ? "activity"
        : surface,
    focusZone: context.focusZone,
    dockMode: context.dockMode,
    missionMode: context.missionMode,
    editorFocus: context.editorFocus,
    editorFilterOpen: context.editorFilterOpen,
    diffFilterOpen: context.diffFilterOpen,
    homePromptOpen: context.homePromptOpen,
    hosted: context.hosted,
  });
}

/** OpenTUI layer names deliberately mirror the core interaction vocabulary. */
export function tuiEscapeFocusTarget(input: {
  focusZone: WorkbenchFocusZone;
  layer: TuiInputLayer["kind"];
}): WorkbenchFocusZone | null {
  return workspaceEscapeFocusTarget({
    focusZone: input.focusZone,
    layer: input.layer as WorkspaceInteractionLayer,
  });
}
