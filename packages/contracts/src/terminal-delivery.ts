import type { TerminalProjectionEnvelope } from "./terminal-projection.ts";
import { z } from "zod";
import { CausalCellProofV1SchemaZ } from "./causal-cell.ts";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "./semantic-identity.ts";
import { SessionRuntimeGenerationSchemaZ } from "./session-runtime.ts";
import { WorkspaceIdSchemaZ } from "./workspace-state.ts";
import {
  TerminalReplicaRowSchemaZ,
  TerminalReplicaPatchPayloadSchemaZ,
  TerminalReplicaSnapshotSchemaZ,
  TerminalReplicaTombstonePayloadSchemaZ,
} from "./terminal-replica.ts";

/** Stable capability diagnosis carried by the existing pane-scoped source-closed fault. */
export const STOCK_CAPTURE_TAB_UNAVAILABLE =
  "This tmux server cannot provide an exact snapshot of saved tab cells. Continue this session in native tmux, or use a new session started with tmux-ide's bundled server.";

/** Opt-in bundles:109 adds binary cells+107 graphics;110 also adds108 local image leases.
 * Offer compact in encodings for old-daemon compatibility; new daemons respond binary explicitly. */
export const TERMINAL_DELIVERY_BINARY_CAPABILITY_VERSION = 109;
export const TERMINAL_DELIVERY_BINARY_LOCAL_CAPABILITY_VERSION = 110;

export const TERMINAL_DELIVERY_PROTOCOL_VERSION = 1 as const;

/**
 * History on demand (owner's decision 17 Nov, 2.9.26). With capability 122 a
 * seed carries the screen plus the newest TERMINAL_DELIVERY_HISTORY_TAIL_ROWS
 * history rows and a commitment `{rows, digest}` to the older, unloaded rows.
 * The rows digest is a polynomial fold, so the loaded rows and the commitment
 * still verify against the full canonical state hash. The client asks for
 * older rows with a history request; they come newest first in a "history"
 * frame at its current revision. It replaces deferred-history-v1 (111/112).
 */
export const TERMINAL_DELIVERY_PARTIAL_HISTORY_CAPABILITY_VERSION = 122;
export const TERMINAL_DELIVERY_HISTORY_TAIL_ROWS = 200;
export const TERMINAL_DELIVERY_HISTORY_CHUNK_MAX_ROWS = 2000;
/** Capability numbers one offer may carry (nine before 2.9.26). */
export const TERMINAL_DELIVERY_MAX_OFFERED_VERSIONS = 16;
export const TERMINAL_DELIVERY_CHUNK_BYTES = 256 * 1024;
export const TERMINAL_DELIVERY_PATCH_TO_SEED_BYTES = 512 * 1024;
export const TERMINAL_DELIVERY_MAX_REPRESENTATION_BYTES = 16 * 1024 * 1024;

export const TerminalDeliveryEncodingSchemaZ = z.enum([
  "semantic-compact-v1",
  "semantic-binary-v1",
  "semantic-v1",
  "ansi-diff-v1",
  "ansi-raw-v1",
]);
export type TerminalDeliveryEncoding = z.infer<typeof TerminalDeliveryEncodingSchemaZ>;

export const TerminalDeliveryOfferSchemaZ = z
  .object({
    // Released daemons before 2.9.26 refuse more than nine numbers, so a client
    // offers a tenth only to a daemon whose productVersion is 2.9.26 or later.
    protocolVersions: z
      .array(z.number().int().positive())
      .min(1)
      .max(TERMINAL_DELIVERY_MAX_OFFERED_VERSIONS),
    encodings: z.array(TerminalDeliveryEncodingSchemaZ).min(1).max(4),
    richPlacements: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.protocolVersions).size !== value.protocolVersions.length)
      context.addIssue({ code: "custom", message: "protocolVersions must be unique" });
    if (new Set(value.encodings).size !== value.encodings.length)
      context.addIssue({ code: "custom", message: "encodings must be unique" });
  });
export type TerminalDeliveryOffer = z.infer<typeof TerminalDeliveryOfferSchemaZ>;

