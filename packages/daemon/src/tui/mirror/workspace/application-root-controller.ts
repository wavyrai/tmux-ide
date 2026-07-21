import {
  APPLICATION_SHELL_COMMAND_IDS,
  applicationShellCommandInvocation,
  type ApplicationShellCommandInvocation,
  type ApplicationShellProjectionV1,
  type CommandSource,
  type ProductSurfaceId,
  type SemanticFocusTarget,
} from "@tmux-ide/contracts";
import {
  executeCtrlCCommand,
  resolveCtrlCCommand,
  resolveQuitLifecycleCommand,
  type CtrlCExecutor,
  type TuiCleanupRegistry,
  type TuiLifecycleCommand,
} from "../input-lifecycle.ts";
import { resolveWorkbenchPasteTarget, type WorkbenchFocusedPanel } from "./workbench-controller.ts";
import type { WorkbenchFocusZone } from "./workbench-shell.ts";
import {
  applicationShellPaletteInvocation,
  applicationShellSurfaceInvocations,
  reduceOpenTuiApplicationShellCommands,
  type OpenTuiApplicationShellEffect,
} from "./application-shell-controller.ts";

export interface ApplicationRootPasteContext {
  focusZone: WorkbenchFocusZone;
  focusedPanel: WorkbenchFocusedPanel;
  filesEditorFocused: boolean;
  filesEditorWritable: boolean;
  terminalAvailable: boolean;
}

export interface ApplicationRootControllerDeps {
  projection: () => ApplicationShellProjectionV1;
  applyEffect: (effect: OpenTuiApplicationShellEffect) => void;
  capturePaletteFocusReturn: (target: SemanticFocusTarget | null) => void;
  pasteTerminal: (text: string) => void;
  pasteFilesEditor: (text: string) => void;
  ctrlC: CtrlCExecutor;
  runLifecycle: (command: TuiLifecycleCommand) => void;
  cleanupRegistry: TuiCleanupRegistry;
}

/** Production root seam shared by keyboard, pointer, palette, paste and cleanup. */
export function createApplicationRootController(deps: ApplicationRootControllerDeps) {
  const execute = (invocations: readonly ApplicationShellCommandInvocation[]) => {
    const reduced = reduceOpenTuiApplicationShellCommands(deps.projection(), invocations);
    for (const effect of reduced.effects) deps.applyEffect(effect);
    return reduced.next;
  };

  return {
    execute,
    openSurface(surface: ProductSurfaceId, source: CommandSource) {
      return execute(applicationShellSurfaceInvocations(deps.projection(), surface, source));
    },
    openPalette(source: CommandSource) {
      const invocation = applicationShellPaletteInvocation(deps.projection(), true, source);
      if (invocation.id !== APPLICATION_SHELL_COMMAND_IDS.openPalette) {
        throw new Error("palette open resolved to the wrong semantic command");
      }
      deps.capturePaletteFocusReturn(invocation.args.focusReturnTarget);
      return execute([invocation]);
    },
    closePalette(source: CommandSource) {
      const next = execute([applicationShellPaletteInvocation(deps.projection(), false, source)]);
      deps.capturePaletteFocusReturn(null);
      return next;
    },
    setDockMode(mode: "collapsed" | "open" | "maximized", source: CommandSource) {
      return execute([
        applicationShellCommandInvocation(
          APPLICATION_SHELL_COMMAND_IDS.setDockMode,
          { mode },
          source,
        ),
      ]);
    },
    moveFocus(target: SemanticFocusTarget, source: CommandSource) {
      return execute([
        applicationShellCommandInvocation(
          APPLICATION_SHELL_COMMAND_IDS.moveFocus,
          { target },
          source,
        ),
      ]);
    },
    paste(text: string, context: ApplicationRootPasteContext) {
      const target = resolveWorkbenchPasteTarget(context);
      if (target === "terminal") deps.pasteTerminal(text);
      else if (target === "files-editor") deps.pasteFilesEditor(text);
      return target;
    },
    handleCtrlC(context: Parameters<typeof resolveCtrlCCommand>[0]) {
      const command = resolveCtrlCCommand(context);
      executeCtrlCCommand(command, deps.ctrlC);
      return command;
    },
    quit(options: { hosted: boolean }, source: "keyboard" | "palette" | "error") {
      const command = resolveQuitLifecycleCommand(options, source);
      deps.runLifecycle(command);
      return command;
    },
    runLifecycle(command: TuiLifecycleCommand) {
      deps.runLifecycle(command);
    },
    dispose() {
      return deps.cleanupRegistry.runAll();
    },
  };
}

export function isApplicationSidebarResizeBoundary(input: {
  x: number;
  y: number;
  sidebarWidth: number;
  tabbarHeight: number;
}): boolean {
  return (
    input.y >= input.tabbarHeight &&
    (input.x === input.sidebarWidth - 1 || input.x === input.sidebarWidth)
  );
}

export type ApplicationSidebarResizePointerPhase = "start" | "update" | "end" | "consume" | null;

export interface ApplicationSidebarResizePointerEffects {
  start: () => void;
  resize: (x: number) => void;
  end: () => void;
}

/** Pointer priority for the sidebar gesture; a live gesture owns every event. */
export function applicationSidebarResizePointerPhase(input: {
  type: string;
  active: boolean;
  x: number;
  y: number;
  button?: number;
  sidebarWidth: number;
  tabbarHeight: number;
}): ApplicationSidebarResizePointerPhase {
  if (input.active) {
    if (input.type === "drag") return "update";
    if (
      input.type === "up" ||
      input.type === "drag-end" ||
      input.type === "drop" ||
      input.type === "out"
    )
      return "end";
    return "consume";
  }
  return input.type === "down" && input.button !== 2 && isApplicationSidebarResizeBoundary(input)
    ? "start"
    : null;
}

/** Exact production effect boundary used at both root priority checkpoints. */
export function routeApplicationSidebarResizePointer(
  input: Parameters<typeof applicationSidebarResizePointerPhase>[0],
  effects: ApplicationSidebarResizePointerEffects,
): boolean {
  const phase = applicationSidebarResizePointerPhase(input);
  if (!phase) return false;
  if (phase === "start") effects.start();
  if (phase === "update" || phase === "end") effects.resize(input.x);
  if (phase === "end") effects.end();
  return true;
}
