import { z } from "zod";

import { DesktopWorkspaceNameSchemaZ } from "./desktop-host.ts";
import { SemanticProductIdSchemaZ } from "./pane-appearance.ts";

/** Owner-host request. The project path is never a browser-safe resource field. */
export const WorkspaceOpenArgumentsSchemaZ = z
  .object({
    projectDir: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !value.includes("\0"), "project directory must not contain NUL"),
  })
  .strict();

export type WorkspaceOpenArguments = z.infer<typeof WorkspaceOpenArgumentsSchemaZ>;

/** Main-process authored retry and daemon-generation envelope. */
export const WorkspaceOpenMutationRequestSchemaZ = z
  .object({
    operationId: z.uuid(),
    expectedDaemonInstanceId: z.uuid(),
    intent: WorkspaceOpenArgumentsSchemaZ,
  })
  .strict();

export type WorkspaceOpenMutationRequest = z.infer<typeof WorkspaceOpenMutationRequestSchemaZ>;

/** Browser-safe result: no path, tmux session name, runtime id, socket, or command. */
export const WorkspaceOpenedResourceSchemaZ = z
  .object({
    resourceVersion: z.literal(1),
    workspaceName: DesktopWorkspaceNameSchemaZ,
    initialPaneId: SemanticProductIdSchemaZ,
  })
  .strict();

export type WorkspaceOpenedResource = z.infer<typeof WorkspaceOpenedResourceSchemaZ>;

export const WorkspaceOpenMutationResultSchemaZ = z
  .object({
    operationId: z.uuid(),
    daemonInstanceId: z.uuid(),
    outcome: z.enum(["created", "reopened", "replayed"]),
    resource: WorkspaceOpenedResourceSchemaZ,
  })
  .strict();

export type WorkspaceOpenMutationResult = z.infer<typeof WorkspaceOpenMutationResultSchemaZ>;
