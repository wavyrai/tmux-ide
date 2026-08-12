import { z } from "zod";

import { AgentGraphOverlaySchemaZ } from "./agent-graph-overlay.ts";
import { DesktopMissionWorkspaceResourceSchemaZ } from "./desktop-missions.ts";
import { DesktopWorkspaceNameSchemaZ } from "./desktop-workspace-name.ts";
import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";

export const WORKSPACE_MISSIONS_RESOURCE_VERSION = 1 as const;

/**
 * Lazy Missions/Activity projection. It is intentionally separate from the
 * terminal-first application shell so opening a workspace never reads mission
 * history or assembles a graph before a consumer asks for this resource.
 */
export const WorkspaceMissionsResourceV1SchemaZ = z
  .object({
    workspaceName: DesktopWorkspaceNameSchemaZ,
    missionWorkspace: DesktopMissionWorkspaceResourceSchemaZ,
    agentGraphOverlay: AgentGraphOverlaySchemaZ.optional(),
  })
  .strict();

export const WorkspaceMissionsEnvelopeV1SchemaZ = z
  .object({
    version: z.literal(WORKSPACE_MISSIONS_RESOURCE_VERSION),
    daemon: DaemonInstanceIdentitySchemaZ,
    resource: WorkspaceMissionsResourceV1SchemaZ,
  })
  .strict();

export type WorkspaceMissionsResourceV1 = z.infer<typeof WorkspaceMissionsResourceV1SchemaZ>;
export type WorkspaceMissionsEnvelopeV1 = z.infer<typeof WorkspaceMissionsEnvelopeV1SchemaZ>;
