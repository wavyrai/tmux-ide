import { z } from "zod";
import { CohesionFixtureV1SchemaZ, type CohesionFixtureV1 } from "./cohesion-fixture.ts";
import {
  APPLICATION_SHELL_COMMAND_IDS,
  COMMAND_PROTOCOL_VERSION,
  ApplicationShellCommandIdSchemaZ,
  CommandDescriptorSchemaZ,
  CommandSourceSchemaZ,
  type ApplicationShellCommandId,
  type CommandDescriptor,
  type CommandSource,
} from "./commands.ts";
import {
  ApplicationShellDockModeSchemaZ,
  CANONICAL_SURFACE_REGISTRY,
  DockToolIdSchemaZ,
  PrimaryWorkspaceModeIdSchemaZ,
  ProductSurfaceIdSchemaZ,
  SurfaceCommandTemplateSchemaZ,
  commandsToOpenSurface,
  type ApplicationShellDockMode,
  type DockToolId,
  type PrimaryWorkspaceModeId,
  type ProductSurfaceDefinition,
  type ProductSurfaceId,
  type SurfaceCommandTemplate,
} from "./experience-shell.ts";
import { SemanticIconIdSchemaZ, type SemanticIconId } from "./experience-identifiers.ts";
import {
  FocusOverlayStateV1SchemaZ,
  FocusZoneSchemaZ,
  SemanticFocusTargetSchemaZ,
  SemanticOverlaySchemaZ,
  resolveSemanticInputLayer,
  type FocusOverlayStateV1,
  type FocusZone,
  type SemanticFocusTarget,
  type SemanticOverlay,
} from "./focus-overlay.ts";
import { SemanticProductIdSchemaZ } from "./pane-appearance.ts";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "./semantic-identity.ts";

export const APPLICATION_SHELL_PROJECTION_VERSION = 1 as const;
export const APPLICATION_SHELL_TRACE_VERSION = 1 as const;

export const TerminalResourceUnavailableReasonSchemaZ = z.enum([
  "invalid-runtime-proof",
  "missing-semantic-stamp",
  "invalid-semantic-stamp",
  "duplicate-semantic-stamp",
  "duplicate-runtime-pane-binding",
  "not-single-pane-window",
]);
export type TerminalResourceUnavailableReason = z.infer<
  typeof TerminalResourceUnavailableReasonSchemaZ
>;

export const TerminalResourceAttachabilitySchemaZ = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("available"),
      semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      reason: TerminalResourceUnavailableReasonSchemaZ,
    })
    .strict(),
]);
export type TerminalResourceAttachability = z.infer<typeof TerminalResourceAttachabilitySchemaZ>;

export const ApplicationShellTerminalResourceSchemaZ = z
  .object({
    id: SemanticProductIdSchemaZ,
    title: z.string().min(1).max(160),
    kind: z.enum(["agent", "terminal"]),
    active: z.boolean(),
    attachability: TerminalResourceAttachabilitySchemaZ,
  })
  .strict();
export type ApplicationShellTerminalResource = z.infer<
  typeof ApplicationShellTerminalResourceSchemaZ
>;

export const ApplicationShellTerminalInventorySchemaZ = z
  .object({
    activeResourceId: SemanticProductIdSchemaZ.nullable(),
    resources: z.array(ApplicationShellTerminalResourceSchemaZ).max(512),
  })
  .strict()
  .superRefine((inventory, ctx) => {
    const ids = new Set<string>();
    const active = inventory.resources.filter((resource) => resource.active);
    for (const [index, resource] of inventory.resources.entries()) {
      if (ids.has(resource.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["resources", index, "id"],
          message: "terminal resource ids must be unique",
        });
      }
      ids.add(resource.id);
      if (
        resource.attachability.status === "available" &&
        resource.attachability.semanticPaneId !== resource.id
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["resources", index, "attachability", "semanticPaneId"],
          message: "attachable semantic pane identity must equal its terminal resource id",
        });
      }
      if (
        resource.id.startsWith("terminal.discovered.") &&
        resource.attachability.status === "available"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["resources", index, "attachability"],
          message: "discovered fallback terminal resources cannot be attachable",
        });
      }
    }
    if (active.length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["resources"],
        message: "terminal inventory may contain at most one active resource",
      });
    }
    if (
      (inventory.activeResourceId === null && active.length !== 0) ||
      (inventory.activeResourceId !== null &&
        (active.length !== 1 || active[0]!.id !== inventory.activeResourceId))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["activeResourceId"],
        message: "activeResourceId must identify the active terminal resource",
      });
    }
  });
