import { z } from "zod";

import {
  DesktopDaemonCapabilityErrorSchemaZ,
  DesktopWorkspaceNameSchemaZ,
} from "./desktop-host.ts";
import { FleetSessionIdSchemaZ } from "./fleet-catalog.ts";

/**
 * Owner-host promotion request. The target is the OPAQUE fleet session id minted
 * by the fleet catalog (`session.<digest>`) — never a raw tmux session name or
 * path. The daemon resolves the id back to a live session name on its own side;
 * the wire only ever carries the catalog-visible identity.
 */
export const WorkspacePromoteArgumentsSchemaZ = z
  .object({
    sessionId: FleetSessionIdSchemaZ,
  })
  .strict();

export type WorkspacePromoteArguments = z.infer<typeof WorkspacePromoteArgumentsSchemaZ>;

/** Main-process authored retry and daemon-generation envelope (mirrors workspace.open). */
export const WorkspacePromoteMutationRequestSchemaZ = z
  .object({
    operationId: z.uuid(),
    expectedDaemonInstanceId: z.uuid(),
    intent: WorkspacePromoteArgumentsSchemaZ,
  })
  .strict();

export type WorkspacePromoteMutationRequest = z.infer<
  typeof WorkspacePromoteMutationRequestSchemaZ
>;

/**
 * Browser-safe result: only the workspace name the catalog already exposes. No
 * path, tmux session name, runtime id, socket, or command ever crosses the wire.
 */
export const WorkspacePromotedResourceSchemaZ = z
  .object({
    resourceVersion: z.literal(1),
    workspaceName: DesktopWorkspaceNameSchemaZ,
  })
  .strict();

export type WorkspacePromotedResource = z.infer<typeof WorkspacePromotedResourceSchemaZ>;

export const WorkspacePromoteMutationResultSchemaZ = z
  .object({
    operationId: z.uuid(),
    daemonInstanceId: z.uuid(),
    outcome: z.enum(["promoted", "replayed"]),
    resource: WorkspacePromotedResourceSchemaZ,
  })
  .strict();

export type WorkspacePromoteMutationResult = z.infer<typeof WorkspacePromoteMutationResultSchemaZ>;

/**
 * Renderer-safe host result. Electron authors the operation and daemon-generation
 * envelope from an explicit, owner-initiated promotion; no filesystem path or
 * tmux identity crosses to the renderer.
 */
export const WorkspacePromoteHostResultSchemaZ = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), result: WorkspacePromoteMutationResultSchemaZ }).strict(),
  z.object({ status: z.literal("error"), error: DesktopDaemonCapabilityErrorSchemaZ }).strict(),
]);

export type WorkspacePromoteHostResult = z.infer<typeof WorkspacePromoteHostResultSchemaZ>;
