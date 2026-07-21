import { z } from "zod";

import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";

export const WORKSPACE_CATALOG_RESOURCE_VERSION = 1 as const;

/**
 * Minimal daemon-private workspace routing record. The session name is needed
 * by trusted transports, but project paths and configuration metadata are not.
 */
export const WorkspaceCatalogEntryV1SchemaZ = z
  .object({
    workspaceName: z.string().min(1),
    sessionName: z.string().min(1),
  })
  .strict();

/**
 * Generation-stamped catalog used by trusted hosts before they retain any
 * workspace-to-session routing decision.
 */
export const WorkspaceCatalogResourceV1SchemaZ = z
  .object({
    version: z.literal(WORKSPACE_CATALOG_RESOURCE_VERSION),
    daemon: DaemonInstanceIdentitySchemaZ,
    workspaces: z.array(WorkspaceCatalogEntryV1SchemaZ),
  })
  .strict();

export type WorkspaceCatalogEntryV1 = z.infer<typeof WorkspaceCatalogEntryV1SchemaZ>;
export type WorkspaceCatalogResourceV1 = z.infer<typeof WorkspaceCatalogResourceV1SchemaZ>;
