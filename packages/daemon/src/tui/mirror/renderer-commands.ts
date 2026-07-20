import {
  COMMAND_PROTOCOL_VERSION,
  WORKSPACE_WINDOW_MODE_COMMAND_IDS,
  type CommandArguments,
  type CommandDescriptor,
  type CommandInvocation,
  type CommandResolutionError,
  type CommandSource,
} from "@tmux-ide/contracts";
import { z } from "zod";
import { CommandRegistry, type CommandDefinition } from "../../lib/command-registry.ts";
import type { TuiGlobalCommand, TuiLifecycleCommand } from "./input-lifecycle.ts";
import type { WorkbenchCanvasPanel } from "./workspace/workbench-controller.ts";
import type { WorkbenchDockTabId } from "./workspace/workbench-shell.ts";

export const RENDERER_COMMAND_IDS = {
  openPalette: "app.palette.open",
  quit: "app.quit",
  cycleCompositeFocus: "workspace.composite.focusCycle",
  activateShortcut: "workspace.shortcut.activate",
  activateView: "workspace.view.activate",
  activateCanvas: "workspace.canvas.activate",
  activateDock: "workspace.dock.activate",
  openHome: "workspace.home.open",
  toggleEditor: "workspace.editor.toggle",
} as const;

export type RendererCommandId = (typeof RENDERER_COMMAND_IDS)[keyof typeof RENDERER_COMMAND_IDS];

/** Raw terminal channels are transport/data paths, never semantic commands. */
export const RENDERER_COMMAND_BYPASS_CHANNELS = [
  "ctrl-c",
  "paste",
  "pty-output",
  "resize",
] as const;

export interface RendererCommandContext {
  compositeFocusAvailable: boolean;
  editorAvailable: boolean;
}

export interface RendererCommandEffects {
  openPalette: () => void;
  runLifecycle: (command: TuiLifecycleCommand) => void;
  cycleCompositeFocus: () => void;
  activateShortcut: (key: string) => void;
  activateView: (viewId: string) => void;
  activateCanvas: (panel: WorkbenchCanvasPanel) => void;
  activateDock: (tab: WorkbenchDockTabId) => void;
  openHome: () => void;
  toggleEditor: () => void;
}

export type RendererCommandExecution =
  | { ok: true; commandId: RendererCommandId }
  | { ok: false; error: CommandResolutionError };

const EmptyInputSchemaZ = z.object({}).strict();
const LifecycleInputSchemaZ = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("destroy-renderer"),
      source: z.enum(["keyboard", "palette", "error"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("hosted-detach"),
      source: z.literal("keyboard"),
    })
    .strict(),
]);
const ShortcutInputSchemaZ = z.object({ key: z.string().min(1).max(32) }).strict();
const ViewInputSchemaZ = z.object({ viewId: z.string().min(1).max(160) }).strict();
const CanvasInputSchemaZ = z.object({ panel: z.enum(["home", "terminals"]) }).strict();
const DockInputSchemaZ = z
  .object({ tab: z.enum(["files", "changes", "missions", "activity"]) })
  .strict();

interface RendererCommandMetadata {
  id: RendererCommandId;
  label: string;
  category: string;
  inputSchema: z.ZodType;
  availability?: CommandDefinition<RendererCommandContext>["availability"];
}

