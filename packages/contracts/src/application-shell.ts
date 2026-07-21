import { z } from "zod";
import type { CohesionFixtureV1 } from "./cohesion-fixture.ts";
import {
  APPLICATION_SHELL_COMMAND_IDS,
  COMMAND_PROTOCOL_VERSION,
  ApplicationShellCommandIdSchemaZ,
  CommandArgumentsSchemaZ,
  CommandDescriptorSchemaZ,
  CommandInvocationSchemaZ,
  type ApplicationShellCommandId,
  type CommandDescriptor,
  type CommandInvocation,
  type CommandSource,
} from "./commands.ts";
import {
  CANONICAL_SURFACE_REGISTRY,
  commandsToOpenSurface,
  type DockToolId,
  type PrimaryWorkspaceModeId,
  type ProductSurfaceDefinition,
  type ProductSurfaceId,
  type SurfaceCommandTemplate,
} from "./experience-shell.ts";
import type { SemanticIconId } from "./experience-identifiers.ts";
import type {
  FocusOverlayStateV1,
  FocusZone,
  SemanticFocusTarget,
  SemanticOverlay,
} from "./focus-overlay.ts";

export const APPLICATION_SHELL_PROJECTION_VERSION = 1 as const;
export const APPLICATION_SHELL_TRACE_VERSION = 1 as const;

export const ApplicationShellDockModeSchemaZ = z.enum(["collapsed", "open", "maximized"]);
export type ApplicationShellDockMode = z.infer<typeof ApplicationShellDockModeSchemaZ>;

export type ApplicationShellProjectionInputV1 = Pick<
  CohesionFixtureV1,
  "project" | "workspace" | "dock" | "focus" | "connection"
>;

type SidebarSession = CohesionFixtureV1["workspace"]["sidebar"]["sessions"][number];
type SidebarAgent = CohesionFixtureV1["workspace"]["sidebar"]["agents"][number];
type Readiness = CohesionFixtureV1["project"]["readiness"];
type Connection = CohesionFixtureV1["connection"];

export interface ApplicationShellSurfaceProjection {
  readonly id: ProductSurfaceId;
  readonly icon: SemanticIconId;
  readonly label: string;
  readonly kind: ProductSurfaceDefinition["kind"];
  readonly area: ProductSurfaceDefinition["area"];
  readonly order: number;
  readonly owningMode: PrimaryWorkspaceModeId;
  readonly shortcut: string;
  readonly activation: SurfaceCommandTemplate;
  readonly active: boolean;
  readonly attention: boolean;
  readonly disabledReason: string | null;
}

