import { z } from "zod";
import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";

/** Passive counters, not an admission reservation or whole-daemon health check. */
export const WorkspaceAdmissionSnapshotSchemaZ = z
  .object({
    pending: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    disposed: z.boolean(),
    retained: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    retentionLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    /** Open's legacy ledger can require retirement; promotion replay never blocks new admission. */
    retentionMayBlock: z.boolean(),
  })
  .strict();
export type WorkspaceAdmissionSnapshot = z.infer<typeof WorkspaceAdmissionSnapshotSchemaZ>;
export const WorkspaceAdmissionResourceSchemaZ = z
  .object({
    version: z.literal(1),
    daemon: DaemonInstanceIdentitySchemaZ,
    promotion: z.union([WorkspaceAdmissionSnapshotSchemaZ, z.null()]),
    open: z.union([WorkspaceAdmissionSnapshotSchemaZ, z.null()]),
  })
  .strict();
export type WorkspaceAdmissionResource = z.infer<typeof WorkspaceAdmissionResourceSchemaZ>;
