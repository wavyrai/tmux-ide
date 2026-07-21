import { z } from "zod";
import { APPLICATION_SHELL_COMMAND_IDS } from "./commands.ts";
import { SemanticIconIdSchemaZ } from "./experience-identifiers.ts";
import { SemanticProductIdSchemaZ } from "./pane-appearance.ts";

/** Canonical product information architecture. Hosts may change placement, never identity/order. */
export const EXPERIENCE_KERNEL_VERSION = 1 as const;

export const ShellAreaIdSchemaZ = z.enum([
  "application-bar",
  "sidebar",
  "primary-navigation",
  "context-actions",
  "workspace-canvas",
  "bottom-dock",
  "status-strip",
]);
export type ShellAreaId = z.infer<typeof ShellAreaIdSchemaZ>;

export const PRIMARY_WORKSPACE_MODE_IDS = Object.freeze(["home", "terminals"] as const);
export const PrimaryWorkspaceModeIdSchemaZ = z.enum(PRIMARY_WORKSPACE_MODE_IDS);
export type PrimaryWorkspaceModeId = z.infer<typeof PrimaryWorkspaceModeIdSchemaZ>;

export const DOCK_TOOL_IDS = Object.freeze(["files", "changes", "missions", "activity"] as const);
export const DockToolIdSchemaZ = z.enum(DOCK_TOOL_IDS);
export type DockToolId = z.infer<typeof DockToolIdSchemaZ>;

export const PRODUCT_SURFACE_IDS = Object.freeze([
  ...PRIMARY_WORKSPACE_MODE_IDS,
  ...DOCK_TOOL_IDS,
] as const);
export const ProductSurfaceIdSchemaZ = z.enum(PRODUCT_SURFACE_IDS);
export type ProductSurfaceId = z.infer<typeof ProductSurfaceIdSchemaZ>;

export interface ShellAreaDefinition {
  readonly id: ShellAreaId;
  readonly label: string;
  readonly order: number;
}

function deepFreezeData<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeData(child);
  return Object.freeze(value);
}

export const CANONICAL_SHELL_AREAS: readonly ShellAreaDefinition[] = deepFreezeData([
  { id: "application-bar", label: "Application bar", order: 0 },
  { id: "sidebar", label: "Workspace sidebar", order: 1 },
  { id: "primary-navigation", label: "Workspace modes", order: 2 },
  { id: "context-actions", label: "Context actions", order: 3 },
  { id: "workspace-canvas", label: "Workspace canvas", order: 4 },
  { id: "bottom-dock", label: "Bottom dock", order: 5 },
  { id: "status-strip", label: "Status and recovery", order: 6 },
]);

export const SurfaceKindSchemaZ = z.enum(["primary-mode", "dock-tool"]);
export type SurfaceKind = z.infer<typeof SurfaceKindSchemaZ>;

export const ApplicationShellDockModeSchemaZ = z.enum(["collapsed", "open", "maximized"]);
export type ApplicationShellDockMode = z.infer<typeof ApplicationShellDockModeSchemaZ>;

export const SurfaceCommandTemplateSchemaZ = z.discriminatedUnion("id", [
  z
    .object({
      id: z.literal(APPLICATION_SHELL_COMMAND_IDS.activateMode),
      args: z.object({ mode: PrimaryWorkspaceModeIdSchemaZ }).strict(),
    })
    .strict(),
  z
    .object({
      id: z.literal(APPLICATION_SHELL_COMMAND_IDS.activateDockTool),
      args: z.object({ tool: DockToolIdSchemaZ }).strict(),
    })
    .strict(),
  z
    .object({
      id: z.literal(APPLICATION_SHELL_COMMAND_IDS.setDockMode),
      args: z.object({ mode: ApplicationShellDockModeSchemaZ }).strict(),
    })
    .strict(),
  z
    .object({
      id: z.literal(APPLICATION_SHELL_COMMAND_IDS.selectResource),
      args: z
        .object({ surface: ProductSurfaceIdSchemaZ, resourceId: SemanticProductIdSchemaZ })
        .strict(),
    })
    .strict(),
]);
export type SurfaceCommandTemplate = z.infer<typeof SurfaceCommandTemplateSchemaZ>;