export const TerminalDeliveryNegotiatedSchemaZ = z
  .object({
    protocolVersion: z.literal(TERMINAL_DELIVERY_PROTOCOL_VERSION),
    encoding: TerminalDeliveryEncodingSchemaZ,
    fallbackEncoding: z.literal("semantic-v1").nullable().optional(),
    alternateScreenProjection: z.literal("deferred-history-v1").optional(),
    /** Capability 122: history on demand. */
    partialHistory: z.literal("tail-v1").optional(),
    richPlacements: z.boolean(),
    generation: SessionRuntimeGenerationSchemaZ,
    deliveryNonce: z.uuid(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.alternateScreenProjection && value.encoding !== "semantic-binary-v1")
      context.addIssue({ code: "custom", message: "projection requires binary semantic delivery" });
    if (
      value.partialHistory &&
      ((value.encoding !== "semantic-compact-v1" && value.encoding !== "semantic-binary-v1") ||
        value.alternateScreenProjection)
    )
      context.addIssue({
        code: "custom",
        message: "partial history requires compact or binary semantic delivery and no projection",
      });
    if (value.fallbackEncoding && value.encoding !== "semantic-compact-v1")
      context.addIssue({ code: "custom", message: "fallback encoding requires compact semantic" });
    if (
      value.richPlacements &&
      value.encoding !== "semantic-v1" &&
      value.encoding !== "semantic-compact-v1" &&
      value.encoding !== "semantic-binary-v1"
    )
      context.addIssue({ code: "custom", message: "rich placements require semantic delivery" });
  });
export type TerminalDeliveryNegotiated = z.infer<typeof TerminalDeliveryNegotiatedSchemaZ>;

export const TerminalDeliveryNegotiationResultSchemaZ = z.discriminatedUnion("accepted", [
  z.object({ accepted: z.literal(true), negotiated: TerminalDeliveryNegotiatedSchemaZ }).strict(),
  z
    .object({
      accepted: z.literal(false),
      reason: z.enum([
        "protocol-version-mismatch",
        "encoding-mismatch",
        "unsupported-capability-combination",
      ]),
    })
    .strict(),
]);
export type TerminalDeliveryNegotiationResult = z.infer<
  typeof TerminalDeliveryNegotiationResultSchemaZ
>;

/** The rows digest of no rows. */
export const TERMINAL_HISTORY_EMPTY_DIGEST = "0000000000000000";

/**
 * Pinned at `rows: 0` to the digest of no rows: with that anchor, each history
 * chunk's chain check is an induction proof (review of #435). Without it a
 * forged chain of chunks could end in any digest and still match the hash.
 */
export const TerminalDeliveryHistoryCommitmentSchemaZ = z
  .object({
    rows: z.number().int().nonnegative().max(1_000_000),
    digest: z.string().regex(/^[0-9a-f]{16}$/u),
  })
  .strict()
  .refine(
    (value) => value.rows > 0 || value.digest === TERMINAL_HISTORY_EMPTY_DIGEST,
    "an empty commitment has the empty digest",
  );
export type TerminalDeliveryHistoryCommitment = z.infer<
  typeof TerminalDeliveryHistoryCommitmentSchemaZ
>;

const DeliveryAddressSchemaZ = z.object({
  workspaceName: WorkspaceIdSchemaZ,
  semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
  generation: SessionRuntimeGenerationSchemaZ,
  incarnation: z.string().min(1).max(256),
  deliveryNonce: z.uuid(),
});

