export const OPENTUI_KEYMAP_DECISION = {
  package: "@opentui/keymap",
  evaluatedVersion: "0.4.3",
  adopted: false,
  reason:
    "The app already has one Solid useKeyboard owner and must forward arbitrary editor/query/pane text; adding keymap here would duplicate rather than replace that root listener.",
} as const;

export type TuiInputMode = "home" | "editor" | "diff" | "missions" | "mirror";
export type TuiMissionMode = "board" | "history" | "detail";
export type TuiEditorFocus = "list" | "editor";

export interface TuiKeyEvent {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  super?: boolean;
}

export interface TuiInputContext {
  dialogOpen: boolean;
  menuOpen: boolean;
  paletteOpen: boolean;
  searchOpen: boolean;
  mode: TuiInputMode;
  activePanelInert: boolean;
  missionMode: TuiMissionMode;
  editorFocus: TuiEditorFocus;
  editorFilterOpen: boolean;
  diffFilterOpen: boolean;
  homePromptOpen: boolean;
  configuredShortcutKeys: readonly string[];
  compositeCycleAvailable: boolean;
}

export type TuiGlobalCommand =
  | { kind: "cycle-composite-focus" }
  | { kind: "open-palette" }
  | { kind: "select-hosted-view"; key: string }
  | { kind: "go-home" }
  | { kind: "toggle-editor" };

export type TuiInputLayer =
  | { kind: "lifecycle"; command: TuiLifecycleCommand }
  | { kind: "kitty-super-palette" }
  | { kind: "kitty-super-suppressed" }
  | { kind: "dialog" }
  | { kind: "menu" }
  | { kind: "palette" }
  | { kind: "search" }
  | { kind: "global"; command: TuiGlobalCommand }
  | { kind: "missions-detail" }
  | { kind: "missions-board-history" }
  | { kind: "inert" }
  | { kind: "editor-filter" }
  | { kind: "editor-list" }
  | { kind: "editor-input" }
  | { kind: "diff-filter" }
  | { kind: "diff" }
  | { kind: "home-prompt" }
  | { kind: "home" }
  | { kind: "terminal" };

export type TuiLifecycleCommand =
  | { kind: "destroy-renderer"; source: "keyboard" | "palette" | "error" }
  | { kind: "hosted-detach"; source: "keyboard" };

export function resolveInputLayer(
  context: TuiInputContext,
  event: TuiKeyEvent,
  options: { hosted: boolean },
): TuiInputLayer {
  if (event.ctrl && event.name === "q") {
    return { kind: "lifecycle", command: resolveQuitLifecycleCommand(options, "keyboard") };
  }
  if (event.super) {
    if (
      event.name === "k" &&
      !event.ctrl &&
      !context.dialogOpen &&
      !context.menuOpen &&
      !context.paletteOpen &&
      !context.searchOpen
    ) {
      return { kind: "kitty-super-palette" };
    }
    return { kind: "kitty-super-suppressed" };
  }
  if (context.dialogOpen) return { kind: "dialog" };
  if (context.menuOpen) return { kind: "menu" };
  if (context.paletteOpen) return { kind: "palette" };
  if (context.searchOpen) return { kind: "search" };
  const global = resolveGlobalCommand(context, event);
  if (global) return { kind: "global", command: global };
  if (context.mode === "missions") {
    return context.missionMode === "detail"
      ? { kind: "missions-detail" }
      : { kind: "missions-board-history" };
  }
  if (context.activePanelInert) return { kind: "inert" };
  if (event.ctrl && event.name === "e")
    return { kind: "global", command: { kind: "toggle-editor" } };
  if (context.mode === "editor") {
    if (context.editorFocus === "list") {
      return context.editorFilterOpen ? { kind: "editor-filter" } : { kind: "editor-list" };
    }
    return { kind: "editor-input" };
  }
  if (context.mode === "diff") {
    return context.diffFilterOpen ? { kind: "diff-filter" } : { kind: "diff" };
  }
  if (context.mode === "home") {
    return context.homePromptOpen ? { kind: "home-prompt" } : { kind: "home" };
  }
  return { kind: "terminal" };
}

