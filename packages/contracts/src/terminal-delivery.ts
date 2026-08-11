import { z } from "zod";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "./semantic-identity.ts";
import { SessionRuntimeGenerationSchemaZ } from "./session-runtime.ts";
import { WorkspaceIdSchemaZ } from "./workspace-state.ts";
import {
  TerminalReplicaPatchPayloadSchemaZ,
  TerminalReplicaSnapshotSchemaZ,
  TerminalReplicaTombstonePayloadSchemaZ,
} from "./terminal-replica.ts";

export const TERMINAL_DELIVERY_PROTOCOL_VERSION = 1 as const;
export const TERMINAL_DELIVERY_CHUNK_BYTES = 256 * 1024;
export const TERMINAL_DELIVERY_PATCH_TO_SEED_BYTES = 512 * 1024;
export const TERMINAL_DELIVERY_MAX_REPRESENTATION_BYTES = 16 * 1024 * 1024;

export const TerminalDeliveryEncodingSchemaZ = z.enum([
  "semantic-v1",
  "ansi-diff-v1",
  "ansi-raw-v1",
]);
export type TerminalDeliveryEncoding = z.infer<typeof TerminalDeliveryEncodingSchemaZ>;

export const TerminalDeliveryOfferSchemaZ = z
  .object({
    protocolVersions: z.array(z.number().int().positive()).min(1).max(8),
    encodings: z.array(TerminalDeliveryEncodingSchemaZ).min(1).max(3),
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
    richPlacements: z.boolean(),
    generation: SessionRuntimeGenerationSchemaZ,
    deliveryNonce: z.uuid(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.richPlacements && value.encoding !== "semantic-v1")
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
  protocolVersion: z.literal(TERMINAL_DELIVERY_PROTOCOL_VERSION),
  encoding: TerminalDeliveryEncodingSchemaZ,
  frame: z.enum(["seed", "patch", "tombstone"]),
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
  history: z.enum(["complete", "truncated", "not-applicable"]),
  richPlacements: z.boolean(),
})
  .strict()
  .superRefine((value, context) => {
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
      value.frame !== "seed" &&
      (value.baseRevision === null || value.canonicalRevision <= value.baseRevision)
    )
      context.addIssue({
        code: "custom",
        message: "patch/tombstone requires an earlier baseRevision",
      });
    if (
      value.encoding === "semantic-v1" &&
      (!value.canonicalEquivalent || (value.frame !== "tombstone" && value.history !== "complete"))
    )
      context.addIssue({
        code: "custom",
        message: "semantic delivery must be complete canonical truth",
      });
    if (
      value.encoding === "semantic-v1" &&
      value.frame === "tombstone" &&
      value.history !== "not-applicable"
    )
      context.addIssue({ code: "custom", message: "semantic tombstones have no history" });
    if (value.encoding !== "semantic-v1" && value.canonicalEquivalent)
      context.addIssue({
        code: "custom",
        message: "ANSI representation cannot claim canonical equivalence",
      });
    if (value.encoding !== "semantic-v1" && value.richPlacements)
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

export type TerminalDeliveryServerMessage =
  | TerminalDeliveryEnvelope
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