const metadata: readonly RendererCommandMetadata[] = [
  {
    id: RENDERER_COMMAND_IDS.openPalette,
    label: "Open command palette",
    category: "application",
    inputSchema: EmptyInputSchemaZ,
  },
  {
    id: RENDERER_COMMAND_IDS.quit,
    label: "Quit or detach",
    category: "application",
    inputSchema: LifecycleInputSchemaZ,
  },
  {
    id: RENDERER_COMMAND_IDS.cycleCompositeFocus,
    label: "Cycle composite focus",
    category: "workspace",
    inputSchema: EmptyInputSchemaZ,
    availability: (context) =>
      context.compositeFocusAvailable
        ? { available: true }
        : { available: false, reason: "composite focus is unavailable" },
  },
  {
    id: RENDERER_COMMAND_IDS.activateShortcut,
    label: "Activate workspace shortcut",
    category: "workspace",
    inputSchema: ShortcutInputSchemaZ,
  },
  {
    id: RENDERER_COMMAND_IDS.activateView,
    label: "Activate workspace view",
    category: "workspace",
    inputSchema: ViewInputSchemaZ,
  },
  {
    id: RENDERER_COMMAND_IDS.activateCanvas,
    label: "Activate canvas panel",
    category: "workspace",
    inputSchema: CanvasInputSchemaZ,
  },
  {
    id: RENDERER_COMMAND_IDS.activateDock,
    label: "Activate dock panel",
    category: "workspace",
    inputSchema: DockInputSchemaZ,
  },
  {
    id: RENDERER_COMMAND_IDS.openHome,
    label: "Open Home",
    category: "workspace",
    inputSchema: EmptyInputSchemaZ,
  },
  {
    id: RENDERER_COMMAND_IDS.toggleEditor,
    label: "Toggle editor",
    category: "workspace",
    inputSchema: EmptyInputSchemaZ,
    availability: (context) =>
      context.editorAvailable
        ? { available: true }
        : { available: false, reason: "no file is open" },
  },
];

function descriptor(item: RendererCommandMetadata): CommandDescriptor {
  return Object.freeze({
    version: COMMAND_PROTOCOL_VERSION,
    id: item.id,
    owner: "renderer",
    label: item.label,
    category: item.category,
    schemas: Object.freeze({ input: `${item.id}.input.v1` }),
    dangerous: false,
    confirmation: "none",
  });
}

export const RENDERER_COMMAND_DEFINITIONS: readonly CommandDefinition<RendererCommandContext>[] =
  Object.freeze(
    metadata.map((item) =>
      Object.freeze({
        descriptor: descriptor(item),
        inputSchema: item.inputSchema,
        ...(item.availability ? { availability: item.availability } : {}),
      }),
    ),
  );

export function createRendererCommandRegistry(): CommandRegistry<RendererCommandContext> {
  return new CommandRegistry(RENDERER_COMMAND_DEFINITIONS);
}

const canonicalRendererCommandRegistry = createRendererCommandRegistry();

const rendererCommandIds = new Set<string>(Object.values(RENDERER_COMMAND_IDS));

function isRendererCommandId(id: string): id is RendererCommandId {
  return rendererCommandIds.has(id);
}

export function rendererCommandInvocation(
  id: RendererCommandId,
  args: CommandArguments,
  source: CommandSource,
): CommandInvocation {
  return {
    version: COMMAND_PROTOCOL_VERSION,
    id,
    source,
    args,
  };
}

export function rendererInvocationForLifecycle(command: TuiLifecycleCommand): CommandInvocation {
  return rendererCommandInvocation(
    RENDERER_COMMAND_IDS.quit,
    { kind: command.kind, source: command.source },
    {
      kind:
        command.source === "keyboard"
          ? "keyboard"
          : command.source === "palette"
            ? "palette"
            : "program",
      surface: "application",
    },
  );
}

export function rendererInvocationForGlobal(command: TuiGlobalCommand): CommandInvocation {
  const source: CommandSource = { kind: "keyboard", surface: "workbench" };
  switch (command.kind) {
    case "cycle-composite-focus":
      return rendererCommandInvocation(RENDERER_COMMAND_IDS.cycleCompositeFocus, {}, source);
    case "open-palette":
      return rendererCommandInvocation(RENDERER_COMMAND_IDS.openPalette, {}, source);
    case "select-hosted-view":
      return rendererCommandInvocation(
        RENDERER_COMMAND_IDS.activateShortcut,
        { key: command.key },
        source,
      );
    case "go-home":
      return rendererCommandInvocation(RENDERER_COMMAND_IDS.openHome, {}, source);
    case "toggle-editor":
      return rendererCommandInvocation(RENDERER_COMMAND_IDS.toggleEditor, {}, source);
  }
}

