import type {
  ActionInput,
  ActionName,
  ActionResult,
  ApplicationShellCommandInvocation,
  ApplicationShellProjectionInputV1,
  ApplicationShellProjectionV1,
  CausalCellProbeRequestV1,
  DesktopApplicationShellTarget,
  InteractionReceipt,
  SessionRuntimeActivityKind,
  SessionRuntimeAuthorityKind,
  SessionRuntimeAuthorityLease,
  SessionRuntimeAuthoritySnapshot,
  SessionRuntimeClientPort,
  SessionRuntimePresenceState,
  SessionRuntimeSemanticIntent,
  SessionRuntimeTerminalInput,
  SessionRuntimeTerminalInputResult,
  TerminalReplicaDeliveryMetadata,
  TerminalReplicaAddress,
  TerminalReplicaUpdate,
  WorkspaceMultiplexerMutationResult,
  WorkspaceOpenCancelledResult,
  WorkspaceOpenCommittedResult,
  WorkspaceOpenPreparedResult,
  TerminalRuntimeInventoryProjectionV1,
} from "@tmux-ide/contracts";

import type {
  ApplicationShellSessionState,
  ApplicationShellTransport,
} from "./application-shell-session.ts";
import type {
  GenerationBoundClock,
  GenerationBoundStoreMetrics,
} from "./generation-bound-store.ts";
import type {
  WorkspaceClientOperationSnapshot,
  WorkspaceClientPendingOperation,
  WorkspaceClientResourceChangeAcknowledgement,
} from "./workspace-client-operations.ts";
import type { WorkspaceCatalogV2State } from "./workspace-catalog-v2.ts";

export type WorkspaceClientScope =
  | "lifecycle"
  | "semantic"
  | "catalog"
  | "authority"
  | "operations";

export type WorkspaceClientPhase =
  | "loading"
  | "live"
  | "stale"
  | "degraded"
  | "unavailable"
  | "error"
  | "disposed";

export interface WorkspaceClientSnapshot<
  Shell extends ApplicationShellProjectionInputV1 = ApplicationShellProjectionInputV1,
> {
  readonly generation: number;
  readonly target: DesktopApplicationShellTarget | null;
  readonly phase: WorkspaceClientPhase;
  readonly shell: ApplicationShellSessionState<Shell>;
  /** Exact validated source value. Additive V2/V3 fields are never erased. */
  readonly authorityShell: Shell | null;
  /** Renderer-neutral semantic projection; contains no terminal framebuffer. */
  readonly semantic: ApplicationShellProjectionV1 | null;
  readonly catalog: WorkspaceCatalogV2State;
  readonly authority: SessionRuntimeAuthoritySnapshot | null;
  readonly operations: WorkspaceClientOperationSnapshot;
}

export type WorkspaceClientScopeValue<
  Shell extends ApplicationShellProjectionInputV1,
  Scope extends WorkspaceClientScope,
> = Scope extends "lifecycle"
  ? Pick<WorkspaceClientSnapshot<Shell>, "generation" | "target" | "phase" | "shell">
  : Scope extends "semantic"
    ? WorkspaceClientSnapshot<Shell>["semantic"]
    : Scope extends "catalog"
      ? WorkspaceClientSnapshot<Shell>["catalog"]
      : Scope extends "authority"
        ? WorkspaceClientSnapshot<Shell>["authority"]
        : WorkspaceClientSnapshot<Shell>["operations"];

export type WorkspaceClientActionDispatch = {
  [Name in ActionName]: {
    readonly kind: "owner-action";
    readonly name: Name;
    readonly input: ActionInput<Name>;
    readonly operationId?: string;
  };
}[ActionName];

export type WorkspaceClientDispatch =
  | { readonly kind: "application-shell"; readonly invocation: ApplicationShellCommandInvocation }
  | {
      readonly kind: "semantic-intent";
      readonly intent: SessionRuntimeSemanticIntent;
      readonly operationId?: string;
    }
  | WorkspaceClientActionDispatch;

export type WorkspaceClientDispatchResult =
  | { readonly kind: "application-shell"; readonly operationId: null }
  | {
      readonly kind: "semantic-intent";
      readonly operationId: string;
      readonly result: WorkspaceMultiplexerMutationResult | void;
    }
  | {
      readonly kind: "owner-action";
      readonly operationId: string;
      readonly result: ActionResult<ActionName> | null;
    };