export interface ApplicationShellProjectionV1 {
  readonly version: typeof APPLICATION_SHELL_PROJECTION_VERSION;
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly rootLabel: string;
    readonly readiness: Readiness;
  };
  readonly workspace: { readonly id: string; readonly name: string };
  readonly sidebar: {
    readonly activeSessionId: string;
    readonly sessions: readonly SidebarSession[];
    readonly agents: readonly SidebarAgent[];
  };
  readonly primaryNavigation: {
    readonly activeMode: PrimaryWorkspaceModeId;
    readonly items: readonly ApplicationShellSurfaceProjection[];
  };
  readonly workspaceCanvas: { readonly activeMode: PrimaryWorkspaceModeId };
  readonly bottomDock: {
    readonly mode: ApplicationShellDockMode;
    readonly activeTool: DockToolId;
    readonly tools: readonly ApplicationShellSurfaceProjection[];
  };
  readonly statusStrip: Connection;
  readonly focus: {
    readonly windowActivity: FocusOverlayStateV1["windowActivity"];
    readonly zone: FocusZone;
    readonly appFocusedPaneId: string | null;
    readonly terminalInputPaneId: string | null;
    readonly layoutSelectedPaneId: string | null;
    readonly overlays: readonly SemanticOverlay[];
    readonly palette: {
      readonly open: boolean;
      readonly overlayId: string | null;
      readonly focusReturnTarget: SemanticFocusTarget | null;
    };
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneFocusTarget(target: SemanticFocusTarget): SemanticFocusTarget {
  return { ...target };
}

function cloneOverlay(overlay: SemanticOverlay): SemanticOverlay {
  return { ...overlay, focusReturnTarget: cloneFocusTarget(overlay.focusReturnTarget) };
}

function paletteOverlay(focus: FocusOverlayStateV1): SemanticOverlay | null {
  for (let index = focus.overlays.length - 1; index >= 0; index -= 1) {
    const overlay = focus.overlays[index]!;
    if (overlay.kind === "command-palette") return overlay;
  }
  return null;
}

function projectedSurface(
  definition: ProductSurfaceDefinition,
  input: ApplicationShellProjectionInputV1,
): ApplicationShellSurfaceProjection {
  const dockState =
    definition.kind === "dock-tool"
      ? input.dock.tools.find((tool) => tool.id === definition.id)
      : undefined;
  return {
    ...definition,
    activation: { ...definition.activation, args: { ...definition.activation.args } },
    active:
      definition.kind === "primary-mode"
        ? definition.id === input.workspace.activeMode
        : definition.id === input.dock.activeTool,
    attention: dockState !== undefined && dockState.unreadCount > 0,
    disabledReason: dockState?.disabledReason ?? null,
  };
}

/**
 * Renderer-neutral product shell. Hosts add layout and event plumbing around
 * this projection; they never create another product surface registry.
 */
export function projectApplicationShellV1(
  input: ApplicationShellProjectionInputV1,
): ApplicationShellProjectionV1 {
  const surfaces = CANONICAL_SURFACE_REGISTRY.map((surface) => projectedSurface(surface, input));
  const palette = paletteOverlay(input.focus);
  return deepFreeze({
    version: APPLICATION_SHELL_PROJECTION_VERSION,
    project: {
      id: input.project.id,
      name: input.project.name,
      rootLabel: input.project.rootLabel,
      readiness: {
        ...input.project.readiness,
        facts: [...input.project.readiness.facts],
        warnings: [...input.project.readiness.warnings],
      },
    },
    workspace: { id: input.workspace.id, name: input.workspace.name },
    sidebar: {
      activeSessionId: input.workspace.session.id,
      sessions: input.workspace.sidebar.sessions.map((session) => ({ ...session })),
      agents: input.workspace.sidebar.agents.map((agent) => ({ ...agent })),
    },
    primaryNavigation: {
      activeMode: input.workspace.activeMode,
      items: surfaces.filter((surface) => surface.kind === "primary-mode"),
    },
    workspaceCanvas: { activeMode: input.workspace.activeMode },
    bottomDock: {
      mode: ApplicationShellDockModeSchemaZ.parse(input.dock.mode),
      activeTool: input.dock.activeTool,
      tools: surfaces.filter((surface) => surface.kind === "dock-tool"),
    },
    statusStrip: { ...input.connection },
    focus: {
      windowActivity: input.focus.windowActivity,
      zone: input.focus.focusZone,
      appFocusedPaneId: input.focus.appFocusedPaneId,
      terminalInputPaneId: input.focus.terminalInputPaneId,
      layoutSelectedPaneId: input.focus.layoutSelectedPaneId,
      overlays: input.focus.overlays.map(cloneOverlay),
      palette: {
        open: palette !== null,
        overlayId: palette?.id ?? null,
        focusReturnTarget: palette ? cloneFocusTarget(palette.focusReturnTarget) : null,
      },
    },
  });
}

interface ApplicationShellCommandArgumentsById {
  [APPLICATION_SHELL_COMMAND_IDS.activateMode]: { readonly mode: PrimaryWorkspaceModeId };
  [APPLICATION_SHELL_COMMAND_IDS.activateDockTool]: { readonly tool: DockToolId };
  [APPLICATION_SHELL_COMMAND_IDS.setDockMode]: { readonly mode: ApplicationShellDockMode };
  [APPLICATION_SHELL_COMMAND_IDS.moveFocus]: { readonly target: SemanticFocusTarget };
  [APPLICATION_SHELL_COMMAND_IDS.openPalette]: {
    readonly overlayId: string;
    readonly focusReturnTarget: SemanticFocusTarget;
  };
  [APPLICATION_SHELL_COMMAND_IDS.closePalette]: { readonly overlayId: string };
  [APPLICATION_SHELL_COMMAND_IDS.selectResource]: {
    readonly surface: ProductSurfaceId;
    readonly resourceId: string;
  };
}

const descriptor = (
  id: ApplicationShellCommandId,
  label: string,
  category: "application" | "workspace",
): CommandDescriptor =>
  deepFreeze(
    CommandDescriptorSchemaZ.parse({
      version: COMMAND_PROTOCOL_VERSION,
      id,
      owner: "renderer",
      label,
      category,
      schemas: { input: `${id}.input.v1` },
      dangerous: false,
      confirmation: "none",
    }),
  );

export const APPLICATION_SHELL_COMMAND_DESCRIPTORS: readonly CommandDescriptor[] = deepFreeze([
  descriptor(APPLICATION_SHELL_COMMAND_IDS.activateMode, "Activate workspace mode", "workspace"),
  descriptor(APPLICATION_SHELL_COMMAND_IDS.activateDockTool, "Activate dock tool", "workspace"),
  descriptor(APPLICATION_SHELL_COMMAND_IDS.setDockMode, "Set dock mode", "workspace"),
  descriptor(APPLICATION_SHELL_COMMAND_IDS.moveFocus, "Move workspace focus", "workspace"),
  descriptor(APPLICATION_SHELL_COMMAND_IDS.openPalette, "Open command palette", "application"),
  descriptor(APPLICATION_SHELL_COMMAND_IDS.closePalette, "Close command palette", "application"),
  descriptor(
    APPLICATION_SHELL_COMMAND_IDS.selectResource,
    "Select workspace resource",
    "workspace",
  ),
]);

const descriptorById = new Map(
  APPLICATION_SHELL_COMMAND_DESCRIPTORS.map((item) => [item.id, item]),
);

export function applicationShellCommandDescriptor(
  id: ApplicationShellCommandId,
): CommandDescriptor {
  return descriptorById.get(id)!;
}

function validatedInvocation(
  id: ApplicationShellCommandId,
  args: unknown,
  source: CommandSource,
): CommandInvocation {
  return CommandInvocationSchemaZ.parse({
    version: COMMAND_PROTOCOL_VERSION,
    id,
    source,
    args: CommandArgumentsSchemaZ.parse(args),
  });
}

export function applicationShellCommandInvocation<Id extends ApplicationShellCommandId>(
  id: Id,
  args: ApplicationShellCommandArgumentsById[Id],
  source: CommandSource,
): CommandInvocation {
  return validatedInvocation(id, args, source);
}

function invocationFromTemplate(
  template: SurfaceCommandTemplate,
  source: CommandSource,
): CommandInvocation {
  return validatedInvocation(
    ApplicationShellCommandIdSchemaZ.parse(template.id),
    template.args,
    source,
  );
}

function fallbackFocusReturnTarget(focus: FocusOverlayStateV1): SemanticFocusTarget {
  if (focus.terminalInputPaneId !== null) {
    return { kind: "pane", paneId: focus.terminalInputPaneId, input: "terminal" };
  }
  if (focus.appFocusedPaneId !== null) {
    return { kind: "pane", paneId: focus.appFocusedPaneId, input: "chrome" };
  }
  return { kind: "zone", zone: focus.focusZone };
}

export interface ApplicationShellActionTraceV1 {
  readonly version: typeof APPLICATION_SHELL_TRACE_VERSION;
  readonly invocations: readonly CommandInvocation[];
}

/**
 * One deterministic fixture trace for paired OpenTUI/DOM host conformance.
 * It describes semantic intent only; neither command execution nor host focus
 * handles enter the shared kernel.
 */
export function applicationShellActionTraceV1(
  input: ApplicationShellProjectionInputV1,
  source: CommandSource = { kind: "program", surface: "application-shell" },
): ApplicationShellActionTraceV1 {
  const focusPalette = paletteOverlay(input.focus);
  const overlayId = focusPalette?.id ?? "overlay.palette";
  const focusReturnTarget =
    focusPalette?.focusReturnTarget ?? fallbackFocusReturnTarget(input.focus);
  const invocations: CommandInvocation[] = [];

  for (const surface of CANONICAL_SURFACE_REGISTRY) {
    for (const template of commandsToOpenSurface({ surface: surface.id })) {
      invocations.push(invocationFromTemplate(template, source));
    }
  }
  for (const mode of ApplicationShellDockModeSchemaZ.options) {
    invocations.push(
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.setDockMode,
        { mode },
        source,
      ),
    );
  }
  invocations.push(
    applicationShellCommandInvocation(
      APPLICATION_SHELL_COMMAND_IDS.moveFocus,
      { target: { kind: "zone", zone: "dock-tabs" } },
      source,
    ),
    applicationShellCommandInvocation(
      APPLICATION_SHELL_COMMAND_IDS.openPalette,
      { overlayId, focusReturnTarget },
      source,
    ),
    applicationShellCommandInvocation(
      APPLICATION_SHELL_COMMAND_IDS.closePalette,
      { overlayId },
      source,
    ),
    applicationShellCommandInvocation(
      APPLICATION_SHELL_COMMAND_IDS.moveFocus,
      { target: focusReturnTarget },
      source,
    ),
  );

  return deepFreeze({ version: APPLICATION_SHELL_TRACE_VERSION, invocations });
}