export function rendererInvocationForCanvas(
  panel: WorkbenchCanvasPanel,
  source: CommandSource,
): CommandInvocation {
  return rendererCommandInvocation(RENDERER_COMMAND_IDS.activateCanvas, { panel }, source);
}

export function rendererInvocationForDock(
  tab: WorkbenchDockTabId,
  source: CommandSource,
): CommandInvocation {
  return rendererCommandInvocation(RENDERER_COMMAND_IDS.activateDock, { tab }, source);
}

export function rendererInvocationForView(
  viewId: string,
  source: CommandSource,
): CommandInvocation {
  return rendererCommandInvocation(RENDERER_COMMAND_IDS.activateView, { viewId }, source);
}

export function createRendererCommandExecutor(input: {
  context: () => RendererCommandContext;
  effects: RendererCommandEffects;
  onRejected?: (error: CommandResolutionError) => void;
}): { execute(invocation: CommandInvocation): RendererCommandExecution } {
  // Keep execution closed over the canonical catalog. Tests can inject state,
  // effects, and rejection observation, but never alternate IDs or schemas.
  return {
    execute(invocation) {
      const resolved = canonicalRendererCommandRegistry.resolve(invocation, input.context());
      if (!resolved.ok) {
        input.onRejected?.(resolved.error);
        return resolved;
      }
      if (resolved.command.descriptor.owner !== "renderer") {
        const error: CommandResolutionError = {
          code: "unavailable",
          commandId: resolved.command.descriptor.id,
          message: `Command is owned by ${resolved.command.descriptor.owner}`,
        };
        input.onRejected?.(error);
        return { ok: false, error };
      }
      const commandId = resolved.command.descriptor.id;
      if (!isRendererCommandId(commandId)) {
        const error: CommandResolutionError = {
          code: "unknown-command",
          commandId,
          message: `Unknown renderer command: ${commandId}`,
        };
        input.onRejected?.(error);
        return { ok: false, error };
      }
      switch (commandId) {
        case RENDERER_COMMAND_IDS.openPalette:
          input.effects.openPalette();
          break;
        case RENDERER_COMMAND_IDS.quit:
          input.effects.runLifecycle(LifecycleInputSchemaZ.parse(resolved.command.input));
          break;
        case RENDERER_COMMAND_IDS.cycleCompositeFocus:
          input.effects.cycleCompositeFocus();
          break;
        case RENDERER_COMMAND_IDS.activateShortcut:
          input.effects.activateShortcut(ShortcutInputSchemaZ.parse(resolved.command.input).key);
          break;
        case RENDERER_COMMAND_IDS.activateView:
          input.effects.activateView(ViewInputSchemaZ.parse(resolved.command.input).viewId);
          break;
        case RENDERER_COMMAND_IDS.activateCanvas:
          input.effects.activateCanvas(CanvasInputSchemaZ.parse(resolved.command.input).panel);
          break;
        case RENDERER_COMMAND_IDS.activateDock:
          input.effects.activateDock(DockInputSchemaZ.parse(resolved.command.input).tab);
          break;
        case RENDERER_COMMAND_IDS.openHome:
          input.effects.openHome();
          break;
        case RENDERER_COMMAND_IDS.toggleEditor:
          input.effects.toggleEditor();
          break;
      }
      return { ok: true, commandId };
    },
  };
}

/** Drift guard: Card07 only reserves these names; Card12 owns their behavior. */
export function rendererRegistersReservedWindowModeCommand(): boolean {
  const registered = new Set(RENDERER_COMMAND_DEFINITIONS.map((item) => item.descriptor.id));
  return WORKSPACE_WINDOW_MODE_COMMAND_IDS.some((id) => registered.has(id));
}
