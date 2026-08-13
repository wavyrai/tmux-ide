import { z } from "zod";
import {
  FleetAgentIdSchemaZ,
  FleetCatalogRevisionSchemaZ,
  FleetSessionIdSchemaZ,
} from "./fleet-catalog.ts";
import { DesktopWorkspaceNameSchemaZ } from "./desktop-workspace-name.ts";

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
