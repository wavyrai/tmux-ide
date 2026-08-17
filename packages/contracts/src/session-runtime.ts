import { z } from "zod";
import type { CausalCellProbeRequestV1, CausalCellProofV1 } from "./causal-cell.ts";

import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";
import {
  AuthoredInteractionOriginSchemaZ,
  type InteractionReceipt,
} from "./interaction-receipts.ts";
import {
  TerminalAttachmentSemanticPaneIdSchemaZ,
  type TerminalAttachmentSemanticPaneId,
} from "./semantic-identity.ts";
import {
  WorkspaceMultiplexerIntentSchemaZ,
  type WorkspaceMultiplexerMutationResult,
} from "./workspace-multiplexer.ts";
import { WorkspaceIdSchemaZ, type WorkspaceId } from "./workspace-state.ts";
import type {
  TerminalReplicaPatchPayload,
  TerminalReplicaSnapshot,
  TerminalReplicaTombstonePayload,
} from "./terminal-replica.ts";
import {
  TerminalReplicaPatchPayloadSchemaZ,
  TerminalReplicaSnapshotSchemaZ,
  TerminalReplicaTombstonePayloadSchemaZ,
} from "./terminal-replica.ts";

/** Architecture-level contract version. Payload encodings land in m56.2. */
export const SESSION_RUNTIME_CONTRACT_VERSION = 1 as const;

export const SessionRuntimeGenerationSchemaZ = DaemonInstanceIdentitySchemaZ.shape.instanceId;
export type SessionRuntimeGeneration = z.infer<typeof SessionRuntimeGenerationSchemaZ>;

/** Stable authenticated product-client identity; never a renderer-local pane address. */
export const SessionRuntimeClientIdSchemaZ = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\0\r\n]/u.test(value));
export type SessionRuntimeClientId = z.infer<typeof SessionRuntimeClientIdSchemaZ>;

const SessionRuntimeSessionNameSchemaZ = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\0\r\n]/u.test(value));

export const SessionRuntimeControllerRoleSchemaZ = z.enum(["controller", "viewer"]);
export type SessionRuntimeControllerRole = z.infer<typeof SessionRuntimeControllerRoleSchemaZ>;

/** One generation- and revision-pinned capability for both input and geometry. */
export const SessionRuntimeControllerLeaseSchemaZ = z
  .object({
    generation: SessionRuntimeGenerationSchemaZ,
    session: SessionRuntimeSessionNameSchemaZ,
    clientId: SessionRuntimeClientIdSchemaZ,
    token: z.uuid(),
    revision: z.number().int().positive(),
  })
  .strict();
export type SessionRuntimeControllerLease = z.infer<typeof SessionRuntimeControllerLeaseSchemaZ>;