export type ApplicationShellTerminalInventory = z.infer<
  typeof ApplicationShellTerminalInventorySchemaZ
>;

export interface ApplicationShellProjectionInputV1 extends Pick<
  CohesionFixtureV1,
  "project" | "workspace" | "dock" | "focus" | "connection"
> {
  /** Optional for backward compatibility with pre-inventory daemon resources. */
  readonly terminalInventory?: ApplicationShellTerminalInventory;
}

const ApplicationShellProjectionInputV1Fields = {
  project: CohesionFixtureV1SchemaZ.shape.project,
  workspace: CohesionFixtureV1SchemaZ.shape.workspace,
  dock: CohesionFixtureV1SchemaZ.shape.dock,
  focus: FocusOverlayStateV1SchemaZ,
  connection: CohesionFixtureV1SchemaZ.shape.connection,
} as const;

function refineUniqueAgentPaneIds(
  agents: readonly { readonly paneId: string | null }[],
  ctx: z.RefinementCtx,
  pathPrefix: readonly PropertyKey[],
): void {
  const paneIds = new Set<string>();
  for (const [index, agent] of agents.entries()) {
    if (agent.paneId === null) continue;
    if (paneIds.has(agent.paneId)) {
      ctx.addIssue({
        code: "custom",
        path: [...pathPrefix, index, "paneId"],
        message: "duplicate semantic pane identity",
      });
    }
    paneIds.add(agent.paneId);
  }
}

export const ApplicationShellProjectionInputV1WireSchemaZ = z
  .object(ApplicationShellProjectionInputV1Fields)
  .strict()
  .superRefine((input, ctx) => {
    refineUniqueAgentPaneIds(input.workspace.sidebar.agents, ctx, [
      "workspace",
      "sidebar",
      "agents",
    ]);
  });

export const ApplicationShellProjectionInputV1SchemaZ = z
  .object({
    ...ApplicationShellProjectionInputV1Fields,
    terminalInventory: ApplicationShellTerminalInventorySchemaZ.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    refineUniqueAgentPaneIds(input.workspace.sidebar.agents, ctx, [
      "workspace",
      "sidebar",
      "agents",
    ]);
    if (input.terminalInventory === undefined) return;
    const resources = new Map(
      input.terminalInventory.resources.map((resource) => [resource.id, resource]),
    );
    for (const [index, agent] of input.workspace.sidebar.agents.entries()) {
      if (agent.paneId === null) continue;
      const resource = resources.get(agent.paneId);
      if (resource === undefined || resource.kind !== "agent") {
        ctx.addIssue({
          code: "custom",
          path: ["workspace", "sidebar", "agents", index, "paneId"],
          message: "attached agents must correlate to one agent terminal resource",
        });
      }
    }
  });

export const ApplicationShellProjectionInputV2SchemaZ = z
  .object({
    ...ApplicationShellProjectionInputV1Fields,
    terminalInventory: ApplicationShellTerminalInventorySchemaZ,
  })
  .strict()
  .superRefine((input, ctx) => {
    refineUniqueAgentPaneIds(input.workspace.sidebar.agents, ctx, [
      "workspace",
      "sidebar",
      "agents",
    ]);
    const resources = new Map(
      input.terminalInventory.resources.map((resource) => [resource.id, resource]),
    );
    for (const [index, agent] of input.workspace.sidebar.agents.entries()) {
      if (agent.paneId === null) continue;
      const resource = resources.get(agent.paneId);
      if (resource === undefined || resource.kind !== "agent") {
        ctx.addIssue({
          code: "custom",
          path: ["workspace", "sidebar", "agents", index, "paneId"],
          message: "attached agents must correlate to one agent terminal resource",
        });
      }
    }
  });