export interface WorkspaceClientRuntimePort<
  Snapshot = unknown,
  Patch = unknown,
  Tombstone = unknown,
> extends SessionRuntimeClientPort<Snapshot, Patch, Tombstone> {
  /** Settles when the physical runtime lane can no longer carry traffic. */
  readonly closed: Promise<unknown>;
  /**
   * Retire this generation after canonical ingress rejects an admitted update.
   * The supervisor reconnects and obtains fresh seeds; implementations must
   * coalesce repeated requests and fence them to this exact generation.
   */
  requestTerminalRepair?(
    target: TerminalReplicaAddress,
    reason: "gap" | "conflict" | "wrong-address",
  ): void;
  close(): void | Promise<void>;
  /** Fits the one shared physical terminal stream, never a renderer-local replica. */
  fitViewport(cols: number, rows: number): Promise<"ok" | "geometry-authority-conflict">;
  setPresence?(state: SessionRuntimePresenceState): void;
  noteActivity?(activity: SessionRuntimeActivityKind): void;
  ownsConnectionAuthority?(authority: SessionRuntimeAuthorityKind): boolean;
  connectionAuthorityClientId?(authority: SessionRuntimeAuthorityKind): string | null;
  requestAuthority?(
    authority: SessionRuntimeAuthorityKind,
  ): Promise<SessionRuntimeAuthorityLease | null>;
  releaseAuthority?(
    authority: SessionRuntimeAuthorityKind,
  ): Promise<SessionRuntimeAuthoritySnapshot>;
  onAuthority?(listener: (snapshot: SessionRuntimeAuthoritySnapshot) => void): () => void;
}

export interface WorkspaceClientCatalogPort {
  read(target: DesktopApplicationShellTarget, signal: AbortSignal): Promise<unknown>;
  subscribe(target: DesktopApplicationShellTarget, invalidate: () => void): { close(): void };
}

export interface WorkspaceClientOwnerActionPort {
  dispatch<Name extends ActionName>(input: {
    readonly target: DesktopApplicationShellTarget;
    readonly name: Name;
    readonly input: ActionInput<Name>;
    readonly operationId: string;
  }): Promise<ActionResult<Name> | null>;
}

/**
 * Immutable, validated terminal scope for one physical runtime connection.
 * The application-shell authority is the only source of this inventory; hosts
 * must not rediscover or guess panes while opening the runtime lane.
 */
export interface WorkspaceClientRuntimeInventory {
  readonly workspaceName: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly daemonGeneration: string;
  readonly shellGeneration: number;
  /** Present when the dedicated terminal resource, not V2, owns topology. */
  readonly terminalResourceRevision?: number;
  readonly semanticPaneIds: readonly string[];
}

export interface WorkspaceClientPorts<
  Shell extends ApplicationShellProjectionInputV1,
  TerminalSnapshot = unknown,
  TerminalPatch = unknown,
  TerminalTombstone = unknown,
> {
  readonly shell: ApplicationShellTransport<Shell>;
  readonly catalog?: WorkspaceClientCatalogPort;
  readonly connectRuntime: (
    target: DesktopApplicationShellTarget,
    inventory: WorkspaceClientRuntimeInventory,
    signal: AbortSignal,
    /**
     * Owner-scoped preparation capability. Runtime adapters that require
     * subscriptions in order to reach coherence must invoke this before they
     * resolve. Candidate updates remain private until the runtime is activated.
     */
    prepare: (
      runtime: WorkspaceClientRuntimePort<TerminalSnapshot, TerminalPatch, TerminalTombstone>,
    ) => Promise<void>,
  ) => Promise<WorkspaceClientRuntimePort<TerminalSnapshot, TerminalPatch, TerminalTombstone>>;
  /** Renderer-local adoption hook invoked only after a coherent candidate wins. */
  readonly didActivateRuntime?: (
    runtime: WorkspaceClientRuntimePort<TerminalSnapshot, TerminalPatch, TerminalTombstone>,
    inventory: WorkspaceClientRuntimeInventory,
  ) => void;
  /** The exact active runtime left live state while its supervisor reconnects. */
  readonly didSuspendRuntime?: (
    runtime: WorkspaceClientRuntimePort<TerminalSnapshot, TerminalPatch, TerminalTombstone>,
  ) => void;
  /** Called only when no active runtime remains (empty inventory/target retirement). */
  readonly didRetireRuntime?: () => void;
  /** Presentation inventory disagreed with the newer terminal authority. */
  readonly requestTerminalRuntimeInventoryRefresh?: () => void;
  readonly actions: WorkspaceClientOwnerActionPort;
}