export const ProductSurfaceDefinitionSchemaZ = z
  .object({
    id: ProductSurfaceIdSchemaZ,
    icon: SemanticIconIdSchemaZ,
    label: z.string().min(1).max(160),
    kind: SurfaceKindSchemaZ,
    area: z.enum(["workspace-canvas", "bottom-dock"]),
    order: z.number().int().nonnegative(),
    owningMode: PrimaryWorkspaceModeIdSchemaZ,
    shortcut: z.string().min(1).max(32),
    activation: SurfaceCommandTemplateSchemaZ,
  })
  .strict()
  .superRefine((surface, ctx) => {
    if (
      surface.kind === "primary-mode" &&
      surface.activation.id !== APPLICATION_SHELL_COMMAND_IDS.activateMode
    ) {
      ctx.addIssue({
        code: "custom",
        message: "primary modes require a mode activation command",
        path: ["activation", "id"],
      });
    }
    if (
      surface.kind === "dock-tool" &&
      surface.activation.id !== APPLICATION_SHELL_COMMAND_IDS.activateDockTool
    ) {
      ctx.addIssue({
        code: "custom",
        message: "dock tools require a dock activation command",
        path: ["activation", "id"],
      });
    }
  });
export type ProductSurfaceDefinition = z.infer<typeof ProductSurfaceDefinitionSchemaZ>;

const modeCommand = (mode: PrimaryWorkspaceModeId): SurfaceCommandTemplate =>
  deepFreezeData({
    id: APPLICATION_SHELL_COMMAND_IDS.activateMode,
    args: { mode },
  });

const dockCommand = (tool: DockToolId): SurfaceCommandTemplate =>
  deepFreezeData({
    id: APPLICATION_SHELL_COMMAND_IDS.activateDockTool,
    args: { tool },
  });

export const CANONICAL_SURFACE_REGISTRY: readonly ProductSurfaceDefinition[] = deepFreezeData(
  ProductSurfaceDefinitionSchemaZ.array().parse([
    {
      id: "home",
      icon: "home",
      label: "Home",
      kind: "primary-mode",
      area: "workspace-canvas",
      order: 0,
      owningMode: "home",
      shortcut: "F1",
      activation: modeCommand("home"),
    },
    {
      id: "terminals",
      icon: "terminals",
      label: "Terminals",
      kind: "primary-mode",
      area: "workspace-canvas",
      order: 1,
      owningMode: "terminals",
      shortcut: "F2",
      activation: modeCommand("terminals"),
    },
    {
      id: "files",
      icon: "files",
      label: "Files",
      kind: "dock-tool",
      area: "bottom-dock",
      order: 0,
      owningMode: "terminals",
      shortcut: "F3",
      activation: dockCommand("files"),
    },
    {
      id: "changes",
      icon: "changes",
      label: "Changes",
      kind: "dock-tool",
      area: "bottom-dock",
      order: 1,
      owningMode: "terminals",
      shortcut: "F4",
      activation: dockCommand("changes"),
    },
    {
      id: "missions",
      icon: "missions",
      label: "Missions",
      kind: "dock-tool",
      area: "bottom-dock",
      order: 2,
      owningMode: "terminals",
      shortcut: "F6",
      activation: dockCommand("missions"),
    },
    {
      id: "activity",
      icon: "activity",
      label: "Activity",
      kind: "dock-tool",
      area: "bottom-dock",
      order: 3,
      owningMode: "terminals",
      shortcut: "F9",
      activation: dockCommand("activity"),
    },
  ]),
);

const surfaceById = new Map(CANONICAL_SURFACE_REGISTRY.map((surface) => [surface.id, surface]));

export function canonicalSurface(id: ProductSurfaceId): ProductSurfaceDefinition {
  return surfaceById.get(id)!;
}

export interface SurfaceOpenIntent {
  readonly surface: ProductSurfaceId;
  readonly resourceId?: string;
}

/**
 * A deep link and a pointer/keyboard route converge on this semantic sequence.
 * Dock tools remain dock tools: opening one never manufactures a top-level route.
 */
export function commandsToOpenSurface(
  intent: SurfaceOpenIntent,
): readonly SurfaceCommandTemplate[] {
  const surface = canonicalSurface(intent.surface);
  if (surface.kind === "primary-mode") return deepFreezeData([surface.activation]);
  const commands: SurfaceCommandTemplate[] = [
    modeCommand(surface.owningMode),
    { id: APPLICATION_SHELL_COMMAND_IDS.setDockMode, args: { mode: "open" } },
    surface.activation,
  ];
  if (intent.resourceId) {
    commands.push({
      id: APPLICATION_SHELL_COMMAND_IDS.selectResource,
      args: { surface: surface.id, resourceId: intent.resourceId },
    });
  }
  return deepFreezeData(SurfaceCommandTemplateSchemaZ.array().parse(commands));
}

for (const surface of CANONICAL_SURFACE_REGISTRY) {
  SemanticIconIdSchemaZ.parse(surface.icon);
}