export type ApplicationShellProjectionInputV2 = z.infer<
  typeof ApplicationShellProjectionInputV2SchemaZ
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
  /** Present on live resources that enumerate daemon-discovered terminal panes. */
  readonly terminalInventory?: ApplicationShellTerminalInventory;
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

const WorkspaceFixtureSchemaZ = CohesionFixtureV1SchemaZ.shape.workspace;

export const ApplicationShellSurfaceProjectionSchemaZ = z
  .object({
    id: ProductSurfaceIdSchemaZ,
    icon: SemanticIconIdSchemaZ,
    label: z.string().min(1).max(160),
    kind: z.enum(["primary-mode", "dock-tool"]),
    area: z.enum(["workspace-canvas", "bottom-dock"]),
    order: z.number().int().nonnegative(),
    owningMode: PrimaryWorkspaceModeIdSchemaZ,
    shortcut: z.string().min(1).max(32),
    activation: SurfaceCommandTemplateSchemaZ,
    active: z.boolean(),
    attention: z.boolean(),
    disabledReason: z.string().min(1).max(240).nullable(),
  })
  .strict();

export const ApplicationShellProjectionV1SchemaZ = z
  .object({
    version: z.literal(APPLICATION_SHELL_PROJECTION_VERSION),
    project: CohesionFixtureV1SchemaZ.shape.project,
    workspace: z
      .object({
        id: SemanticProductIdSchemaZ,
        name: z.string().min(1).max(160),
      })
      .strict(),
    sidebar: z
      .object({
        activeSessionId: SemanticProductIdSchemaZ,
        sessions: WorkspaceFixtureSchemaZ.shape.sidebar.shape.sessions,
        agents: WorkspaceFixtureSchemaZ.shape.sidebar.shape.agents,
      })
      .strict(),
    primaryNavigation: z
      .object({
        activeMode: PrimaryWorkspaceModeIdSchemaZ,
        items: z.array(ApplicationShellSurfaceProjectionSchemaZ),
      })
      .strict(),
    workspaceCanvas: z.object({ activeMode: PrimaryWorkspaceModeIdSchemaZ }).strict(),
    bottomDock: z
      .object({
        mode: ApplicationShellDockModeSchemaZ,
        activeTool: DockToolIdSchemaZ,
        tools: z.array(ApplicationShellSurfaceProjectionSchemaZ),
      })
      .strict(),
    statusStrip: CohesionFixtureV1SchemaZ.shape.connection,
    terminalInventory: ApplicationShellTerminalInventorySchemaZ.optional(),
    focus: z
      .object({
        windowActivity: z.enum(["active", "inactive"]),
        zone: FocusZoneSchemaZ,
        appFocusedPaneId: SemanticProductIdSchemaZ.nullable(),
        terminalInputPaneId: SemanticProductIdSchemaZ.nullable(),
        layoutSelectedPaneId: SemanticProductIdSchemaZ.nullable(),
        overlays: z.array(SemanticOverlaySchemaZ).max(16),
        palette: z
          .object({
            open: z.boolean(),
            overlayId: SemanticProductIdSchemaZ.nullable(),
            focusReturnTarget: SemanticFocusTargetSchemaZ.nullable(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((projection, ctx) => {
    refineUniqueAgentPaneIds(projection.sidebar.agents, ctx, ["sidebar", "agents"]);
    if (projection.terminalInventory === undefined) return;
    const resources = new Map(
      projection.terminalInventory.resources.map((resource) => [resource.id, resource]),
    );
    for (const [index, agent] of projection.sidebar.agents.entries()) {
      if (agent.paneId === null) continue;
      const resource = resources.get(agent.paneId);
      if (resource === undefined || resource.kind !== "agent") {
        ctx.addIssue({
          code: "custom",
          path: ["sidebar", "agents", index, "paneId"],
          message: "attached agents must correlate to one agent terminal resource",
        });
      }
    }
  });

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
    activation: SurfaceCommandTemplateSchemaZ.parse(definition.activation),
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
  const parsed = ApplicationShellProjectionInputV1SchemaZ.parse({
    project: input.project,
    workspace: input.workspace,
    dock: input.dock,
    focus: input.focus,
    connection: input.connection,
    terminalInventory: input.terminalInventory,
  });
  const surfaces = CANONICAL_SURFACE_REGISTRY.map((surface) => projectedSurface(surface, parsed));
  const palette = paletteOverlay(parsed.focus);
  return deepFreeze(
    ApplicationShellProjectionV1SchemaZ.parse({
      version: APPLICATION_SHELL_PROJECTION_VERSION,
      project: {
        id: parsed.project.id,
        name: parsed.project.name,
        rootLabel: parsed.project.rootLabel,
        readiness: {
          ...parsed.project.readiness,
          facts: [...parsed.project.readiness.facts],
          warnings: [...parsed.project.readiness.warnings],
        },
      },
      workspace: { id: parsed.workspace.id, name: parsed.workspace.name },
      sidebar: {
        activeSessionId: parsed.workspace.session.id,
        sessions: parsed.workspace.sidebar.sessions.map((session) => ({ ...session })),
        agents: parsed.workspace.sidebar.agents.map((agent) => ({ ...agent })),
      },
      primaryNavigation: {
        activeMode: parsed.workspace.activeMode,
        items: surfaces.filter((surface) => surface.kind === "primary-mode"),
      },
      workspaceCanvas: { activeMode: parsed.workspace.activeMode },
      bottomDock: {
        mode: ApplicationShellDockModeSchemaZ.parse(parsed.dock.mode),
        activeTool: parsed.dock.activeTool,
        tools: surfaces.filter((surface) => surface.kind === "dock-tool"),
      },
      statusStrip: { ...parsed.connection },
      ...(parsed.terminalInventory === undefined
        ? {}
        : {
            terminalInventory: {
              activeResourceId: parsed.terminalInventory.activeResourceId,
              resources: parsed.terminalInventory.resources.map((resource) => ({
                ...resource,
                attachability: { ...resource.attachability },
              })),
            },
          }),
      focus: {
        windowActivity: parsed.focus.windowActivity,
        zone: parsed.focus.focusZone,
        appFocusedPaneId: parsed.focus.appFocusedPaneId,
        terminalInputPaneId: parsed.focus.terminalInputPaneId,
        layoutSelectedPaneId: parsed.focus.layoutSelectedPaneId,
        overlays: parsed.focus.overlays.map(cloneOverlay),
        palette: {
          open: palette !== null,
          overlayId: palette?.id ?? null,
          focusReturnTarget: palette ? cloneFocusTarget(palette.focusReturnTarget) : null,
        },
      },
    }),
  );
}

export const ApplicationShellActivateModeArgumentsSchemaZ = z
  .object({ mode: PrimaryWorkspaceModeIdSchemaZ })
  .strict();
export const ApplicationShellActivateDockToolArgumentsSchemaZ = z
  .object({ tool: DockToolIdSchemaZ })
  .strict();
export const ApplicationShellSetDockModeArgumentsSchemaZ = z
  .object({ mode: ApplicationShellDockModeSchemaZ })
  .strict();
export const ApplicationShellMoveFocusArgumentsSchemaZ = z
  .object({ target: SemanticFocusTargetSchemaZ })
  .strict();
export const ApplicationShellOpenPaletteArgumentsSchemaZ = z
  .object({
    overlayId: SemanticProductIdSchemaZ,
    focusReturnTarget: SemanticFocusTargetSchemaZ,
  })
  .strict();
export const ApplicationShellClosePaletteArgumentsSchemaZ = z
  .object({ overlayId: SemanticProductIdSchemaZ })
  .strict();
export const ApplicationShellSelectResourceArgumentsSchemaZ = z
  .object({
    surface: ProductSurfaceIdSchemaZ,
    resourceId: SemanticProductIdSchemaZ,
  })
  .strict();

export const APPLICATION_SHELL_COMMAND_ARGUMENT_SCHEMAS = Object.freeze({
  [APPLICATION_SHELL_COMMAND_IDS.activateMode]: ApplicationShellActivateModeArgumentsSchemaZ,
  [APPLICATION_SHELL_COMMAND_IDS.activateDockTool]:
    ApplicationShellActivateDockToolArgumentsSchemaZ,
  [APPLICATION_SHELL_COMMAND_IDS.setDockMode]: ApplicationShellSetDockModeArgumentsSchemaZ,
  [APPLICATION_SHELL_COMMAND_IDS.moveFocus]: ApplicationShellMoveFocusArgumentsSchemaZ,
  [APPLICATION_SHELL_COMMAND_IDS.openPalette]: ApplicationShellOpenPaletteArgumentsSchemaZ,
  [APPLICATION_SHELL_COMMAND_IDS.closePalette]: ApplicationShellClosePaletteArgumentsSchemaZ,
  [APPLICATION_SHELL_COMMAND_IDS.selectResource]: ApplicationShellSelectResourceArgumentsSchemaZ,
} as const);

export type ApplicationShellCommandArgumentsById = {
  [Id in ApplicationShellCommandId]: z.infer<
    (typeof APPLICATION_SHELL_COMMAND_ARGUMENT_SCHEMAS)[Id]
  >;
};

export const ApplicationShellCommandInvocationSchemaZ = z.discriminatedUnion("id", [
  z
    .object({
      version: z.literal(COMMAND_PROTOCOL_VERSION),
      id: z.literal(APPLICATION_SHELL_COMMAND_IDS.activateMode),
      source: CommandSourceSchemaZ,
      args: ApplicationShellActivateModeArgumentsSchemaZ,
    })
    .strict(),
  z
    .object({
      version: z.literal(COMMAND_PROTOCOL_VERSION),
      id: z.literal(APPLICATION_SHELL_COMMAND_IDS.activateDockTool),
      source: CommandSourceSchemaZ,
      args: ApplicationShellActivateDockToolArgumentsSchemaZ,
    })
    .strict(),
  z
    .object({
      version: z.literal(COMMAND_PROTOCOL_VERSION),
      id: z.literal(APPLICATION_SHELL_COMMAND_IDS.setDockMode),
      source: CommandSourceSchemaZ,
      args: ApplicationShellSetDockModeArgumentsSchemaZ,
    })
    .strict(),
  z
    .object({
      version: z.literal(COMMAND_PROTOCOL_VERSION),
      id: z.literal(APPLICATION_SHELL_COMMAND_IDS.moveFocus),
      source: CommandSourceSchemaZ,
      args: ApplicationShellMoveFocusArgumentsSchemaZ,
    })
    .strict(),
  z
    .object({
      version: z.literal(COMMAND_PROTOCOL_VERSION),
      id: z.literal(APPLICATION_SHELL_COMMAND_IDS.openPalette),
      source: CommandSourceSchemaZ,
      args: ApplicationShellOpenPaletteArgumentsSchemaZ,
    })
    .strict(),
  z
    .object({
      version: z.literal(COMMAND_PROTOCOL_VERSION),
      id: z.literal(APPLICATION_SHELL_COMMAND_IDS.closePalette),
      source: CommandSourceSchemaZ,
      args: ApplicationShellClosePaletteArgumentsSchemaZ,
    })
    .strict(),
  z
    .object({
      version: z.literal(COMMAND_PROTOCOL_VERSION),
      id: z.literal(APPLICATION_SHELL_COMMAND_IDS.selectResource),
      source: CommandSourceSchemaZ,
      args: ApplicationShellSelectResourceArgumentsSchemaZ,
    })
    .strict(),
]);
export type ApplicationShellCommandInvocation = z.infer<
  typeof ApplicationShellCommandInvocationSchemaZ
>;

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

export interface ApplicationShellCommandDefinition {
  readonly descriptor: CommandDescriptor;
  readonly inputSchema: z.ZodType;
}

export const APPLICATION_SHELL_COMMAND_DEFINITIONS: readonly ApplicationShellCommandDefinition[] =
  Object.freeze(
    APPLICATION_SHELL_COMMAND_DESCRIPTORS.map((item) =>
      Object.freeze({
        descriptor: item,
        inputSchema:
          APPLICATION_SHELL_COMMAND_ARGUMENT_SCHEMAS[item.id as ApplicationShellCommandId],
      }),
    ),
  );

export function applicationShellCommandDescriptor(
  id: ApplicationShellCommandId,
): CommandDescriptor {
  return descriptorById.get(id)!;
}

export function applicationShellCommandArgumentSchema<Id extends ApplicationShellCommandId>(
  id: Id,
): (typeof APPLICATION_SHELL_COMMAND_ARGUMENT_SCHEMAS)[Id] {
  return APPLICATION_SHELL_COMMAND_ARGUMENT_SCHEMAS[id];
}

function validatedInvocation(
  id: ApplicationShellCommandId,
  args: unknown,
  source: CommandSource,
): ApplicationShellCommandInvocation {
  const parsedArgs = applicationShellCommandArgumentSchema(id).parse(args);
  return deepFreeze(
    ApplicationShellCommandInvocationSchemaZ.parse({
      version: COMMAND_PROTOCOL_VERSION,
      id,
      source,
      args: parsedArgs,
    }),
  );
}

export function applicationShellCommandInvocation<Id extends ApplicationShellCommandId>(
  id: Id,
  args: ApplicationShellCommandArgumentsById[Id],
  source: CommandSource,
): Extract<ApplicationShellCommandInvocation, { id: Id }> {
  return validatedInvocation(id, args, source) as Extract<
    ApplicationShellCommandInvocation,
    { id: Id }
  >;
}

function invocationFromTemplate(
  template: SurfaceCommandTemplate,
  source: CommandSource,
): ApplicationShellCommandInvocation {
  return validatedInvocation(
    ApplicationShellCommandIdSchemaZ.parse(template.id),
    template.args,
    source,
  );
}

export const ApplicationShellResourceSelectionSchemaZ = z
  .object({ surface: ProductSurfaceIdSchemaZ, resourceId: SemanticProductIdSchemaZ })
  .strict();

export const ApplicationShellReplayStateV1SchemaZ = z
  .object({
    activeMode: PrimaryWorkspaceModeIdSchemaZ,
    dockMode: ApplicationShellDockModeSchemaZ,
    activeDockTool: DockToolIdSchemaZ,
    focus: FocusOverlayStateV1SchemaZ,
    selectedResources: z.array(ApplicationShellResourceSelectionSchemaZ),
  })
  .strict()
  .superRefine((state, ctx) => {
    const surfaces = state.selectedResources.map(({ surface }) => surface);
    if (new Set(surfaces).size !== surfaces.length) {
      ctx.addIssue({
        code: "custom",
        message: "selected resources must be unique by surface",
        path: ["selectedResources"],
      });
    }
  });
export type ApplicationShellReplayStateV1 = z.infer<typeof ApplicationShellReplayStateV1SchemaZ>;

function applyFocusTarget(
  focus: FocusOverlayStateV1,
  target: SemanticFocusTarget,
): FocusOverlayStateV1 {
  if (target.kind === "pane") {
    return {
      ...focus,
      focusZone: target.input === "terminal" ? "terminal" : "canvas",
      appFocusedPaneId: target.paneId,
      terminalInputPaneId: target.input === "terminal" ? target.paneId : null,
    };
  }
  if (target.kind === "dock-tool") {
    return { ...focus, focusZone: "dock-tabs", terminalInputPaneId: null };
  }
  return {
    ...focus,
    focusZone: target.zone,
    terminalInputPaneId: null,
  };
}

function replaceResourceSelection(
  selections: readonly z.infer<typeof ApplicationShellResourceSelectionSchemaZ>[],
  next: z.infer<typeof ApplicationShellResourceSelectionSchemaZ>,
): z.infer<typeof ApplicationShellResourceSelectionSchemaZ>[] {
  const order = new Map(CANONICAL_SURFACE_REGISTRY.map((surface, index) => [surface.id, index]));
  return [...selections.filter(({ surface }) => surface !== next.surface), next].sort(
    (left, right) => order.get(left.surface)! - order.get(right.surface)!,
  );
}

/** Apply one semantic command while enforcing overlay input ownership. */
export function applyApplicationShellInvocationV1(
  state: ApplicationShellReplayStateV1,
  rawInvocation: ApplicationShellCommandInvocation,
): ApplicationShellReplayStateV1 {
  const current = ApplicationShellReplayStateV1SchemaZ.parse(state);
  const invocation = ApplicationShellCommandInvocationSchemaZ.parse(rawInvocation);
  const inputLayer = resolveSemanticInputLayer(current.focus);
  const overlayOwnsInput =
    inputLayer.kind === "modal-dialog" ||
    inputLayer.kind === "command-palette" ||
    inputLayer.kind === "context-menu";

  if (overlayOwnsInput) {
    if (
      invocation.id !== APPLICATION_SHELL_COMMAND_IDS.closePalette ||
      inputLayer.kind !== "command-palette" ||
      inputLayer.overlayId !== invocation.args.overlayId
    ) {
      throw new Error(`semantic input is owned by overlay: ${inputLayer.overlayId}`);
    }
  } else if (invocation.id === APPLICATION_SHELL_COMMAND_IDS.closePalette) {
    throw new Error(`cannot close absent command palette: ${invocation.args.overlayId}`);
  }

  let next: ApplicationShellReplayStateV1;
  switch (invocation.id) {
    case APPLICATION_SHELL_COMMAND_IDS.activateMode:
      next = { ...current, activeMode: invocation.args.mode };
      break;
    case APPLICATION_SHELL_COMMAND_IDS.activateDockTool:
      next = { ...current, activeDockTool: invocation.args.tool };
      break;
    case APPLICATION_SHELL_COMMAND_IDS.setDockMode:
      next = { ...current, dockMode: invocation.args.mode };
      break;
    case APPLICATION_SHELL_COMMAND_IDS.moveFocus:
      next = { ...current, focus: applyFocusTarget(current.focus, invocation.args.target) };
      break;
    case APPLICATION_SHELL_COMMAND_IDS.openPalette: {
      const overlay: SemanticOverlay = {
        id: invocation.args.overlayId,
        kind: "command-palette",
        focusReturnTarget: invocation.args.focusReturnTarget,
      };
      next = {
        ...current,
        focus: { ...current.focus, overlays: [...current.focus.overlays, overlay] },
      };
      break;
    }
    case APPLICATION_SHELL_COMMAND_IDS.closePalette: {
      const overlay = current.focus.overlays.find(({ id }) => id === invocation.args.overlayId);
      if (!overlay || overlay.kind !== "command-palette") {
        throw new Error(`command palette overlay is not open: ${invocation.args.overlayId}`);
      }
      const withoutClosed = {
        ...current.focus,
        overlays: current.focus.overlays.filter(({ id }) => id !== overlay.id),
      };
      next = { ...current, focus: applyFocusTarget(withoutClosed, overlay.focusReturnTarget) };
      break;
    }
    case APPLICATION_SHELL_COMMAND_IDS.selectResource:
      next = {
        ...current,
        selectedResources: replaceResourceSelection(current.selectedResources, invocation.args),
      };
      break;
  }
  return deepFreeze(ApplicationShellReplayStateV1SchemaZ.parse(next));
}

const ApplicationShellActionTraceV1BaseSchemaZ = z
  .object({
    version: z.literal(APPLICATION_SHELL_TRACE_VERSION),
    initialState: ApplicationShellReplayStateV1SchemaZ,
    invocations: z.array(ApplicationShellCommandInvocationSchemaZ),
    finalState: ApplicationShellReplayStateV1SchemaZ,
  })
  .strict();

function replayInvocations(
  initialState: ApplicationShellReplayStateV1,
  invocations: readonly ApplicationShellCommandInvocation[],
): ApplicationShellReplayStateV1 {
  return invocations.reduce(
    (state, invocation) => applyApplicationShellInvocationV1(state, invocation),
    deepFreeze(ApplicationShellReplayStateV1SchemaZ.parse(initialState)),
  );
}

export const ApplicationShellActionTraceV1SchemaZ =
  ApplicationShellActionTraceV1BaseSchemaZ.superRefine((trace, ctx) => {
    try {
      const replayed = replayInvocations(trace.initialState, trace.invocations);
      if (JSON.stringify(replayed) !== JSON.stringify(trace.finalState)) {
        ctx.addIssue({
          code: "custom",
          message: "final state does not match sequential command replay",
          path: ["finalState"],
        });
      }
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "command replay failed",
        path: ["invocations"],
      });
    }
  });
export type ApplicationShellActionTraceV1 = z.infer<typeof ApplicationShellActionTraceV1SchemaZ>;

export function replayApplicationShellActionTraceV1(
  trace: ApplicationShellActionTraceV1,
): ApplicationShellReplayStateV1 {
  const parsed = ApplicationShellActionTraceV1SchemaZ.parse(trace);
  return replayInvocations(parsed.initialState, parsed.invocations);
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
  const parsedInput = ApplicationShellProjectionInputV1SchemaZ.parse({
    project: input.project,
    workspace: input.workspace,
    dock: input.dock,
    focus: input.focus,
    connection: input.connection,
    terminalInventory: input.terminalInventory,
  });
  if (parsedInput.focus.overlays.length > 0) {
    throw new Error("application shell action traces require a closed-overlay initial state");
  }
  const initialState = deepFreeze(
    ApplicationShellReplayStateV1SchemaZ.parse({
      activeMode: parsedInput.workspace.activeMode,
      dockMode: parsedInput.dock.mode,
      activeDockTool: parsedInput.dock.activeTool,
      focus: parsedInput.focus,
      selectedResources: [],
    }),
  );
  let currentState = initialState;
  const invocations: ApplicationShellCommandInvocation[] = [];
  const append = (invocation: ApplicationShellCommandInvocation): void => {
    currentState = applyApplicationShellInvocationV1(currentState, invocation);
    invocations.push(invocation);
  };

  for (const surface of CANONICAL_SURFACE_REGISTRY) {
    for (const template of commandsToOpenSurface({ surface: surface.id })) {
      append(invocationFromTemplate(template, source));
    }
  }
  for (const mode of ApplicationShellDockModeSchemaZ.options) {
    append(
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.setDockMode,
        { mode },
        source,
      ),
    );
  }
  const focusReturnTarget = { kind: "zone", zone: "dock-tabs" } as const;
  const overlayId = "overlay.palette.trace";
  append(
    applicationShellCommandInvocation(
      APPLICATION_SHELL_COMMAND_IDS.moveFocus,
      { target: focusReturnTarget },
      source,
    ),
  );
  append(
    applicationShellCommandInvocation(
      APPLICATION_SHELL_COMMAND_IDS.openPalette,
      { overlayId, focusReturnTarget },
      source,
    ),
  );
  append(
    applicationShellCommandInvocation(
      APPLICATION_SHELL_COMMAND_IDS.closePalette,
      { overlayId },
      source,
    ),
  );

  return deepFreeze(
    ApplicationShellActionTraceV1SchemaZ.parse({
      version: APPLICATION_SHELL_TRACE_VERSION,
      initialState,
      invocations,
      finalState: currentState,
    }),
  );
}
