import { z } from "zod";
import {
  TerminalReplicaSnapshotSchemaZ,
  TerminalReplicaPatchPayloadSchemaZ,
  TerminalReplicaTombstonePayloadSchemaZ,
} from "./terminal-replica.ts";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "./semantic-identity.ts";
import { SessionRuntimeGenerationSchemaZ } from "./session-runtime.ts";
import { WorkspaceIdSchemaZ } from "./workspace-state.ts";
import {
  TERMINAL_DELIVERY_CHUNK_BYTES,
  TERMINAL_DELIVERY_MAX_REPRESENTATION_BYTES,
} from "./terminal-delivery.ts";

/** Bundles111/112 include109/110 respectively; the old-compatible encoding offer stays compact. */
export const TERMINAL_PROJECTION_CAPABILITY_VERSION = 111;
export const TERMINAL_PROJECTION_LOCAL_CAPABILITY_VERSION = 112;
const Hash = z.string().regex(/^[0-9a-f]{16}$/u);
const Revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const TerminalDeferredHistorySchemaZ = z
  .object({ rows: z.number().int().min(0).max(10000), digest: Hash })
  .strict();
export type TerminalDeferredHistory = z.infer<typeof TerminalDeferredHistorySchemaZ>;
const ProjectionModes = TerminalReplicaSnapshotSchemaZ.shape.modes.extend({
  alternateScreen: z.literal(true),
});
/** A viewport projection is not a materialized canonical snapshot. History is deliberately absent. */
export const TerminalProjectionSnapshotSchemaZ = TerminalReplicaSnapshotSchemaZ.omit({
  history: true,
})
  .extend({
    cols: z.number().int().min(1).max(4096),
    rows: z.number().int().min(1).max(4096),
    grid: TerminalReplicaSnapshotSchemaZ.shape.grid.max(4096),
    modes: ProjectionModes,
    placements: TerminalReplicaSnapshotSchemaZ.shape.placements.max(4096),
    deferredHistory: TerminalDeferredHistorySchemaZ,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.grid.length !== value.rows ||
      value.grid.some((row) => row.cells.length !== value.cols) ||
      value.cols * value.rows > 1_000_000
    )
      ctx.addIssue({ code: "custom", message: "Invalid projection grid dimensions" });
    if (
      value.cursor.x >= value.cols ||
      value.cursor.y >= value.rows ||
      value.placements.some((p) => p.row + p.rows > value.rows || p.column + p.columns > value.cols)
    )
      ctx.addIssue({ code: "custom", message: "Projection metadata outside viewport" });
  });
export type TerminalProjectionSnapshot = z.infer<typeof TerminalProjectionSnapshotSchemaZ>;
export const TerminalProjectionPatchSchemaZ = TerminalReplicaPatchPayloadSchemaZ.omit({
  history: true,
  historyDelta: true,
})
  .extend({
    modes: ProjectionModes.optional(),
    dimensions: z
      .object({ cols: z.number().int().min(1).max(4096), rows: z.number().int().min(1).max(4096) })
      .strict()
      .optional(),
    placements: TerminalReplicaSnapshotSchemaZ.shape.placements.max(4096).optional(),
    deferredHistory: TerminalDeferredHistorySchemaZ,
    rows: TerminalReplicaPatchPayloadSchemaZ.shape.rows.max(4096),
  })
  .strict();
export type TerminalProjectionPatch = z.infer<typeof TerminalProjectionPatchSchemaZ>;
export const TerminalProjectionPayloadSchemaZ = z
  .discriminatedUnion("frame", [
    z
      .object({
        frame: z.literal("seed"),
        revision: Revision,
        projection: TerminalProjectionSnapshotSchemaZ,
      })
      .strict(),
    z
      .object({
        frame: z.literal("patch"),
        baseRevision: Revision,
        revision: Revision,
        patch: TerminalProjectionPatchSchemaZ,
      })
      .strict(),
    z
      .object({
        frame: z.literal("tombstone"),
        baseRevision: Revision,
        revision: Revision,
        tombstone: TerminalReplicaTombstonePayloadSchemaZ,
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (value.frame !== "seed" && value.revision <= value.baseRevision)
      ctx.addIssue({ code: "custom", message: "Projection revision must advance" });
  });
export type TerminalProjectionPayload = z.infer<typeof TerminalProjectionPayloadSchemaZ>;
const Address = z.object({
  workspaceName: WorkspaceIdSchemaZ,
  semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
  generation: SessionRuntimeGenerationSchemaZ,
  incarnation: z.string().min(1).max(256),
  deliveryNonce: z.uuid(),
});
const Proof = Address.extend({
  transactionId: z.uuid(),
  /** Source canonical root/revision; receipt does not assert history materialization. */
  canonicalRevision: Revision,
  canonicalStateHash: Hash,
  projectionStateHash: Hash,
  representationHash: Hash,
});
export const TerminalProjectionEnvelopeSchemaZ = Proof.extend({
  type: z.literal("terminal.projection"),
  performanceTraceId: z.uuid().optional(),
  protocolVersion: z.literal(1),
  encoding: z.literal("alternate-projection-binary-v1"),
  frame: z.enum(["seed", "patch", "tombstone"]),
  baseRevision: Revision.nullable(),
  representationBytes: z.number().int().min(1).max(TERMINAL_DELIVERY_MAX_REPRESENTATION_BYTES),
  chunkCount: z.number().int().min(1).max(256),
  canonicalEquivalent: z.literal(false),
  history: z.literal("deferred"),
  richPlacements: z.boolean(),
})
  .strict()
  .superRefine((value, ctx) => {
    if (value.chunkCount !== Math.ceil(value.representationBytes / TERMINAL_DELIVERY_CHUNK_BYTES))
      ctx.addIssue({ code: "custom", message: "Projection chunk count mismatch" });
    if (
      value.frame === "seed"
        ? value.baseRevision !== null
        : value.baseRevision === null || value.canonicalRevision <= value.baseRevision
    )
      ctx.addIssue({ code: "custom", message: "Projection base revision mismatch" });
  });
export type TerminalProjectionEnvelope = z.infer<typeof TerminalProjectionEnvelopeSchemaZ>;
/** This is never a TerminalDeliveryAck and must not advance a complete baseline. */
export const TerminalProjectionReceiptSchemaZ = Proof.extend({
  type: z.literal("terminal.projection.receipt"),
}).strict();
export type TerminalProjectionReceipt = z.infer<typeof TerminalProjectionReceiptSchemaZ>;
export const TerminalProjectionMaterializeSchemaZ = Address.extend({
  type: z.literal("terminal.projection.materialize"),
  requestId: z.uuid(),
  canonicalRevision: Revision,
  projectionStateHash: Hash,
}).strict();
export type TerminalProjectionMaterialize = z.infer<typeof TerminalProjectionMaterializeSchemaZ>;
