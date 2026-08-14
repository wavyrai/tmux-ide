import type {
  ActionInput,
  ActionName,
  ActionResult,
  ApplicationShellCommandInvocation,
  ApplicationShellProjectionInputV1,
  ApplicationShellProjectionV1,
  DesktopApplicationShellTarget,
  InteractionReceipt,
  SessionRuntimeActivityKind,
  SessionRuntimeAuthorityKind,
  SessionRuntimeAuthorityLease,
  SessionRuntimeAuthoritySnapshot,
  SessionRuntimeClientPort,
  SessionRuntimePresenceState,
  SessionRuntimeSemanticIntent,
  TerminalReplicaAddress,
  TerminalReplicaUpdate,
  WorkspaceMultiplexerMutationResult,
  WorkspaceOpenCancelledResult,
  WorkspaceOpenCommittedResult,
  WorkspaceOpenPreparedResult,
} from "@tmux-ide/contracts";

import type {
  ApplicationShellSessionState,
  ApplicationShellTransport,
} from "./application-shell-session.ts";
import type { GenerationBoundClock } from "./generation-bound-store.ts";
import type {
  WorkspaceClientOperationSnapshot,
  WorkspaceClientPendingOperation,
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
> extends SessionRuntimeClientPort<Snapshot, Patch> {
  /** Settles when the physical runtime lane can no longer carry traffic. */
  readonly closed: Promise<unknown>;
  close(): void | Promise<void>;
  setPresence?(state: SessionRuntimePresenceState): void;
  noteActivity?(activity: SessionRuntimeActivityKind): void;
  requestAuthority?(
    authority: SessionRuntimeAuthorityKind,
  ): Promise<SessionRuntimeAuthorityLease | null>;
  releaseAuthority?(authority: SessionRuntimeAuthorityKind): Promise<void>;
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

export interface WorkspaceClientPorts<
  Shell extends ApplicationShellProjectionInputV1,
  TerminalSnapshot = unknown,
  TerminalPatch = unknown,
> {
  readonly shell: ApplicationShellTransport<Shell>;
  readonly catalog?: WorkspaceClientCatalogPort;
  readonly connectRuntime: (
    target: DesktopApplicationShellTarget,
    signal: AbortSignal,
  ) => Promise<WorkspaceClientRuntimePort<TerminalSnapshot, TerminalPatch>>;
  readonly actions: WorkspaceClientOwnerActionPort;
}

export interface WorkspaceClientOptions<
  Shell extends ApplicationShellProjectionInputV1 = ApplicationShellProjectionInputV1,
  TerminalSnapshot = unknown,
  TerminalPatch = unknown,
> {
  readonly target: DesktopApplicationShellTarget;
  readonly ports: WorkspaceClientPorts<Shell, TerminalSnapshot, TerminalPatch>;
  readonly clock?: GenerationBoundClock;
  readonly operationId?: () => string;
  readonly operationTimeoutMs?: number;
}

export interface WorkspaceClient<
  Shell extends ApplicationShellProjectionInputV1 = ApplicationShellProjectionInputV1,
  TerminalSnapshot = unknown,
  TerminalPatch = unknown,
> {
  getSnapshot(): WorkspaceClientSnapshot<Shell>;
  subscribe<Scope extends WorkspaceClientScope>(
    scope: Scope,
    listener: (value: WorkspaceClientScopeValue<Shell, Scope>) => void,
  ): () => void;
  setTarget(target: DesktopApplicationShellTarget): void;
  refresh(): void;
  dispatch(command: WorkspaceClientDispatch): Promise<WorkspaceClientDispatchResult>;
  subscribeTerminal(
    target: TerminalReplicaAddress,
    listener: (update: TerminalReplicaUpdate<TerminalSnapshot, TerminalPatch>) => void,
  ): () => void;
  setPresence(state: SessionRuntimePresenceState): void;
  noteActivity(activity: SessionRuntimeActivityKind): void;
  requestAuthority(
    authority: SessionRuntimeAuthorityKind,
  ): Promise<SessionRuntimeAuthorityLease | null>;
  releaseAuthority(authority: SessionRuntimeAuthorityKind): Promise<void>;
  dispose(): void;
}

export type WorkspaceOpenActionResult =
  | WorkspaceOpenPreparedResult
  | WorkspaceOpenCommittedResult
  | WorkspaceOpenCancelledResult;

export type { InteractionReceipt, WorkspaceClientPendingOperation, GenerationBoundClock };