export const TerminalDeliveryEnvelopeSchemaZ = DeliveryAddressSchemaZ.extend({
  type: z.literal("terminal.delivery"),
  transactionId: z.uuid(),
  /**
   * Optional diagnostics-only controlled next-output probe id. It never grants
   * authority, is absent while tracing is disabled, and must not be interpreted
   * as general causality: unrelated external tmux output may consume the probe.
   */
  performanceTraceId: z.uuid().optional(),
  /** Finalized diagnostic proof for this exact canonical revision/hash. */
  causalCellProof: CausalCellProofV1SchemaZ.optional(),
  protocolVersion: z.literal(TERMINAL_DELIVERY_PROTOCOL_VERSION),
  encoding: TerminalDeliveryEncodingSchemaZ,
  frame: z.enum(["seed", "patch", "tombstone", "history"]),
  baseRevision: z.number().int().min(-1).nullable(),
  canonicalRevision: z.number().int().nonnegative(),
  canonicalStateHash: z.string().regex(/^[0-9a-f]{16}$/u),
  representationHash: z.string().regex(/^[0-9a-f]{16}$/u),
  representationBytes: z
    .number()
    .int()
    .nonnegative()
    .max(TERMINAL_DELIVERY_MAX_REPRESENTATION_BYTES),
  chunkCount: z.number().int().positive().max(256),
  canonicalEquivalent: z.boolean(),
  history: z.enum(["complete", "partial", "truncated", "not-applicable"]),
  /** Capability 122: the history rows the client does not hold, oldest first. */
  historyUnloaded: TerminalDeliveryHistoryCommitmentSchemaZ.optional(),
  richPlacements: z.boolean(),
})
  .strict()
  .superRefine((value, context) => {
    const semantic =
      value.encoding === "semantic-v1" ||
      value.encoding === "semantic-compact-v1" ||
      value.encoding === "semantic-binary-v1";
    const expectedChunks = Math.max(
      1,
      Math.ceil(value.representationBytes / TERMINAL_DELIVERY_CHUNK_BYTES),
    );
    if (value.chunkCount !== expectedChunks)
      context.addIssue({
        code: "custom",
        message: "chunkCount does not match representationBytes",
      });
    if (value.frame === "seed" && value.baseRevision !== null)
      context.addIssue({ code: "custom", message: "seed baseRevision must be null" });
    if (
      value.frame === "history" &&
      (value.baseRevision !== value.canonicalRevision || value.history !== "partial")
    )
      context.addIssue({
        code: "custom",
        message: "a history frame is partial and stays at the client's revision",
      });
    if (
      value.frame !== "seed" &&
      value.frame !== "history" &&
      (value.baseRevision === null || value.canonicalRevision <= value.baseRevision)
    )
      context.addIssue({
        code: "custom",
        message: "patch/tombstone requires an earlier baseRevision",
      });
    if ((value.history === "partial") !== (value.historyUnloaded !== undefined))
      context.addIssue({
        code: "custom",
        message: "a partial history carries its unloaded commitment, and only it does",
      });
    if (value.history === "partial" && (!semantic || value.frame === "tombstone"))
      context.addIssue({
        code: "custom",
        message: "partial history is semantic and not a tombstone",
      });
    if (
      semantic &&
      (!value.canonicalEquivalent ||
        (value.frame !== "tombstone" &&
          value.history !== "complete" &&
          value.history !== "partial"))
    )
      context.addIssue({
        code: "custom",
        message: "semantic delivery must be complete canonical truth",
      });
    if (semantic && value.frame === "tombstone" && value.history !== "not-applicable")
      context.addIssue({ code: "custom", message: "semantic tombstones have no history" });
    if (!semantic && value.canonicalEquivalent)
      context.addIssue({
        code: "custom",
        message: "ANSI representation cannot claim canonical equivalence",
      });
    if (!semantic && value.richPlacements)
      context.addIssue({ code: "custom", message: "ANSI cannot carry rich placements" });
  });
export type TerminalDeliveryEnvelope = z.infer<typeof TerminalDeliveryEnvelopeSchemaZ>;

export const TerminalDeliveryChunkSchemaZ = z
  .object({
    type: z.literal("terminal.delivery.chunk"),
    transactionId: z.uuid(),
    index: z.number().int().nonnegative().max(255),
    bytes: z
      .instanceof(Uint8Array)
      .refine((value) => value.byteLength <= TERMINAL_DELIVERY_CHUNK_BYTES),
  })
  .strict();
export type TerminalDeliveryChunk = z.infer<typeof TerminalDeliveryChunkSchemaZ>;

export const TerminalDeliveryFaultSchemaZ = z
  .object({
    type: z.literal("terminal.delivery.fault"),
    reason: z.enum(["state-too-large", "source-closed", "protocol-violation"]),
    message: z.string().min(1).max(1024),
    deliveryNonce: z.uuid(),
  })
  .strict();
export type TerminalDeliveryFault = z.infer<typeof TerminalDeliveryFaultSchemaZ>;

