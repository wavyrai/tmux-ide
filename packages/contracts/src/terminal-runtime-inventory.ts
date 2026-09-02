import { z } from "zod";

import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";
import { DesktopWorkspaceNameSchemaZ } from "./desktop-workspace-name.ts";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "./terminal-attachments.ts";
import { FleetSessionIdSchemaZ } from "./fleet-catalog.ts";
import { SemanticProductIdSchemaZ } from "./pane-appearance.ts";

/** Dedicated terminal topology authority; application-shell remains presentation/agent data. */
export const TERMINAL_RUNTIME_INVENTORY_RESOURCE_VERSION = 1 as const;

export const TerminalRuntimeInventoryProjectionV1SchemaZ = z
  .object({
    workspaceName: DesktopWorkspaceNameSchemaZ,
    workspaceId: SemanticProductIdSchemaZ,
    sessionId: FleetSessionIdSchemaZ,
    /** Daemon-scoped revision observed by the terminal-runtime event lane. */
    resourceRevision: z.number().int().nonnegative(),
    semanticPaneIds: z
      .array(TerminalAttachmentSemanticPaneIdSchemaZ)
      .max(256)
      .refine((values) => new Set(values).size === values.length, "pane ids must be unique")
      .refine(
        (values) => values.every((value, index) => index === 0 || values[index - 1]! < value),
        "pane ids must be sorted",
      ),
  })
  .strict();
export type TerminalRuntimeInventoryProjectionV1 = z.infer<
  typeof TerminalRuntimeInventoryProjectionV1SchemaZ
>;

export const TerminalRuntimeInventoryResourceV1SchemaZ = z
  .object({
    version: z.literal(TERMINAL_RUNTIME_INVENTORY_RESOURCE_VERSION),
    daemon: DaemonInstanceIdentitySchemaZ,
    resource: TerminalRuntimeInventoryProjectionV1SchemaZ,
  })
  .strict();
export type TerminalRuntimeInventoryResourceV1 = z.infer<
  typeof TerminalRuntimeInventoryResourceV1SchemaZ
>;
