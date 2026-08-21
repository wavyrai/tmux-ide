import { z } from "zod";
import {
  FleetAgentIdSchemaZ,
  FleetCatalogRevisionSchemaZ,
  FleetSessionIdSchemaZ,
} from "./fleet-catalog.ts";
import { DesktopWorkspaceNameSchemaZ } from "./desktop-workspace-name.ts";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "./semantic-identity.ts";

const SafeDisplayNameSchemaZ = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
      }),
    "display name contains control bytes",
  )
  .refine((value) => !value.startsWith("-"), "display name cannot be parsed as an option");
const OwnerPathSchemaZ = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes("\0"));
export const WorkspaceSessionCreateArgumentsSchemaZ = z
  .object({ displayName: SafeDisplayNameSchemaZ, cwd: OwnerPathSchemaZ.optional() })
  .strict();
export type WorkspaceSessionCreateArguments = z.infer<
  typeof WorkspaceSessionCreateArgumentsSchemaZ
>;

export const WorkspaceSessionCreateResultSchemaZ = z
  .object({
    operationId: z.uuid(),
    daemonInstanceId: z.uuid(),
    outcome: z.enum(["created", "adopted", "replayed"]),
    fleetSessionId: FleetSessionIdSchemaZ,
    /** Canonical registered route; displayName is presentation only. */
    workspaceName: DesktopWorkspaceNameSchemaZ,
    displayName: SafeDisplayNameSchemaZ,
  })
  .strict();
export type WorkspaceSessionCreateResult = z.infer<typeof WorkspaceSessionCreateResultSchemaZ>;

export const FleetAgentMutateArgumentsSchemaZ = z
  .object({
    fleetSessionId: FleetSessionIdSchemaZ,
    agentId: FleetAgentIdSchemaZ,
    expectedCatalogRevision: FleetCatalogRevisionSchemaZ,
    mutation: z.enum(["stop", "restart", "kill"]),
  })
  .strict();
export type FleetAgentMutateArguments = z.infer<typeof FleetAgentMutateArgumentsSchemaZ>;

export const FleetAgentMutateResultSchemaZ = z
  .object({
    operationId: z.uuid(),
    daemonInstanceId: z.uuid(),
    outcome: z.enum(["applied", "replayed"]),
    fleetSessionId: FleetSessionIdSchemaZ,
    agentId: FleetAgentIdSchemaZ,
    catalogRevision: FleetCatalogRevisionSchemaZ,
    mutation: z.enum(["stop", "restart", "kill"]),
  })
  .strict();
export type FleetAgentMutateResult = z.infer<typeof FleetAgentMutateResultSchemaZ>;

const AgentCommandSchemaZ = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint >= 0x20 && codePoint !== 0x7f && !(codePoint >= 0x80 && codePoint <= 0x9f);
      }),
    "command contains control bytes",
  );

const ExistingFleetProvisionTargetSchemaZ = z
  .object({
    kind: z.literal("existing-session"),
    fleetSessionId: FleetSessionIdSchemaZ,
    placement: z.enum(["window", "split-h", "split-v"]),
    targetSemanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ.nullable(),
    cwd: OwnerPathSchemaZ.nullable(),
    inheritTargetCwd: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.placement !== "window" && value.targetSemanticPaneId === null)
      context.addIssue({ code: "custom", message: "split placement requires a target pane" });
    if (value.inheritTargetCwd && value.targetSemanticPaneId === null)
      context.addIssue({ code: "custom", message: "target cwd requires a target pane" });
  });

const FreshFleetProvisionTargetSchemaZ = z
  .object({
    kind: z.literal("new-session"),
    displayName: SafeDisplayNameSchemaZ,
    cwd: OwnerPathSchemaZ,
  })
  .strict();

export const FleetAgentProvisionArgumentsSchemaZ = z
  .object({
    expectedCatalogRevision: FleetCatalogRevisionSchemaZ,
    command: AgentCommandSchemaZ,
    harness: SafeDisplayNameSchemaZ,
    displayTitle: SafeDisplayNameSchemaZ,
    target: z.discriminatedUnion("kind", [
      ExistingFleetProvisionTargetSchemaZ,
      FreshFleetProvisionTargetSchemaZ,
    ]),
  })
  .strict();
export type FleetAgentProvisionArguments = z.infer<typeof FleetAgentProvisionArgumentsSchemaZ>;

export const FleetAgentProvisionResultSchemaZ = z
  .object({
    operationId: z.uuid(),
    daemonInstanceId: z.uuid(),
    outcome: z.enum(["created", "replayed"]),
    fleetSessionId: FleetSessionIdSchemaZ,
    agentId: FleetAgentIdSchemaZ,
    catalogRevision: FleetCatalogRevisionSchemaZ,
    workspaceName: DesktopWorkspaceNameSchemaZ,
  })
  .strict();
export type FleetAgentProvisionResult = z.infer<typeof FleetAgentProvisionResultSchemaZ>;