export function resolveGlobalCommand(
  context: TuiInputContext,
  event: TuiKeyEvent,
): TuiGlobalCommand | null {
  if (event.ctrl && event.name === "tab" && context.compositeCycleAvailable) {
    return { kind: "cycle-composite-focus" };
  }
  if (event.name === "f5" || (event.ctrl && event.name === "p")) {
    return { kind: "open-palette" };
  }
  if (
    !event.ctrl &&
    !event.meta &&
    !event.shift &&
    context.configuredShortcutKeys.includes(event.name)
  ) {
    return { kind: "select-hosted-view", key: event.name };
  }
  if (event.ctrl && (event.name === "g" || event.name === "h")) {
    return { kind: "go-home" };
  }
  return null;
}

export function resolveQuitLifecycleCommand(
  options: { hosted: boolean },
  source: "keyboard" | "palette" | "error",
): TuiLifecycleCommand {
  if (source === "keyboard" && options.hosted) return { kind: "hosted-detach", source };
  return { kind: "destroy-renderer", source };
}

export type CtrlCCommand =
  | { kind: "copy-editor-selection" }
  | { kind: "copy-terminal-selection" }
  | { kind: "forward-terminal-ctrl-c" }
  | { kind: "consume" };

export function resolveCtrlCCommand(context: {
  layer: "editor" | "terminal" | "inert" | "overlay";
  hasEditorSelection?: boolean;
  hasTerminalSelection?: boolean;
  mirrorAvailable?: boolean;
}): CtrlCCommand {
  if (context.layer === "editor") {
    return context.hasEditorSelection ? { kind: "copy-editor-selection" } : { kind: "consume" };
  }
  if (context.layer === "terminal") {
    if (!context.mirrorAvailable) return { kind: "consume" };
    return context.hasTerminalSelection
      ? { kind: "copy-terminal-selection" }
      : { kind: "forward-terminal-ctrl-c" };
  }
  return { kind: "consume" };
}

export interface CtrlCExecutor {
  copyEditorSelection: () => void;
  copyTerminalSelection: () => void;
  forwardTerminalCtrlC: () => void;
}

export function executeCtrlCCommand(command: CtrlCCommand, executor: CtrlCExecutor): void {
  if (command.kind === "copy-editor-selection") executor.copyEditorSelection();
  else if (command.kind === "copy-terminal-selection") executor.copyTerminalSelection();
  else if (command.kind === "forward-terminal-ctrl-c") executor.forwardTerminalCtrlC();
}

export interface TuiCleanupResult {
  names: string[];
  failures: { name: string; error: unknown }[];
}

export class TuiCleanupRegistry {
  private callbacks = new Map<string, () => void>();
  private cleaned = false;

  set(name: string, callback: () => void): void {
    if (this.cleaned) return;
    this.callbacks.set(name, callback);
  }

  runAll(): TuiCleanupResult {
    if (this.cleaned) return { names: [], failures: [] };
    this.cleaned = true;
    const names = [...this.callbacks.keys()];
    const failures: TuiCleanupResult["failures"] = [];
    for (const [name, callback] of this.callbacks) {
      try {
        callback();
      } catch (error) {
        failures.push({ name, error });
      }
    }
    this.callbacks.clear();
    return { names, failures };
  }
}

export interface TuiLifecycleExecutor {
  run(command: TuiLifecycleCommand): void;
}

export function createTuiLifecycleExecutor(deps: {
  destroyRenderer: () => void;
  switchClientBack: (callback: (error: unknown) => void) => void;
  detachClient: () => void;
}): TuiLifecycleExecutor {
  let destroyRequested = false;
  let hostedDetachRequested = false;
  let fallbackDetachRequested = false;

  return {
    run(command) {
      if (command.kind === "destroy-renderer") {
        if (destroyRequested) return;
        destroyRequested = true;
        deps.destroyRenderer();
        return;
      }
      if (hostedDetachRequested) return;
      hostedDetachRequested = true;
      deps.switchClientBack((error) => {
        if (!error || fallbackDetachRequested) return;
        fallbackDetachRequested = true;
        deps.detachClient();
      });
    },
  };
}