export const TerminalDeliveryAckSchemaZ = DeliveryAddressSchemaZ.extend({
  type: z.literal("terminal.delivery.ack"),
  transactionId: z.uuid(),
  canonicalRevision: z.number().int().nonnegative(),
  canonicalStateHash: z.string().regex(/^[0-9a-f]{16}$/u),
  representationHash: z.string().regex(/^[0-9a-f]{16}$/u),
}).strict();
export type TerminalDeliveryAck = z.infer<typeof TerminalDeliveryAckSchemaZ>;

export const TerminalDeliveryNackSchemaZ = DeliveryAddressSchemaZ.extend({
  type: z.literal("terminal.delivery.nack"),
  transactionId: z.uuid().nullable(),
  reason: z.enum([
    "gap",
    "hash-mismatch",
    "decode-failed",
    "state-too-large",
    "stale-generation",
    "protocol-violation",
  ]),
  appliedRevision: z.number().int().min(-1),
}).strict();
export type TerminalDeliveryNack = z.infer<typeof TerminalDeliveryNackSchemaZ>;

/**
 * Capability 122: the client asks for the newest `maxRows` of its unloaded
 * history. It names its committed revision and unloaded row count; a request
 * that no longer matches the daemon's view of that baseline is dropped.
 */
export const TerminalDeliveryHistoryRequestSchemaZ = DeliveryAddressSchemaZ.extend({
  type: z.literal("terminal.delivery.history-request"),
  canonicalRevision: z.number().int().nonnegative(),
  unloadedRows: z.number().int().nonnegative().max(1_000_000),
  maxRows: z.number().int().min(1).max(TERMINAL_DELIVERY_HISTORY_CHUNK_MAX_ROWS),
}).strict();
export type TerminalDeliveryHistoryRequest = z.infer<typeof TerminalDeliveryHistoryRequestSchemaZ>;

export type TerminalDeliveryServerMessage =
  | TerminalDeliveryEnvelope
  | TerminalProjectionEnvelope
  | TerminalDeliveryChunk
  | TerminalDeliveryFault;

export const TerminalDeliveryVisibilitySchemaZ = z.enum([
  "visible",
  "background",
  "hidden",
  "frozen",
]);
export type TerminalDeliveryVisibility = z.infer<typeof TerminalDeliveryVisibilitySchemaZ>;

export const TerminalSemanticDeliveryPayloadSchemaZ = z.discriminatedUnion("frame", [
  z
    .object({
      frame: z.literal("seed"),
      revision: z.number().int().nonnegative(),
      snapshot: TerminalReplicaSnapshotSchemaZ,
    })
    .strict(),
  z
    .object({
      frame: z.literal("patch"),
      baseRevision: z.number().int().nonnegative(),
      revision: z.number().int().nonnegative(),
      patch: TerminalReplicaPatchPayloadSchemaZ,
    })
    .strict()
    .refine((value) => value.revision > value.baseRevision, "patch revision must advance"),
  z
    .object({
      frame: z.literal("tombstone"),
      baseRevision: z.number().int().nonnegative(),
      revision: z.number().int().nonnegative(),
      tombstone: TerminalReplicaTombstonePayloadSchemaZ,
    })
    .strict()
    .refine((value) => value.revision > value.baseRevision, "tombstone revision must advance"),
]);
export type TerminalSemanticDeliveryPayload = z.infer<
  typeof TerminalSemanticDeliveryPayloadSchemaZ
>;

/**
 * Capability 122: a "history" frame's payload, the newest unloaded rows,
 * oldest first, at the client's revision. Kept apart from the seed, patch and
 * tombstone union: it changes no revision and no canonical state.
 */
export const TerminalSemanticHistoryPayloadSchemaZ = z
  .object({
    frame: z.literal("history"),
    revision: z.number().int().nonnegative(),
    rows: z.array(TerminalReplicaRowSchemaZ).min(1).max(TERMINAL_DELIVERY_HISTORY_CHUNK_MAX_ROWS),
  })
  .strict();
export type TerminalSemanticHistoryPayload = z.infer<typeof TerminalSemanticHistoryPayloadSchemaZ>;
