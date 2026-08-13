import { z } from "zod";

import { DesktopWorkspaceNameSchemaZ } from "./desktop-host.ts";
import { FleetSessionIdSchemaZ } from "./fleet-catalog.ts";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "./terminal-attachments.ts";

const ProjectSourceZ = z
  .object({ kind: z.literal("project"), projectDir: z.string().min(1) })
  .strict();
const LiveSessionSourceZ = z
  .object({ kind: z.literal("live-session"), sessionId: FleetSessionIdSchemaZ })
  .strict();

/** A prepare never changes the caller's selected workspace. */
export const WorkspaceOpenPrepareArgumentsSchemaZ = z
  .object({
    source: z.discriminatedUnion("kind", [ProjectSourceZ, LiveSessionSourceZ]),
    previousWorkspaceName: DesktopWorkspaceNameSchemaZ.nullable().optional(),
  })
  .strict();
export type WorkspaceOpenPrepareArguments = z.infer<typeof WorkspaceOpenPrepareArgumentsSchemaZ>;

export const WorkspaceOpenPreparedProofSchemaZ = z
  .object({
    semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
    paneCount: z.number().int().positive(),
    terminalRevision: z.number().int().nonnegative(),
    terminalStateHash: z.string().regex(/^[0-9a-f]{16}$/u),
  })
  .strict();

export const WorkspaceOpenPreparedResultSchemaZ = z
  .object({
    operationId: z.uuid(),
    daemonInstanceId: z.uuid(),
    phase: z.literal("prepared"),
    prepareToken: z.uuid(),
    preparedRevision: z.number().int().positive(),
    outcome: z.enum(["created", "reopened", "replayed", "promoted"]),
    workspaceName: DesktopWorkspaceNameSchemaZ,
    previousWorkspaceName: DesktopWorkspaceNameSchemaZ.nullable(),
    proof: WorkspaceOpenPreparedProofSchemaZ,
  })
  .strict();
export type WorkspaceOpenPreparedResult = z.infer<typeof WorkspaceOpenPreparedResultSchemaZ>;

export const WorkspaceOpenDecisionArgumentsSchemaZ = z
  .object({ prepareToken: z.uuid(), preparedRevision: z.number().int().positive() })
  .strict();
export type WorkspaceOpenDecisionArguments = z.infer<typeof WorkspaceOpenDecisionArgumentsSchemaZ>;

const DecisionBaseZ = z.object({
  operationId: z.uuid(),
  daemonInstanceId: z.uuid(),
  prepareToken: z.uuid(),
  preparedRevision: z.number().int().positive(),
  workspaceName: DesktopWorkspaceNameSchemaZ,
  previousWorkspaceName: DesktopWorkspaceNameSchemaZ.nullable(),
});
export const WorkspaceOpenCommittedResultSchemaZ = DecisionBaseZ.extend({
  phase: z.literal("committed"),
}).strict();
export const WorkspaceOpenCancelledResultSchemaZ = DecisionBaseZ.extend({
  phase: z.literal("cancelled"),
}).strict();
export type WorkspaceOpenCommittedResult = z.infer<typeof WorkspaceOpenCommittedResultSchemaZ>;
export type WorkspaceOpenCancelledResult = z.infer<typeof WorkspaceOpenCancelledResultSchemaZ>;
