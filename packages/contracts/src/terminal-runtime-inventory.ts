import { z } from "zod";

import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";
import { DesktopWorkspaceNameSchemaZ } from "./desktop-workspace-name.ts";
import {
  TerminalAttachmentSemanticPaneIdSchemaZ,
  TerminalAttachmentSemanticWindowIdSchemaZ,
} from "./terminal-attachments.ts";
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

/**
 * #806: version 2 also names each window with its panes, so a client can issue
 * a pane stream for one window (`semanticWindowId` plus exactly these panes).
 * A window is listed only when every pane in it is available; a client that
 * asks for version 2 of an older daemon gets version 1 and has no windows.
 */
export const TerminalRuntimeInventoryWindowSchemaZ = z
  .object({
    semanticWindowId: TerminalAttachmentSemanticWindowIdSchemaZ,
    /** tmux's current window of the session. */
    active: z.boolean(),
    semanticPaneIds: z
      .array(TerminalAttachmentSemanticPaneIdSchemaZ)
      .min(1)
      .max(256)
      .refine((values) => new Set(values).size === values.length, "pane ids must be unique"),
  })
  .strict();
export type TerminalRuntimeInventoryWindow = z.infer<typeof TerminalRuntimeInventoryWindowSchemaZ>;

export const TerminalRuntimeInventoryProjectionV2SchemaZ =
  TerminalRuntimeInventoryProjectionV1SchemaZ.extend({
    /** In tmux window order. */
    windows: z.array(TerminalRuntimeInventoryWindowSchemaZ).max(256),
  })
    .strict()
    .superRefine((value, ctx) => {
      const listed = new Set(value.semanticPaneIds);
      const seen = new Set<string>();
      const windows = new Set<string>();
      let active = 0;
      for (const window of value.windows) {
        if (windows.has(window.semanticWindowId))
          ctx.addIssue({ code: "custom", message: "a window is listed twice", path: ["windows"] });
        windows.add(window.semanticWindowId);
        if (window.active) active += 1;
        for (const pane of window.semanticPaneIds) {
          if (!listed.has(pane) || seen.has(pane))
            ctx.addIssue({
              code: "custom",
              message: "a window pane must be listed once and in the inventory",
              path: ["windows"],
            });
          seen.add(pane);
        }
      }
      if (active > 1)
        ctx.addIssue({
          code: "custom",
          message: "at most one window is active",
          path: ["windows"],
        });
    });
export type TerminalRuntimeInventoryProjectionV2 = z.infer<
  typeof TerminalRuntimeInventoryProjectionV2SchemaZ
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
