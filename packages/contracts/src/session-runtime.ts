import { z } from "zod";

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

/** Architecture-level contract version. Payload encodings land in m56.2. */
export const SESSION_RUNTIME_CONTRACT_VERSION = 1 as const;

export const SessionRuntimeGenerationSchemaZ = DaemonInstanceIdentitySchemaZ.shape.instanceId;
export type SessionRuntimeGeneration = z.infer<typeof SessionRuntimeGenerationSchemaZ>;

export const TerminalReplicaRevisionSchemaZ = z.number().int().nonnegative();
export type TerminalReplicaRevision = z.infer<typeof TerminalReplicaRevisionSchemaZ>;

export interface TerminalReplicaAddress {
  readonly workspaceName: WorkspaceId;
  readonly semanticPaneId: TerminalAttachmentSemanticPaneId;
}

/** A complete generation-bound renderer seed. Snapshot remains host-neutral. */
export interface TerminalReplicaSeed<Snapshot = unknown> extends TerminalReplicaAddress {
  readonly type: "terminal.seed";
  readonly generation: SessionRuntimeGeneration;
  readonly revision: TerminalReplicaRevision;
  readonly snapshot: Snapshot;
}

/** A patch is valid only against exactly `baseRevision` in the same generation. */
export interface TerminalReplicaPatch<Patch = unknown> extends TerminalReplicaAddress {
  readonly type: "terminal.patch";
  readonly generation: SessionRuntimeGeneration;
  readonly baseRevision: TerminalReplicaRevision;
  readonly revision: TerminalReplicaRevision;
  readonly patch: Patch;
}

export type TerminalReplicaUpdate<Snapshot = unknown, Patch = unknown> =
  | TerminalReplicaSeed<Snapshot>
  | TerminalReplicaPatch<Patch>;

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

export interface SessionRuntimeTerminalSubscription<Snapshot = unknown, Patch = unknown> {
  readonly generation: SessionRuntimeGeneration;
  close(): Promise<void>;
  freeze(): void;
  thaw(): void;
  onUpdate(listener: (update: TerminalReplicaUpdate<Snapshot, Patch>) => void): () => void;
}

/** Client-facing port. Implementations live only in daemon runtime modules. */
export interface SessionRuntimeClientPort<Snapshot = unknown, Patch = unknown> {
  readonly generation: SessionRuntimeGeneration;
  subscribeTerminal(
    target: TerminalReplicaAddress,
  ): Promise<SessionRuntimeTerminalSubscription<Snapshot, Patch>>;
  submitIntent(
    operationId: string,
    intent: SessionRuntimeSemanticIntent,
  ): Promise<WorkspaceMultiplexerMutationResult | void>;
  /** Reuses the one privacy-safe interaction spine; no parallel receipt bus. */
  onReceipt(listener: (receipt: InteractionReceipt) => void): () => void;
}