export const SessionRuntimeControllerSnapshotSchemaZ = z
  .object({
    generation: SessionRuntimeGenerationSchemaZ,
    session: SessionRuntimeSessionNameSchemaZ,
    controllerClientId: SessionRuntimeClientIdSchemaZ.nullable(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type SessionRuntimeControllerSnapshot = z.infer<
  typeof SessionRuntimeControllerSnapshotSchemaZ
>;

/**
 * Independent client capabilities. A client being able to type must not make
 * it the geometry or shared-focus owner as a side effect.
 */
export const SessionRuntimeAuthorityKindSchemaZ = z.enum(["input", "focus", "geometry"]);
export type SessionRuntimeAuthorityKind = z.infer<typeof SessionRuntimeAuthorityKindSchemaZ>;

export const SessionRuntimeClientSurfaceSchemaZ = z.enum([
  "web",
  "opentui",
  "cli",
  "sdk",
  "native-tmux",
  "unknown",
]);
export type SessionRuntimeClientSurface = z.infer<typeof SessionRuntimeClientSurfaceSchemaZ>;

export const SessionRuntimePresenceStateSchemaZ = z.enum(["foreground", "background"]);
export type SessionRuntimePresenceState = z.infer<typeof SessionRuntimePresenceStateSchemaZ>;

export const SessionRuntimeActivityKindSchemaZ = z.enum([
  "heartbeat",
  "input",
  "focus",
  "geometry",
]);
export type SessionRuntimeActivityKind = z.infer<typeof SessionRuntimeActivityKindSchemaZ>;

/**
 * Canonical renderer-neutral terminal input. Text and named keys stay
 * distinct all the way to the tmux adapter: control keys are never smuggled
 * through an arbitrary byte/string lane.
 */
export const SESSION_RUNTIME_MAX_TERMINAL_INPUT_TEXT_CHARS = 1024;

export const SessionRuntimeTerminalKeyNameSchemaZ = z
  .string()
  .regex(
    /^(?:C-|M-|S-){0,3}(?:F1[0-2]|F[1-9]|Enter|Escape|Space|Tab|BTab|BSpace|Home|End|NPage|PPage|PgUp|PgDn|DC|IC|Up|Down|Left|Right|[A-Za-z0-9])$/u,
  );

export const SessionRuntimeTerminalTextInputSchemaZ = z
  .object({
    kind: z.literal("text"),
    data: z
      .string()
      .min(1)
      .max(SESSION_RUNTIME_MAX_TERMINAL_INPUT_TEXT_CHARS)
      .refine((value) => !value.includes("\0"), "terminal input text must not contain NUL"),
  })
  .strict();

export const SessionRuntimeTerminalKeyInputSchemaZ = z
  .object({
    kind: z.literal("key"),
    data: SessionRuntimeTerminalKeyNameSchemaZ,
  })
  .strict();

export const SessionRuntimeTerminalInputSchemaZ = z.discriminatedUnion("kind", [
  SessionRuntimeTerminalTextInputSchemaZ,
  SessionRuntimeTerminalKeyInputSchemaZ,
]);
export type SessionRuntimeTerminalInput = z.infer<typeof SessionRuntimeTerminalInputSchemaZ>;
export type SessionRuntimeTerminalInputResult = "ok" | "authority-lost";

/** A generation-fenced capability for exactly one authority kind. */
export const SessionRuntimeAuthorityLeaseSchemaZ = z
  .object({
    generation: SessionRuntimeGenerationSchemaZ,
    session: SessionRuntimeSessionNameSchemaZ,
    clientId: SessionRuntimeClientIdSchemaZ,
    authority: SessionRuntimeAuthorityKindSchemaZ,
    token: z.uuid(),
    revision: z.number().int().positive(),
  })
  .strict();
export type SessionRuntimeAuthorityLease = z.infer<typeof SessionRuntimeAuthorityLeaseSchemaZ>;

export const SessionRuntimeClientPresenceSchemaZ = z
  .object({
    clientId: SessionRuntimeClientIdSchemaZ,
    surface: SessionRuntimeClientSurfaceSchemaZ,
    state: SessionRuntimePresenceStateSchemaZ,
    connectedRevision: z.number().int().positive(),
    activityRevision: z.number().int().nonnegative(),
  })
  .strict();
export type SessionRuntimeClientPresence = z.infer<typeof SessionRuntimeClientPresenceSchemaZ>;

export const SessionRuntimeAuthoritySnapshotSchemaZ = z
  .object({
    generation: SessionRuntimeGenerationSchemaZ,
    session: SessionRuntimeSessionNameSchemaZ,
    revision: z.number().int().nonnegative(),
    owners: z
      .object({
        input: SessionRuntimeClientIdSchemaZ.nullable(),
        focus: SessionRuntimeClientIdSchemaZ.nullable(),
        geometry: SessionRuntimeClientIdSchemaZ.nullable(),
      })
      .strict(),
    nativeGeometryYieldUntilMs: z.number().nonnegative(),
    clients: z.array(SessionRuntimeClientPresenceSchemaZ),
  })
  .strict();
export type SessionRuntimeAuthoritySnapshot = z.infer<
  typeof SessionRuntimeAuthoritySnapshotSchemaZ
>;

export const TerminalReplicaRevisionSchemaZ = z.number().int().nonnegative();
export type TerminalReplicaRevision = z.infer<typeof TerminalReplicaRevisionSchemaZ>;

export interface TerminalReplicaAddress {
  readonly workspaceName: WorkspaceId;
  readonly semanticPaneId: TerminalAttachmentSemanticPaneId;
}

export interface TerminalReplicaFrameMetadata {
  readonly incarnation: string;
  readonly cols: number;
  readonly rows: number;
  readonly stateHash: string;
  readonly hashAlgorithm: "fnv1a64-v1";
}

export const TerminalReplicaFrameMetadataSchemaZ = z
  .object({
    workspaceName: WorkspaceIdSchemaZ,
    semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
    generation: SessionRuntimeGenerationSchemaZ,
    incarnation: z.string().min(1).max(256),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    stateHash: z.string().regex(/^[0-9a-f]{16}$/u),
    hashAlgorithm: z.literal("fnv1a64-v1"),
  })
  .strict();

/** A complete generation-bound renderer seed. Snapshot remains host-neutral. */
export interface TerminalReplicaSeed<Snapshot = unknown>
  extends TerminalReplicaAddress, TerminalReplicaFrameMetadata {
  readonly type: "terminal.seed";
  readonly generation: SessionRuntimeGeneration;
  readonly revision: TerminalReplicaRevision;
  readonly snapshot: Snapshot;
}

/** A patch is valid only against exactly `baseRevision` in the same generation. */
export interface TerminalReplicaPatch<Patch = unknown>
  extends TerminalReplicaAddress, TerminalReplicaFrameMetadata {
  readonly type: "terminal.patch";
  readonly generation: SessionRuntimeGeneration;
  readonly baseRevision: TerminalReplicaRevision;
  readonly revision: TerminalReplicaRevision;
  readonly patch: Patch;
}

export interface TerminalReplicaTombstone<Tombstone = unknown>
  extends TerminalReplicaAddress, TerminalReplicaFrameMetadata {
  readonly type: "terminal.tombstone";
  readonly generation: SessionRuntimeGeneration;
  readonly baseRevision: TerminalReplicaRevision;
  readonly revision: TerminalReplicaRevision;
  readonly tombstone: Tombstone;
}

export type TerminalReplicaUpdate<Snapshot = unknown, Patch = unknown, Tombstone = unknown> =
  | TerminalReplicaSeed<Snapshot>
  | TerminalReplicaPatch<Patch>
  | TerminalReplicaTombstone<Tombstone>;

export type CanonicalTerminalReplicaSeed = TerminalReplicaSeed<TerminalReplicaSnapshot>;
export type CanonicalTerminalReplicaPatch = TerminalReplicaPatch<TerminalReplicaPatchPayload>;
export type CanonicalTerminalReplicaTombstone =
  TerminalReplicaTombstone<TerminalReplicaTombstonePayload>;
export type CanonicalTerminalReplicaUpdate =
  | CanonicalTerminalReplicaSeed
  | CanonicalTerminalReplicaPatch
  | CanonicalTerminalReplicaTombstone;

/**
 * Observational delivery context that is intentionally excluded from replica
 * identity and hashing. A renderer may consume the trace once when the
 * corresponding canonical state first paints.
 */
export interface TerminalReplicaDeliveryMetadata {
  readonly performanceTraceId?: string;
  readonly causalCellProof?: CausalCellProofV1;
}

export const CanonicalTerminalReplicaSeedSchemaZ = TerminalReplicaFrameMetadataSchemaZ.extend({
  type: z.literal("terminal.seed"),
  revision: TerminalReplicaRevisionSchemaZ,
  snapshot: TerminalReplicaSnapshotSchemaZ,
}).strict();
export const CanonicalTerminalReplicaPatchSchemaZ = TerminalReplicaFrameMetadataSchemaZ.extend({
  type: z.literal("terminal.patch"),
  baseRevision: TerminalReplicaRevisionSchemaZ,
  revision: TerminalReplicaRevisionSchemaZ,
  patch: TerminalReplicaPatchPayloadSchemaZ,
}).strict();
export const CanonicalTerminalReplicaTombstoneSchemaZ = TerminalReplicaFrameMetadataSchemaZ.extend({
  type: z.literal("terminal.tombstone"),
  baseRevision: TerminalReplicaRevisionSchemaZ,
  revision: TerminalReplicaRevisionSchemaZ,
  tombstone: TerminalReplicaTombstonePayloadSchemaZ,
}).strict();
export const CanonicalTerminalReplicaUpdateSchemaZ = z.discriminatedUnion("type", [
  CanonicalTerminalReplicaSeedSchemaZ,
  CanonicalTerminalReplicaPatchSchemaZ,
  CanonicalTerminalReplicaTombstoneSchemaZ,
]);

export const SessionRuntimePaneReadIntentSchemaZ = z
  .object({
    verb: z.literal("workspace.pane.read"),
    workspaceName: WorkspaceIdSchemaZ,
    semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
    origin: AuthoredInteractionOriginSchemaZ,
  })
  .strict();
export type SessionRuntimePaneReadIntent = z.infer<typeof SessionRuntimePaneReadIntentSchemaZ>;

/** The only intents a client may submit: semantic identity, never tmux addresses. */
export const SessionRuntimeSemanticIntentSchemaZ = z.union([
  WorkspaceMultiplexerIntentSchemaZ,
  SessionRuntimePaneReadIntentSchemaZ,
]);
export type SessionRuntimeSemanticIntent = z.infer<typeof SessionRuntimeSemanticIntentSchemaZ>;

export interface SessionRuntimeTerminalSubscription<
  Snapshot = unknown,
  Patch = unknown,
  Tombstone = unknown,
> {
  readonly generation: SessionRuntimeGeneration;
  close(): Promise<void>;
  freeze(): void;
  thaw(): void;
  onUpdate(
    listener: (
      update: TerminalReplicaUpdate<Snapshot, Patch, Tombstone>,
      metadata?: TerminalReplicaDeliveryMetadata,
    ) => void,
  ): () => void;
}

/** Client-facing port. Implementations live only in daemon runtime modules. */
export interface SessionRuntimeClientPort<
  Snapshot = unknown,
  Patch = unknown,
  Tombstone = unknown,
> {
  readonly generation: SessionRuntimeGeneration;
  subscribeTerminal(
    target: TerminalReplicaAddress,
  ): Promise<SessionRuntimeTerminalSubscription<Snapshot, Patch, Tombstone>>;
  submitIntent(
    operationId: string,
    intent: SessionRuntimeSemanticIntent,
  ): Promise<WorkspaceMultiplexerMutationResult | void>;
  /** One acknowledged, generation-bound write through the canonical input lane. */
  sendTerminalInput(
    target: TerminalReplicaAddress,
    input: SessionRuntimeTerminalInput,
    performanceTraceId?: string,
    causalProbe?: CausalCellProbeRequestV1,
  ): Promise<SessionRuntimeTerminalInputResult>;
  /** Reuses the one privacy-safe interaction spine; no parallel receipt bus. */
  onReceipt(listener: (receipt: InteractionReceipt) => void): () => void;
}
