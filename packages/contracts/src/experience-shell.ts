import { z } from "zod";
import {
  APPLICATION_SHELL_COMMAND_IDS,
  CommandIdSchemaZ,
  type CommandArguments,
  type CommandId,
} from "./commands.ts";
import { SemanticIconIdSchemaZ, type SemanticIconId } from "./experience-identifiers.ts";

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

export const PRIMARY_WORKSPACE_MODE_IDS = ["home", "terminals"] as const;
export const PrimaryWorkspaceModeIdSchemaZ = z.enum(PRIMARY_WORKSPACE_MODE_IDS);
export type PrimaryWorkspaceModeId = z.infer<typeof PrimaryWorkspaceModeIdSchemaZ>;

export const DOCK_TOOL_IDS = ["files", "changes", "missions", "activity"] as const;
export const DockToolIdSchemaZ = z.enum(DOCK_TOOL_IDS);
export type DockToolId = z.infer<typeof DockToolIdSchemaZ>;

export const PRODUCT_SURFACE_IDS = [...PRIMARY_WORKSPACE_MODE_IDS, ...DOCK_TOOL_IDS] as const;
export const ProductSurfaceIdSchemaZ = z.enum(PRODUCT_SURFACE_IDS);
export type ProductSurfaceId = z.infer<typeof ProductSurfaceIdSchemaZ>;

export interface ShellAreaDefinition {
  readonly id: ShellAreaId;
  readonly label: string;
  readonly order: number;
}

export const CANONICAL_SHELL_AREAS: readonly ShellAreaDefinition[] = Object.freeze([
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

export interface SurfaceCommandTemplate {
  readonly id: CommandId;
  readonly args: Readonly<CommandArguments>;
}

export interface ProductSurfaceDefinition {
  readonly id: ProductSurfaceId;
  readonly icon: SemanticIconId;
  readonly label: string;
  readonly kind: SurfaceKind;
  readonly area: "workspace-canvas" | "bottom-dock";
  readonly order: number;
  readonly owningMode: PrimaryWorkspaceModeId;
  readonly shortcut: string;
  readonly activation: SurfaceCommandTemplate;
}

const modeCommand = (mode: PrimaryWorkspaceModeId): SurfaceCommandTemplate => ({
  id: APPLICATION_SHELL_COMMAND_IDS.activateMode,
  args: { mode },
});

const dockCommand = (tool: DockToolId): SurfaceCommandTemplate => ({
  id: APPLICATION_SHELL_COMMAND_IDS.activateDockTool,
  args: { tool },
});

export const CANONICAL_SURFACE_REGISTRY: readonly ProductSurfaceDefinition[] = Object.freeze([
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
]);

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
  if (surface.kind === "primary-mode") return [surface.activation];
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
  return commands;
}

for (const surface of CANONICAL_SURFACE_REGISTRY) {
  CommandIdSchemaZ.parse(surface.activation.id);
  SemanticIconIdSchemaZ.parse(surface.icon);
}
