export type WorkspaceInteractionSurface =
  | "home"
  | "terminals"
  | "files"
  | "changes"
  | "missions"
  | "activity";
export type WorkspaceFocusZone = "canvas" | "dock-tabs" | "dock-body";
export type WorkspaceDockMode = "collapsed" | "open" | "maximized";
export type WorkspaceMissionMode = "board" | "history" | "detail";
export type WorkspaceInteractionLayer =
  | "dialog"
  | "menu"
  | "palette"
  | "search"
  | "editor-filter"
  | "editor-list"
  | "editor-input"
  | "diff-filter"
  | "diff"
  | "home-prompt"
  | "home"
  | "missions-detail"
  | "missions-board-history"
  | "activity"
  | "terminal"
  | "inert";

export interface WorkspaceInteractionContext {
  overlay: "dialog" | "menu" | "commands" | "search" | null;
  surface: WorkspaceInteractionSurface;
  focusZone: WorkspaceFocusZone;
  dockMode: WorkspaceDockMode;
  missionMode: WorkspaceMissionMode;
  editorFocus: "list" | "editor";
  editorFilterOpen: boolean;
  diffFilterOpen: boolean;
  homePromptOpen: boolean;
  hosted: boolean;
}

export interface WorkspaceInteractionPresentation {
  mode: string;
  focus: string;
  help: string;
}

/** Renderer-neutral interaction copy shared by TUI and GUI shells. */
export function workspaceInteractionPresentation(
  context: WorkspaceInteractionContext,
): WorkspaceInteractionPresentation {
  const quit = context.hosted ? "^q detach" : "^q quit";
  if (context.overlay === "dialog") {
    return { mode: "DIALOG", focus: "dialog", help: "↑↓ move · ↵ choose · esc back" };
  }
  if (context.overlay === "menu") {
    return { mode: "MENU", focus: "menu", help: "↑↓ move · → open · esc back" };
  }
  if (context.overlay === "commands") {
    return { mode: "COMMANDS", focus: "command palette", help: "type filter · ↵ run · esc back" };
  }
  if (context.overlay === "search") {
    return { mode: "SEARCH", focus: "terminal search", help: "↵ find · esc back" };
  }
  if (context.focusZone === "dock-tabs") {
    return {
      mode: "TOOL TABS",
      focus: "tool tabs",
      help: "←→ choose · ↓ open · esc workspace · F8 next",
    };
  }
  if (context.surface === "files") {
    if (context.editorFilterOpen) {
      return { mode: "FILTER", focus: "file filter", help: "type filter · ↑↓ move · esc back" };
    }
    if (context.editorFocus === "editor") {
      return { mode: "EDITOR", focus: "file editor", help: "^s save · esc file list · F8 next" };
    }
    return {
      mode: "FILES",
      focus: "file list",
      help: "↑↓ move · ↵ open · / filter · esc tool tabs",
    };
  }
  if (context.surface === "changes") {
    if (context.diffFilterOpen) {
      return { mode: "FILTER", focus: "change filter", help: "type filter · ↑↓ move · esc back" };
    }
    return {
      mode: "CHANGES",
      focus: "changes",
      help: "↑↓ move · s stage · u unstage · esc tool tabs",
    };
  }
  if (context.surface === "missions") {
    if (context.missionMode === "detail") {
      return { mode: "MISSION", focus: "mission detail", help: "↑↓ scroll · esc mission list" };
    }
    return {
      mode: context.missionMode === "history" ? "MISSION HISTORY" : "MISSIONS",
      focus: "mission list",
      help: "↑↓ move · ↵ open · esc tool tabs",
    };
  }
  if (context.surface === "activity" && context.focusZone === "dock-body") {
    return { mode: "ACTIVITY", focus: "activity", help: "↑↓ move · esc tool tabs · F8 next" };
  }
  if (context.surface === "home") {
    if (context.homePromptOpen) {
      return { mode: "OPEN", focus: "path prompt", help: "type path · ↵ open · esc back" };
    }
    return {
      mode: "HOME",
      focus: "workspace list",
      help: `↑↓ move · ↵ open · F5 commands · ${quit}`,
    };
  }
  return {
    mode: "TERMINAL INPUT",
    focus: "terminal",
    help: `F8 focus tools · F5 commands · ${quit}`,
  };
}

const DEEP_ESCAPE_LAYERS = new Set<WorkspaceInteractionLayer>([
  "dialog",
  "menu",
  "palette",
  "search",
  "editor-filter",
  "editor-input",
  "diff-filter",
  "home-prompt",
  "missions-detail",
]);

/** Close local state first, then walk dock body → dock tabs → workspace. */
export function workspaceEscapeFocusTarget(input: {
  focusZone: WorkspaceFocusZone;
  layer: WorkspaceInteractionLayer;
}): WorkspaceFocusZone | null {
  if (DEEP_ESCAPE_LAYERS.has(input.layer)) return null;
  if (input.focusZone === "dock-body") return "dock-tabs";
  if (input.focusZone === "dock-tabs") return "canvas";
  return null;
}

/** Deterministic forward/reverse focus ring shared by every renderer. */
export function cycleWorkspaceFocusZone(
  current: WorkspaceFocusZone,
  dockMode: WorkspaceDockMode,
  direction: "next" | "previous" = "next",
): WorkspaceFocusZone {
  const order: readonly WorkspaceFocusZone[] =
    dockMode === "collapsed" ? ["canvas", "dock-tabs"] : ["canvas", "dock-tabs", "dock-body"];
  const currentIndex = Math.max(0, order.indexOf(current));
  const delta = direction === "next" ? 1 : -1;
  return order[(currentIndex + delta + order.length) % order.length]!;
}
