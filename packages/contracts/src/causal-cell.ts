import { z } from "zod";

import {
  SessionRuntimeClientIdSchemaZ,
  SessionRuntimeGenerationSchemaZ,
} from "./session-runtime.ts";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "./semantic-identity.ts";
import { TerminalReplicaCellSchemaZ } from "./terminal-replica.ts";

export const CAUSAL_CELL_CAPABILITY_V1 = "causal-cell-v1" as const;
export const CausalCellCapabilitySchemaZ = z.literal(CAUSAL_CELL_CAPABILITY_V1);
export type CausalCellCapability = z.infer<typeof CausalCellCapabilitySchemaZ>;

const CanonicalStateHashSchemaZ = z.string().regex(/^[0-9a-f]{16}$/u);
const CanonicalRevisionSchemaZ = z.number().int().nonnegative().safe();
const GridExtentSchemaZ = z.number().int().positive().max(65_536);
const GridCoordinateSchemaZ = z.number().int().nonnegative().max(65_535);

export const CausalCellGeometryV1SchemaZ = z
  .object({
    cols: GridExtentSchemaZ,
    rows: GridExtentSchemaZ,
    row: GridCoordinateSchemaZ,
    column: GridCoordinateSchemaZ,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.row >= value.rows)
      context.addIssue({ code: "custom", path: ["row"], message: "row is outside geometry" });
    if (value.column >= value.cols)
      context.addIssue({
        code: "custom",
        path: ["column"],
        message: "column is outside geometry",
      });
  });

const CausalCellBindingShape = {
  version: z.literal(1),
  capability: CausalCellCapabilitySchemaZ,
  /** Probe identity is deliberately the performance trace identity. */
  traceId: z.uuid(),
  clientId: SessionRuntimeClientIdSchemaZ,
  /** Pane-stream request id; binds the proof to one authenticated transport. */
  transportNonce: z.uuid(),
  /** Negotiated terminal-delivery nonce; prevents replay across reopen. */
  deliveryNonce: z.uuid(),
  inputSequence: z.number().int().positive().max(0x7fff_ffff),
  semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
  generation: SessionRuntimeGenerationSchemaZ,
  incarnation: z.string().min(1).max(256),
  baselineRevision: CanonicalRevisionSchemaZ,
  baselineStateHash: CanonicalStateHashSchemaZ,
  geometry: CausalCellGeometryV1SchemaZ,
  before: TerminalReplicaCellSchemaZ,
  after: TerminalReplicaCellSchemaZ,
} as const;

/** Opt-in diagnostic request. It is never accepted as ordinary input metadata. */
export const CausalCellProbeV1SchemaZ = z
  .object(CausalCellBindingShape)
  .strict()
  .superRefine((value, context) => {
    if (value.before.width !== 1 || value.after.width !== 1)
      context.addIssue({
        code: "custom",
        path: [value.before.width !== 1 ? "before" : "after", "width"],
        message: "causal probe cells must be canonical width-1 cells",
      });
    if (JSON.stringify(value.before) === JSON.stringify(value.after))
      context.addIssue({ code: "custom", path: ["after"], message: "probe must change one cell" });
  });
export type CausalCellProbeV1 = z.infer<typeof CausalCellProbeV1SchemaZ>;

/**
 * Renderer-facing portion of a probe. The pane-stream client supplies the
 * authenticated transport identity, negotiated delivery nonce, pane and input
 * sequence immediately before serializing the wire frame.
 */
export type CausalCellProbeRequestV1 = Omit<
  CausalCellProbeV1,
  "clientId" | "transportNonce" | "deliveryNonce" | "inputSequence"
>;

export const CausalCellProofV1SchemaZ = z
  .object({
    ...CausalCellBindingShape,
    committedRevision: CanonicalRevisionSchemaZ,
    committedStateHash: CanonicalStateHashSchemaZ,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.before.width !== 1 || value.after.width !== 1)
      context.addIssue({
        code: "custom",
        path: [value.before.width !== 1 ? "before" : "after", "width"],
        message: "causal proof cells must be canonical width-1 cells",
      });
    if (value.committedRevision <= value.baselineRevision)
      context.addIssue({
        code: "custom",
        path: ["committedRevision"],
        message: "causal proof revision must advance",
      });
    if (JSON.stringify(value.before) === JSON.stringify(value.after))
      context.addIssue({ code: "custom", path: ["after"], message: "proof must change one cell" });
  });
export type CausalCellProofV1 = z.infer<typeof CausalCellProofV1SchemaZ>;

export const CausalCellFailureReasonV1SchemaZ = z.enum([
  "busy",
  "baseline-drift",
  "control-rejected",
  "marker-order",
  "marker-mismatch",
  "ambiguous-delta",
  "no-op",
  "geometry-drift",
  "reseeded",
  "timeout",
  "capacity-exhausted",
  "authority-lost",
  "transport-closed",
]);
export type CausalCellFailureReasonV1 = z.infer<typeof CausalCellFailureReasonV1SchemaZ>;

const CausalCellChangedCoordinateV1SchemaZ = z
  .object({ row: GridCoordinateSchemaZ, column: GridCoordinateSchemaZ })
  .strict();

/** Bounded, content-free explanation of a failed exact-one-cell proof. */
export const CausalCellStructuralDiffV1SchemaZ = z
  .object({
    version: z.literal(1),
    baselineRevision: CanonicalRevisionSchemaZ,
    baselineStateHash: CanonicalStateHashSchemaZ,
    candidateRevision: CanonicalRevisionSchemaZ,
    candidateStateHash: CanonicalStateHashSchemaZ,
    dimensionsChanged: z.boolean(),
    changedCellCount: z.number().int().nonnegative().safe(),
    changedRowCount: z.number().int().nonnegative().safe(),
    changedCoordinates: z.array(CausalCellChangedCoordinateV1SchemaZ).max(8),
    coordinatesTruncated: z.boolean(),
    changedWrappedRowCount: z.number().int().nonnegative().safe(),
    changedWrappedRows: z.array(GridCoordinateSchemaZ).max(8),
    wrappedRowsTruncated: z.boolean(),
    targetMatched: z.boolean(),
    cursorChanged: z.boolean(),
    modesChanged: z.boolean(),
    historyChanged: z.boolean(),
    placementsChanged: z.boolean(),
    bootstrapChanged: z.boolean(),
    semanticSnapshotMatched: z.boolean(),
    serializationOrderOnly: z.boolean(),
  })
  .strict();
export type CausalCellStructuralDiffV1 = z.infer<typeof CausalCellStructuralDiffV1SchemaZ>;

export const CausalCellFailureV1SchemaZ = z
  .object({
    version: z.literal(1),
    capability: CausalCellCapabilitySchemaZ,
    traceId: z.uuid(),
    reason: CausalCellFailureReasonV1SchemaZ,
    diagnostic: CausalCellStructuralDiffV1SchemaZ.optional(),
  })
  .strict();
export type CausalCellFailureV1 = z.infer<typeof CausalCellFailureV1SchemaZ>;