export interface WorkspaceClientOptions<
  Shell extends ApplicationShellProjectionInputV1 = ApplicationShellProjectionInputV1,
  TerminalSnapshot = unknown,
  TerminalPatch = unknown,
  TerminalTombstone = unknown,
> {
  readonly target: DesktopApplicationShellTarget;
  readonly ports: WorkspaceClientPorts<Shell, TerminalSnapshot, TerminalPatch, TerminalTombstone>;
  readonly clock?: GenerationBoundClock;
  readonly operationId?: () => string;
  readonly operationTimeoutMs?: number;
  /** OpenTUI starts V2 only after terminal adoption or an explicit fallback decision. */
  readonly deferApplicationShell?: boolean;
}

export interface WorkspaceClient<
  Shell extends ApplicationShellProjectionInputV1 = ApplicationShellProjectionInputV1,
  TerminalSnapshot = unknown,
  TerminalPatch = unknown,
  TerminalTombstone = unknown,
> {
  getSnapshot(): WorkspaceClientSnapshot<Shell>;
  /** Metrics of the one application-shell resource owned by this client. */
  getMetrics(): GenerationBoundStoreMetrics;
  subscribe<Scope extends WorkspaceClientScope>(
    scope: Scope,
    listener: (value: WorkspaceClientScopeValue<Shell, Scope>) => void,
  ): () => void;
  /** Retires the previous target completely before this promise settles. */
  setTarget(target: DesktopApplicationShellTarget): Promise<void>;
  refresh(): void;
  /** Adopt/update the dedicated ongoing topology authority for this local generation. */
  adoptTerminalRuntimeInventory(resource: TerminalRuntimeInventoryProjectionV1): boolean;
  /** Old-daemon fallback: V2 resumes its historical topology authority. */
  startApplicationShellFallback(): void;
  dispatch(command: WorkspaceClientDispatch): Promise<WorkspaceClientDispatchResult>;
  subscribeTerminal(
    target: TerminalReplicaAddress,
    listener: (
      update: TerminalReplicaUpdate<TerminalSnapshot, TerminalPatch, TerminalTombstone>,
      metadata?: TerminalReplicaDeliveryMetadata,
    ) => void,
  ): () => void;
  requestTerminalRepair(
    target: TerminalReplicaAddress,
    expectedDaemonGeneration: string,
    reason: "gap" | "conflict" | "wrong-address",
  ): void;
  sendTerminalInput(
    target: TerminalReplicaAddress,
    input: SessionRuntimeTerminalInput,
    performanceTraceId?: string,
    causalProbe?: CausalCellProbeRequestV1,
  ): Promise<SessionRuntimeTerminalInputResult>;
  fitViewport(
    cols: number,
    rows: number,
  ): Promise<"ok" | "authority-lost" | "geometry-authority-conflict">;
  setPresence(state: SessionRuntimePresenceState): void;
  noteActivity(activity: SessionRuntimeActivityKind): void;
  ownsRuntimeAuthority?(authority: SessionRuntimeAuthorityKind): boolean;
  runtimeAuthorityClientId?(authority: SessionRuntimeAuthorityKind): string | null;
  requestAuthority(
    authority: SessionRuntimeAuthorityKind,
  ): Promise<SessionRuntimeAuthorityLease | null>;
  releaseAuthority(
    authority: SessionRuntimeAuthorityKind,
  ): Promise<SessionRuntimeAuthoritySnapshot | null>;
  /** Retires every runtime supervisor and settles physical transport cleanup. */
  dispose(): Promise<void>;
}

export type WorkspaceOpenActionResult =
  | WorkspaceOpenPreparedResult
  | WorkspaceOpenCommittedResult
  | WorkspaceOpenCancelledResult;

export type {
  InteractionReceipt,
  WorkspaceClientPendingOperation,
  WorkspaceClientResourceChangeAcknowledgement,
  GenerationBoundClock,
};
