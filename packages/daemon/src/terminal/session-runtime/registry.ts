import {
  SessionRuntimeClientIdSchemaZ,
  SessionRuntimeControllerLeaseSchemaZ,
  SessionRuntimeGenerationSchemaZ,
  SessionRuntimeSemanticIntentSchemaZ,
  SessionRuntimeTerminalInputSchemaZ,
  CausalCellProbeV1SchemaZ,
  type AuthoredInteractionOrigin,
  type InteractionReceipt,
  type SessionRuntimeControllerLease,
  type SessionRuntimeControllerRole,
  type SessionRuntimeControllerSnapshot,
  type SessionRuntimeActivityKind,
  type SessionRuntimeAuthorityKind,
  type SessionRuntimeAuthorityLease,
  type SessionRuntimeAuthoritySnapshot,
  type SessionRuntimePresenceState,
  type SessionRuntimeGeneration,
  type SessionRuntimeSemanticIntent,
  type SessionRuntimeTerminalInput,
  type CanonicalTerminalReplicaUpdate,
  type CausalCellFailureReasonV1,
  type CausalCellProbeV1,
  type TerminalDeliveryAck,
  type TerminalDeliveryNack,
  type TerminalDeliveryOffer,
  type TerminalDeliveryServerMessage,
  type TerminalDeliveryVisibility,
} from "@tmux-ide/contracts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  MirrorLayoutEvent,
  MirrorPaneEvent,
  MirrorSessionDescription,
} from "../mirror/events.ts";
import {
  MirrorService,
  type MirrorServiceOptions,
  type MirrorSubscribeRequest,
  type MirrorSubscription,
} from "../mirror/mirror-service.ts";
import type { PaneStreamMirror } from "../pane-stream/pane-stream-websocket.ts";
import {
  SessionSemanticMutationExecutor,
  type SessionRuntimeIntentResult,
  type SessionRuntimeTmuxObservation,
  type SessionSemanticMutationExecutorOptions,
  type SessionSemanticMutationMetrics,
} from "./semantic-mutation-executor.ts";
import {
  SessionRuntimeTerminalReplicaOwner,
  type TerminalReplicaQualificationSnapshot,
  type TerminalReplicaSubscription,
} from "./terminal-replica-owner.ts";
import {
  SessionRuntimeTerminalDeliveryHub,
  type TerminalDeliveryConnection,
  type TerminalDeliveryConvergenceSnapshot,
  type TerminalDeliveryMetrics,
} from "./terminal-delivery-hub.ts";
import {
  SYSTEM_SESSION_RUNTIME_SCHEDULER,
  type SessionRuntimeScheduler,
} from "./runtime-scheduler.ts";
import {
  DISABLED_SESSION_RUNTIME_OBSERVABILITY,
  type SessionRuntimeObservability,
  type SessionRuntimeObservabilitySnapshot,
  type SessionRuntimeTraceContext,
} from "./runtime-observability.ts";
import { RuntimeTraceCorrelator } from "./runtime-trace-correlator.ts";
import type { MirrorOutputTiming } from "../mirror/control-channel.ts";
import type { TrustedMirrorSessionInventory } from "../mirror/trusted-inventory.ts";
import { SessionRuntimeAuthorityArbiter } from "./authority-arbiter.ts";
import type { CausalCellLedgerResult } from "./causal-cell-ledger.ts";

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).then(
      () => signal.removeEventListener("abort", onAbort),
      () => signal.removeEventListener("abort", onAbort),
    );
  });
}

export interface SessionRuntimeRegistryOptions {
  readonly generation: string;
  readonly mirror?: MirrorServiceOptions;
  readonly semanticMutations?: SessionSemanticMutationExecutorOptions;
  /** Deterministic seam for lease tests. Production uses cryptographic UUIDs. */
  readonly createControllerToken?: () => string;
  /** Native terminal activity quiet period before tmux-ide may size again. */
  readonly nativeGeometryHysteresisMs?: number;
  readonly scheduler?: SessionRuntimeScheduler;
  readonly observability?: SessionRuntimeObservability;
  /** Deterministic qualification seam; never invoked while observability is disabled. */
  readonly createTraceCorrelator?: (scheduler: SessionRuntimeScheduler) => RuntimeTraceCorrelator;
}

/** Opaque daemon-internal proof that an inventory came from one exact runtime owner. */
export interface TrustedSessionInventoryCandidate {
  readonly inventory: TrustedMirrorSessionInventory;
  readonly token: object;
}

export interface SessionRuntimeQualificationSnapshot {
  readonly generation: SessionRuntimeGeneration;
  readonly controlChannels: number;
  readonly controllerLeases: number;
  readonly sessions: readonly {
    readonly session: string;
    readonly consumers: number;
    readonly retained: boolean;
    readonly delivery: TerminalDeliveryMetrics;
    readonly convergence: TerminalDeliveryConvergenceSnapshot;
    readonly replicas: Readonly<Record<string, TerminalReplicaQualificationSnapshot>>;
  }[];
  readonly mutations: SessionSemanticMutationMetrics | null;
  readonly observability: SessionRuntimeObservabilitySnapshot;
}

export type {
  SessionRuntimeControllerLease,
  SessionRuntimeControllerRole,
  SessionRuntimeControllerSnapshot,
} from "@tmux-ide/contracts";

function authoredOriginForSurface(surface: string): AuthoredInteractionOrigin {
  if (surface === "opentui") return "tui";
  if (surface === "command-center") return "sdk";
  if (surface === "cli") return "cli";
  return "gui";
}

export type SessionRuntimeControllerLeaseErrorCode =
  | "controller-conflict"
  | "controller-target-unavailable"
  | "stale-controller-lease"
  | "invalid-client-capability"
  | "invalid-source-pane-binding"
  | "intent-session-mismatch";

export class SessionRuntimeControllerLeaseError extends Error {
  constructor(
    readonly code: SessionRuntimeControllerLeaseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionRuntimeControllerLeaseError";
  }
}

export interface SessionRuntimeConsumer {
  readonly generation: SessionRuntimeGeneration;
  readonly session: string;
  readonly surface: string;
  readonly clientId: string;
  controllerRole(): SessionRuntimeControllerRole;
  controllerSnapshot(): SessionRuntimeControllerSnapshot;
  authoritySnapshot(): SessionRuntimeAuthoritySnapshot;
  onAuthoritySnapshot(listener: (snapshot: SessionRuntimeAuthoritySnapshot) => void): () => void;
  updatePresence(state: SessionRuntimePresenceState): void;
  noteActivity(activity: SessionRuntimeActivityKind): void;
  acquireAuthority(authority: SessionRuntimeAuthorityKind): SessionRuntimeAuthorityLease | null;
  releaseAuthority(authority: SessionRuntimeAuthorityKind): void;
  acquireController(): SessionRuntimeControllerLease;
  handoffController(
    lease: SessionRuntimeControllerLease,
    targetClientId: string,
  ): SessionRuntimeControllerLease;
  releaseController(lease: SessionRuntimeControllerLease): void;
  submitIntent(
    lease: SessionRuntimeControllerLease,
    operationId: string,
    intent: SessionRuntimeSemanticIntent,
  ): Promise<SessionRuntimeIntentResult>;
  sendInput(
    lease: SessionRuntimeControllerLease,
    semanticPaneId: string,
    input: SessionRuntimeTerminalInput,
    performanceTraceId?: string,
    causalProbe?: CausalCellProbeV1,
    onCausalResult?: (result: CausalCellLedgerResult) => void,
  ): void;
  failCausalCellProbe(
    semanticPaneId: string,
    traceId: string,
    reason: CausalCellFailureReasonV1,
  ): void;
  fitViewport(lease: SessionRuntimeControllerLease, cols: number, rows: number): void;
  describe(): Promise<MirrorSessionDescription>;
  subscribe(
    semanticPaneId: string,
    onEvent: (event: MirrorPaneEvent) => void,
    onLayout?: (event: MirrorLayoutEvent) => void,
  ): Promise<MirrorSubscription>;
  subscribeReplica(
    semanticPaneId: string,
    onUpdate: (update: CanonicalTerminalReplicaUpdate) => void,
  ): Promise<TerminalReplicaSubscription>;
  openTerminalDelivery(
    deliverySubscriberId: string,
    semanticPaneId: string,
    offer: TerminalDeliveryOffer,
    onMessage: (message: TerminalDeliveryServerMessage) => void | Promise<void>,
  ): Promise<TerminalDeliveryConnection>;
  close(): Promise<void>;
}

/**
 * Trusted, in-process execution proof. Transport redemption or another daemon
 * host boundary retains it; HTTP request bodies can never construct authority
 * merely by matching this shape because every opaque token is checked against
 * the live registry generation and consumer.
 */
export type SessionRuntimeExecutionHandle = object;

interface ExecutionHandleState {
  readonly runtime: SessionRuntime;
  readonly consumer: SessionRuntimeConsumerImpl;
  readonly lease: SessionRuntimeControllerLease;
  readonly allowedSourcePaneIds: ReadonlySet<string>;
  readonly sourceSemanticPaneId: string | null;
  readonly authorizeLiveScope: ((semanticPaneId?: string) => void) | null;
}

/**
 * One daemon-generation lifecycle owner for every discovered tmux session.
 *
 * A session runtime retains the canonical MirrorService channel independently
 * of its GUI/TUI/SDK consumers. Consumer departure therefore cannot churn the
 * tmux control client. A channel exit invalidates only that retention; the next
 * operation rebuilds it through the same registry and generation without
 * starting, stopping, or otherwise owning the tmux server process.
 */
export class SessionRuntimeRegistry implements PaneStreamMirror {
  readonly generation: SessionRuntimeGeneration;
  readonly #mirror: MirrorService;
  readonly #semanticMutations: SessionSemanticMutationExecutor | null;
  readonly #resolveSession: ((workspaceName: string) => string | null) | null;
  readonly #createControllerToken: () => string;
  readonly #nativeGeometryHysteresisMs: number | undefined;
  readonly #scheduler: SessionRuntimeScheduler;
  readonly #observability: SessionRuntimeObservability;
  readonly #createTraceCorrelator: (scheduler: SessionRuntimeScheduler) => RuntimeTraceCorrelator;
  readonly #sessions = new Map<string, SessionRuntime>();
  readonly #proofPrewarmOwnership = new Map<SessionRuntime, { owned: boolean; claims: number }>();
  readonly #trustedInventoryTokens = new WeakMap<object, SessionRuntime>();
  readonly #executionHandles = new WeakMap<object, ExecutionHandleState>();
  readonly #stopExitObserver: () => void;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  constructor(options: SessionRuntimeRegistryOptions) {
    this.generation = SessionRuntimeGenerationSchemaZ.parse(options.generation);
    this.#scheduler = options.scheduler ?? SYSTEM_SESSION_RUNTIME_SCHEDULER;
    this.#observability = options.observability ?? DISABLED_SESSION_RUNTIME_OBSERVABILITY;
    this.#createTraceCorrelator =
      options.createTraceCorrelator ?? ((scheduler) => new RuntimeTraceCorrelator(scheduler));
    const diagnosticMirrorOptions: Partial<MirrorServiceOptions> = {
      onInputAccepted: (session, action, acceptedAtMicros, ok) => {
        for (const traceId of action.traceIds ?? []) {
          this.#sessions.get(session)?.noteInputControlReply(traceId, ok);
          if (!this.#observability.enabled) continue;
          const trace = this.#observability.beginTrace(
            "terminal-input-to-paint",
            { generation: this.generation, incarnation: null },
            traceId,
          );
          this.#observability.recordSpan(
            "tmux",
            ok ? "control-command-accepted" : "control-command-rejected",
            acceptedAtMicros,
            acceptedAtMicros,
            trace,
          );
        }
      },
      ...(this.#observability.enabled
        ? {
            nowMicros: () => this.#observability.nowMicros(),
            onInputWrite: (_session, action, startedAtMicros, endedAtMicros, pendingBeforeSend) => {
              for (const traceId of action.traceIds ?? []) {
                const trace = this.#observability.beginTrace(
                  "terminal-input-to-paint",
                  { generation: this.generation, incarnation: null },
                  traceId,
                );
                this.#observability.recordSpan(
                  "tmux",
                  "control-write",
                  startedAtMicros,
                  endedAtMicros,
                  trace,
                );
                this.#observability.recordSpan(
                  "tmux",
                  pendingBeforeSend === 0
                    ? "control-queue-empty-at-send"
                    : "control-queue-nonempty-at-send",
                  endedAtMicros,
                  endedAtMicros,
                  trace,
                );
              }
            },
          }
        : {}),
    };
    const observeOutput =
      this.#observability.enabled || options.mirror?.onOutputObserved
        ? (
            session: string,
            semanticPaneId: string,
            ageMs: number | null,
            timing?: MirrorOutputTiming,
          ) => {
            options.mirror?.onOutputObserved?.(session, semanticPaneId, ageMs, timing);
            if (this.#observability.enabled)
              this.#sessions.get(session)?.noteOutputObserved(semanticPaneId, ageMs, timing);
          }
        : undefined;
    this.#mirror = new MirrorService({
      ...options.mirror,
      ...diagnosticMirrorOptions,
      onNativeClientActivity: (session) => {
        options.mirror?.onNativeClientActivity?.(session);
        this.#sessions.get(session)?.noteNativeGeometryActivity();
      },
      ...(observeOutput ? { onOutputObserved: observeOutput } : {}),
    });
    this.#semanticMutations = options.semanticMutations
      ? new SessionSemanticMutationExecutor({
          ...options.semanticMutations,
          scheduler: options.semanticMutations.scheduler ?? this.#scheduler,
          observability: options.semanticMutations.observability ?? this.#observability,
        })
      : null;
    this.#resolveSession = options.semanticMutations?.resolveSession ?? null;
    this.#createControllerToken = options.createControllerToken ?? randomUUID;
    this.#nativeGeometryHysteresisMs = options.nativeGeometryHysteresisMs;
    this.#stopExitObserver = this.#mirror.onSessionExit((session) => {
      this.#sessions.get(session)?.noteControlExit();
    });
  }

  connect(session: string, surface: string, clientId: string): SessionRuntimeConsumer {
    return this.#runtime(session).connect(surface, SessionRuntimeClientIdSchemaZ.parse(clientId));
  }

  /**
   * Start the daemon-owned tmux control channel before a renderer asks for a
   * pane-stream ticket. This uses the exact same SessionRuntime subsequently
   * consumed by admission, so prewarming cannot weaken pane enumeration or
   * create a second control authority.
   */
  async prewarmSession(session: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const runtime = this.#runtime(session);
    await abortable(runtime.whenReady(), signal);
    if (this.#sessions.get(session) !== runtime) {
      throw new Error(`SessionRuntime ${session} was retired while prewarming`);
    }
  }

  /**
   * Mark the exact retained runtime as eligible for daemon-private inventory.
   * This is intentionally separate from ordinary renderer prewarming: only
   * the native discovery path may call it after its parser and global catalog
   * analyzer proved the session attachable.
   */
  async prewarmProofQualifiedSession(
    session: string,
    runtimeSessionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!/^\$(?:0|[1-9][0-9]*)$/u.test(runtimeSessionId)) {
      throw new Error(`SessionRuntime ${session} received an invalid runtime session identity`);
    }
    let runtime = this.#acquireProofPrewarmRuntime(session);
    try {
      await this.#observeTerminalAttempt(
        "terminal-prewarm-readiness",
        abortable(runtime.whenReady(), signal),
      );
      if (this.#sessions.get(session) !== runtime) {
        throw new Error(`SessionRuntime ${session} was retired while qualifying inventory`);
      }
      let attachedIdentity = await this.#observeTerminalAttempt(
        "terminal-attached-identity",
        abortable(runtime.attachedSessionIdentity(), signal),
      );
      if (attachedIdentity?.runtimeSessionId !== runtimeSessionId) {
        if (this.#sessions.get(session) === runtime) this.#sessions.delete(session);
        await abortable(runtime.dispose(), signal);
        this.#releaseProofPrewarmRuntime(runtime);
        signal?.throwIfAborted();
        runtime = this.#acquireProofPrewarmRuntime(session);
        await this.#observeTerminalAttempt(
          "terminal-prewarm-readiness",
          abortable(runtime.whenReady(), signal),
        );
        if (this.#sessions.get(session) !== runtime) {
          throw new Error(`SessionRuntime ${session} was retired while replacing inventory`);
        }
        attachedIdentity = await this.#observeTerminalAttempt(
          "terminal-attached-identity",
          abortable(runtime.attachedSessionIdentity(), signal),
        );
      }
      if (
        attachedIdentity?.sessionName !== session ||
        attachedIdentity.runtimeSessionId !== runtimeSessionId
      ) {
        throw new Error(`SessionRuntime ${session} is attached to a different tmux identity`);
      }
      signal?.throwIfAborted();
      runtime.qualifyTrustedInventory(runtimeSessionId);
    } finally {
      this.#releaseProofPrewarmRuntime(runtime);
    }
  }

  /** Daemon-internal only. Runtime tmux ids in the result must never cross wire. */
  async describeTrustedSessionInventory(
    session: string,
    signal?: AbortSignal,
  ): Promise<TrustedMirrorSessionInventory> {
    return (await this.describeTrustedSessionInventoryCandidate(session, signal)).inventory;
  }

  /**
   * Return an opaque token bound to the exact runtime that produced the
   * inventory. Consumers must revalidate it after their final await.
   */
  async describeTrustedSessionInventoryCandidate(
    session: string,
    signal?: AbortSignal,
  ): Promise<TrustedSessionInventoryCandidate> {
    signal?.throwIfAborted();
    if (this.#disposed) throw new Error("SessionRuntimeRegistry is disposed");
    const runtime = this.#sessions.get(session);
    if (!runtime?.trustedInventoryQualified()) {
      throw new Error(`SessionRuntime ${session} has no proof-qualified inventory authority`);
    }
    const inventory = await this.#observeTerminalAttempt(
      "terminal-trusted-inventory-attempt",
      abortable(runtime.describeTrustedInventory(), signal),
    );
    if (this.#sessions.get(session) !== runtime || !runtime.trustedInventoryQualified()) {
      throw new Error(`SessionRuntime ${session} changed during trusted inventory discovery`);
    }
    if (!inventory) {
      throw new Error(`SessionRuntime ${session} lost its retained inventory authority`);
    }
    const token = Object.freeze({});
    this.#trustedInventoryTokens.set(token, runtime);
    return Object.freeze({ inventory, token });
  }

  isTrustedSessionInventoryCandidateCurrent(session: string, token: object): boolean {
    if (this.#disposed) return false;
    const runtime = this.#trustedInventoryTokens.get(token);
    return (
      runtime !== undefined &&
      this.#sessions.get(session) === runtime &&
      runtime.trustedInventoryQualified()
    );
  }

  hasProofQualifiedInventory(session: string): boolean {
    return (
      (this.#sessions.get(session)?.trustedInventoryQualified() ?? false) &&
      this.#mirror.hasRetainedSession(session)
    );
  }

  /** Retire one no-longer-registered session without disturbing siblings. */
  async retireSession(session: string): Promise<void> {
    const runtime = this.#sessions.get(session);
    if (!runtime) return;
    this.#sessions.delete(session);
    await runtime.dispose();
  }

  createExecutionHandle(
    consumer: SessionRuntimeConsumer,
    lease: SessionRuntimeControllerLease,
    allowedSourcePaneIds: readonly string[],
    authorizeLiveScope?: (semanticPaneId?: string) => void,
  ): SessionRuntimeExecutionHandle {
    const runtime = this.#sessions.get(consumer.session);
    if (!runtime || !runtime.ownsConsumer(consumer)) {
      throw new SessionRuntimeControllerLeaseError(
        "invalid-client-capability",
        "The execution handle consumer is not owned by this daemon generation.",
      );
    }
    runtime.assertController(lease, consumer.clientId);
    const handle = Object.freeze(Object.create(null)) as object;
    this.#executionHandles.set(handle, {
      runtime,
      consumer: consumer as SessionRuntimeConsumerImpl,
      lease,
      allowedSourcePaneIds: new Set(allowedSourcePaneIds),
      sourceSemanticPaneId: null,
      authorizeLiveScope: authorizeLiveScope ?? null,
    });
    return handle;
  }

  bindExecutionSource(
    handle: SessionRuntimeExecutionHandle,
    semanticPaneId: string,
  ): SessionRuntimeExecutionHandle {
    const state = this.#assertExecutionHandle(handle, semanticPaneId);
    const bound = Object.freeze(Object.create(null)) as object;
    this.#executionHandles.set(bound, { ...state, sourceSemanticPaneId: semanticPaneId });
    return bound;
  }

  assertExecutionHandle(handle: SessionRuntimeExecutionHandle, semanticPaneId?: string): void {
    this.#assertExecutionHandle(handle, semanticPaneId);
  }

  /** Execute one send as a separately authenticated local tmux-pane principal. */
  submitPaneCredentialIntent(
    session: string,
    operationId: string,
    rawIntent: SessionRuntimeSemanticIntent,
    semanticPaneId: string,
    authorizeBeforeEffect?: () => void,
  ): Promise<SessionRuntimeIntentResult> {
    const intent = SessionRuntimeSemanticIntentSchemaZ.parse(rawIntent);
    if (intent.verb !== "workspace.pane.send") {
      return Promise.reject(new Error("Pane credentials authorize pane sends only"));
    }
    if ((this.#resolveSession?.(intent.workspaceName) ?? null) !== session) {
      return Promise.reject(
        new SessionRuntimeControllerLeaseError(
          "intent-session-mismatch",
          "The pane credential intent does not belong to its authenticated session.",
        ),
      );
    }
    if (!this.#semanticMutations) {
      return Promise.reject(new Error("Session semantic mutations are unavailable"));
    }
    return this.#semanticMutations.submit(
      operationId,
      { ...intent, sourceSemanticPaneId: semanticPaneId },
      {
        origin: "cli",
        authenticatedSourceSemanticPaneId: semanticPaneId,
        authorizeBeforeEffect,
      },
    );
  }

  submitAuthenticatedIntent(
    handle: SessionRuntimeExecutionHandle,
    operationId: string,
    intent: SessionRuntimeSemanticIntent,
  ): Promise<SessionRuntimeIntentResult> {
    let state: ExecutionHandleState;
    try {
      state = this.#assertExecutionHandle(handle);
    } catch (error) {
      return Promise.reject(error);
    }
    let authenticatedSourceSemanticPaneId: string | null = null;
    let normalizedIntent = SessionRuntimeSemanticIntentSchemaZ.parse(intent);
    if (normalizedIntent.verb === "workspace.pane.send") {
      if (state.sourceSemanticPaneId !== null) {
        if (
          normalizedIntent.sourceSemanticPaneId !== undefined &&
          normalizedIntent.sourceSemanticPaneId !== state.sourceSemanticPaneId
        ) {
          return Promise.reject(
            new SessionRuntimeControllerLeaseError(
              "invalid-source-pane-binding",
              "The claimed source pane does not match the authenticated transport binding.",
            ),
          );
        }
        authenticatedSourceSemanticPaneId = state.sourceSemanticPaneId;
        normalizedIntent = {
          ...normalizedIntent,
          sourceSemanticPaneId: state.sourceSemanticPaneId,
        };
      } else {
        const sourceLess = { ...normalizedIntent };
        delete sourceLess.sourceSemanticPaneId;
        normalizedIntent = sourceLess;
      }
    }
    return this.#submitAuthorizedIntent(
      state.runtime,
      state.lease,
      operationId,
      normalizedIntent,
      authenticatedSourceSemanticPaneId,
      () => this.#assertExecutionHandle(handle, state.sourceSemanticPaneId ?? undefined),
      authoredOriginForSurface(state.consumer.surface),
    );
  }

  #assertExecutionHandle(
    handle: SessionRuntimeExecutionHandle,
    semanticPaneId?: string,
  ): ExecutionHandleState {
    const state = this.#executionHandles.get(handle);
    if (!state) {
      throw new SessionRuntimeControllerLeaseError(
        "invalid-client-capability",
        "The opaque execution handle is invalid for this daemon generation.",
      );
    }
    state.runtime.assertController(state.lease, state.consumer.clientId);
    if (semanticPaneId !== undefined && !state.allowedSourcePaneIds.has(semanticPaneId)) {
      throw new SessionRuntimeControllerLeaseError(
        "invalid-source-pane-binding",
        "The source pane is outside this transport's exact daemon grant.",
      );
    }
    state.authorizeLiveScope?.(semanticPaneId);
    return state;
  }

  async describeSession(session: string): Promise<MirrorSessionDescription> {
    return await this.#runtime(session).describe();
  }

  async subscribe(request: MirrorSubscribeRequest): Promise<MirrorSubscription> {
    const runtime = this.#runtime(request.session);
    await runtime.whenReady();
    return await this.#mirror.subscribe(request);
  }

  #submitAuthorizedIntent(
    runtime: SessionRuntime,
    lease: SessionRuntimeControllerLease,
    operationId: string,
    rawIntent: SessionRuntimeSemanticIntent,
    authenticatedSourceSemanticPaneId: string | null = null,
    authorizeBeforeEffect?: () => void,
    authenticatedOrigin?: AuthoredInteractionOrigin,
  ): Promise<SessionRuntimeIntentResult> {
    if (this.#disposed) return Promise.reject(new Error("SessionRuntimeRegistry is disposed"));
    runtime.assertController(lease);
    let intent = SessionRuntimeSemanticIntentSchemaZ.parse(rawIntent);
    const resolvedSession = this.#resolveSession?.(intent.workspaceName) ?? null;
    if (resolvedSession !== runtime.session) {
      return Promise.reject(
        new SessionRuntimeControllerLeaseError(
          "intent-session-mismatch",
          "The semantic intent does not belong to the controller lease session.",
        ),
      );
    }
    if (intent.verb === "workspace.pane.send") {
      if (authenticatedSourceSemanticPaneId === null) {
        // The owner bearer and a request-body pane id are not source proof.
        const sourceLess = { ...intent };
        delete sourceLess.sourceSemanticPaneId;
        intent = sourceLess;
      }
    }
    if (!this.#semanticMutations) {
      return Promise.reject(new Error("Session semantic mutations are unavailable"));
    }
    return this.#semanticMutations.submit(operationId, intent, {
      origin: authenticatedOrigin ?? "sdk",
      authenticatedSourceSemanticPaneId,
      authorizeBeforeEffect,
    });
  }

  observeTmuxInteraction(observation: SessionRuntimeTmuxObservation): boolean {
    return this.#semanticMutations?.observe(observation) ?? false;
  }

  onReceipt(listener: (receipt: InteractionReceipt) => void): () => void {
    return this.#semanticMutations?.onReceipt(listener) ?? (() => undefined);
  }

  sessionCount(): number {
    return this.#sessions.size;
  }

  activeControlChannelCount(): number {
    return this.#mirror.activeChannelCount();
  }

  activeControllerLeaseCount(): number {
    let count = 0;
    for (const runtime of this.#sessions.values()) {
      if (runtime.hasController()) count += 1;
    }
    return count;
  }

  authoritySnapshot(session: string): SessionRuntimeAuthoritySnapshot {
    return this.#runtime(session).authoritySnapshot();
  }

  /** Native client activity makes an existing daemon runtime size-passive. */
  noteNativeGeometryActivity(session: string): void {
    this.#sessions.get(session)?.noteNativeGeometryActivity();
  }

  qualificationSnapshot(): SessionRuntimeQualificationSnapshot {
    return Object.freeze({
      generation: this.generation,
      controlChannels: this.activeControlChannelCount(),
      controllerLeases: this.activeControllerLeaseCount(),
      sessions: Object.freeze(
        [...this.#sessions.values()].map((runtime) => runtime.qualificationSnapshot()),
      ),
      mutations: this.#semanticMutations?.metrics() ?? null,
      observability: this.#observability.snapshot(),
    });
  }

  dispose(): Promise<void> {
    if (!this.#disposePromise) {
      this.#disposed = true;
      this.#stopExitObserver();
      this.#disposePromise = (async () => {
        await this.#semanticMutations?.dispose();
        await Promise.allSettled([...this.#sessions.values()].map((runtime) => runtime.dispose()));
        this.#sessions.clear();
        this.#proofPrewarmOwnership.clear();
        await this.#mirror.dispose();
      })();
    }
    return this.#disposePromise;
  }

  #runtime(session: string): SessionRuntime {
    if (this.#disposed) throw new Error("SessionRuntimeRegistry is disposed");
    const existing = this.#sessions.get(session);
    if (existing) {
      const ownership = this.#proofPrewarmOwnership.get(existing);
      if (ownership) ownership.owned = false;
      return existing;
    }
    const runtime: SessionRuntime = new SessionRuntime(
      this.generation,
      session,
      this.#mirror,
      this.#createControllerToken,
      this.#scheduler,
      this.#observability,
      this.#createTraceCorrelator,
      this.#nativeGeometryHysteresisMs,
      (
        owner,
        lease,
        operationId,
        intent,
        origin,
        authorizeBeforeEffect,
      ): Promise<SessionRuntimeIntentResult> =>
        this.#submitAuthorizedIntent(
          owner,
          lease,
          operationId,
          intent,
          null,
          authorizeBeforeEffect,
          origin,
        ),
    );
    this.#sessions.set(session, runtime);
    return runtime;
  }

  #acquireProofPrewarmRuntime(session: string): SessionRuntime {
    const existing = this.#sessions.get(session);
    const runtime = existing ?? this.#runtime(session);
    const ownership = this.#proofPrewarmOwnership.get(runtime);
    if (ownership) ownership.claims += 1;
    else this.#proofPrewarmOwnership.set(runtime, { owned: existing === undefined, claims: 1 });
    return runtime;
  }

  #releaseProofPrewarmRuntime(runtime: SessionRuntime): void {
    const ownership = this.#proofPrewarmOwnership.get(runtime);
    if (!ownership) return;
    ownership.claims -= 1;
    if (ownership.claims > 0) return;
    this.#proofPrewarmOwnership.delete(runtime);
    if (
      !ownership.owned ||
      this.#sessions.get(runtime.session) !== runtime ||
      runtime.hasConsumers() ||
      runtime.trustedInventoryQualified()
    ) {
      return;
    }
    this.#sessions.delete(runtime.session);
    void runtime.dispose().catch(() => undefined);
  }

  async #observeTerminalAttempt<Value>(operation: string, promise: Promise<Value>): Promise<Value> {
    if (!this.#observability.enabled) return promise;
    let startedAtMicros: number;
    try {
      startedAtMicros = this.#observability.nowMicros();
    } catch {
      return promise;
    }
    try {
      return await promise;
    } finally {
      try {
        this.#observability.recordSpan(
          "transport",
          operation,
          startedAtMicros,
          this.#observability.nowMicros(),
        );
      } catch {
        // Diagnostics never change qualification success or failure.
      }
    }
  }
}

class SessionRuntime {
  readonly #mirror: MirrorService;
  readonly #consumers = new Set<SessionRuntimeConsumerImpl>();
  readonly #consumersByClientId = new Map<string, SessionRuntimeConsumerImpl>();
  readonly #terminalReplicas = new Map<string, SessionRuntimeTerminalReplicaOwner>();
  readonly #terminalReplicaClocks = new Map<string, { epoch: number; revision: number }>();
  #outputTraces: RuntimeTraceCorrelator | null;
  readonly #outputObservations = new Map<
    string,
    { readonly ageMs: number | null; readonly timing?: MirrorOutputTiming }
  >();
  readonly #createTraceCorrelator: (scheduler: SessionRuntimeScheduler) => RuntimeTraceCorrelator;
  readonly #terminalDeliveryHub: SessionRuntimeTerminalDeliveryHub;
  readonly #authority: SessionRuntimeAuthorityArbiter;
  readonly #authorityListeners = new Set<(snapshot: SessionRuntimeAuthoritySnapshot) => void>();
  readonly #scheduler: SessionRuntimeScheduler;
  readonly #observability: SessionRuntimeObservability;
  readonly #createControllerToken: () => string;
  readonly #submitAuthorized: (
    runtime: SessionRuntime,
    lease: SessionRuntimeControllerLease,
    operationId: string,
    intent: SessionRuntimeSemanticIntent,
    origin: AuthoredInteractionOrigin,
    authorizeBeforeEffect: () => void,
  ) => Promise<SessionRuntimeIntentResult>;
  #retention: Awaited<ReturnType<MirrorService["retainSession"]>> | null = null;
  #startPromise: Promise<void> | null = null;
  #restartBarrier: Promise<void> = Promise.resolve();
  #controllerClientId: string | null = null;
  #controllerToken: string | null = null;
  #controllerRevision = 0;
  readonly #completedHandoffs = new Map<string, SessionRuntimeControllerLease>();
  readonly #releasedLeases = new Set<string>();
  #disposed = false;
  #trustedInventoryRuntimeSessionId: string | null = null;
  #activeCausalCellProbes = 0;

  constructor(
    readonly generation: SessionRuntimeGeneration,
    readonly session: string,
    mirror: MirrorService,
    createControllerToken: () => string,
    scheduler: SessionRuntimeScheduler,
    observability: SessionRuntimeObservability,
    createTraceCorrelator: (scheduler: SessionRuntimeScheduler) => RuntimeTraceCorrelator,
    nativeGeometryHysteresisMs: number | undefined,
    submitAuthorized: (
      runtime: SessionRuntime,
      lease: SessionRuntimeControllerLease,
      operationId: string,
      intent: SessionRuntimeSemanticIntent,
      origin: AuthoredInteractionOrigin,
      authorizeBeforeEffect: () => void,
    ) => Promise<SessionRuntimeIntentResult>,
  ) {
    this.#mirror = mirror;
    this.#scheduler = scheduler;
    this.#createTraceCorrelator = createTraceCorrelator;
    this.#outputTraces = observability.enabled ? createTraceCorrelator(scheduler) : null;
    this.#observability = observability;
    this.#createControllerToken = createControllerToken;
    this.#submitAuthorized = submitAuthorized;
    this.#authority = new SessionRuntimeAuthorityArbiter({
      generation,
      session,
      scheduler,
      nativeGeometryHysteresisMs,
      onGeometryAuthorityChanged: (clientId) =>
        this.#mirror.setGeometryParticipation(this.session, clientId !== null),
      onNativeGeometryYieldExpired: () => this.#publishAuthority(),
    });
    this.#terminalDeliveryHub = new SessionRuntimeTerminalDeliveryHub(
      generation,
      session,
      (semanticPaneId) => this.#terminalReplicaOwner(semanticPaneId),
      { scheduler, observability },
    );
  }

  connect(surface: string, clientId: string): SessionRuntimeConsumer {
    if (this.#disposed) throw new Error(`SessionRuntime ${this.session} is disposed`);
    if (this.#consumersByClientId.has(clientId)) {
      throw new TypeError(`SessionRuntime client ${clientId} is already connected`);
    }
    const consumer = new SessionRuntimeConsumerImpl(this, surface, clientId);
    this.#consumers.add(consumer);
    this.#consumersByClientId.set(clientId, consumer);
    this.#authority.connect(clientId, surface);
    return consumer;
  }

  controllerRole(clientId: string): SessionRuntimeControllerRole {
    return this.#controllerClientId === clientId ? "controller" : "viewer";
  }

  controllerSnapshot(): SessionRuntimeControllerSnapshot {
    return {
      generation: this.generation,
      session: this.session,
      controllerClientId: this.#controllerClientId,
      revision: this.#controllerRevision,
    };
  }

  authoritySnapshot(): SessionRuntimeAuthoritySnapshot {
    return this.#authority.snapshot();
  }

  updatePresence(clientId: string, state: SessionRuntimePresenceState): void {
    this.#authority.updatePresence(clientId, state);
    this.#publishAuthority();
  }

  noteActivity(clientId: string, activity: SessionRuntimeActivityKind): void {
    this.#authority.noteActivity(clientId, activity);
    this.#publishAuthority();
  }

  acquireAuthority(
    clientId: string,
    authority: SessionRuntimeAuthorityKind,
  ): SessionRuntimeAuthorityLease | null {
    if (authority === "input" && this.#controllerClientId !== clientId) {
      // Input's executable proof is the compatibility controller lease. The
      // transport synchronization seam must establish/handoff it first.
      return null;
    }
    const lease = this.#authority.claim(clientId, authority);
    this.#publishAuthority();
    return lease;
  }

  releaseAuthority(clientId: string, authority: SessionRuntimeAuthorityKind): void {
    if (authority === "input" && this.#controllerClientId === clientId) {
      throw new SessionRuntimeControllerLeaseError(
        "invalid-client-capability",
        "Release the executable controller before releasing input authority.",
      );
    }
    this.#authority.release(clientId, authority);
    this.#publishAuthority();
  }

  noteNativeGeometryActivity(): void {
    this.#authority.noteNativeGeometryActivity();
    this.#publishAuthority();
  }

  onAuthoritySnapshot(listener: (snapshot: SessionRuntimeAuthoritySnapshot) => void): () => void {
    this.#authorityListeners.add(listener);
    return () => this.#authorityListeners.delete(listener);
  }

  ownsConsumer(candidate: SessionRuntimeConsumer): boolean {
    return this.#consumers.has(candidate as SessionRuntimeConsumerImpl);
  }

  hasController(): boolean {
    return this.#controllerClientId !== null;
  }

  hasConsumers(): boolean {
    return this.#consumers.size > 0;
  }

  qualificationSnapshot(): SessionRuntimeQualificationSnapshot["sessions"][number] {
    return Object.freeze({
      session: this.session,
      consumers: this.#consumers.size,
      retained: this.#retention !== null,
      delivery: this.#terminalDeliveryHub.metrics(),
      convergence: this.#terminalDeliveryHub.convergenceSnapshot(),
      replicas: Object.freeze(
        Object.fromEntries(
          [...this.#terminalReplicas.entries()].map(([paneId, owner]) => [
            paneId,
            owner.qualificationSnapshot(),
          ]),
        ),
      ),
    });
  }

  acquireController(clientId: string): SessionRuntimeControllerLease {
    this.#assertConnected(clientId);
    if (this.#controllerClientId === clientId) {
      this.#authority.updatePresence(clientId, "foreground");
      this.#authority.claim(clientId, "input");
      return this.#currentLease();
    }
    if (this.#controllerClientId !== null) {
      throw new SessionRuntimeControllerLeaseError(
        "controller-conflict",
        `Session ${this.session} already has a controller.`,
      );
    }
    // Compatibility adapter for v1 clients: the historical controller means
    // input authority only. Geometry is acquired lazily by fitViewport and
    // shared focus is never implied by interactivity.
    this.#authority.updatePresence(clientId, "foreground");
    this.#authority.claim(clientId, "input");
    return this.#assignController(clientId);
  }

  handoffController(
    callerClientId: string,
    lease: SessionRuntimeControllerLease,
    targetClientId: string,
  ): SessionRuntimeControllerLease {
    const candidate = this.#validatedLease(lease);
    const parsedTarget = SessionRuntimeClientIdSchemaZ.parse(targetClientId);
    const replayKey = this.#handoffKey(candidate, parsedTarget);
    const replay = this.#completedHandoffs.get(replayKey);
    if (replay && candidate.clientId === callerClientId) {
      if (this.#consumersByClientId.has(parsedTarget) && this.#isCurrentControllerLease(replay)) {
        return replay;
      }
      throw new SessionRuntimeControllerLeaseError(
        "stale-controller-lease",
        "The replayed handoff no longer names the current connected controller.",
      );
    }
    this.assertController(candidate, callerClientId);
    if (!this.#consumersByClientId.has(parsedTarget)) {
      throw new SessionRuntimeControllerLeaseError(
        "controller-target-unavailable",
        "The handoff target is not connected to this session runtime.",
      );
    }
    if (parsedTarget === this.#controllerClientId) return this.#currentLease();
    this.#authority.release(callerClientId, "input");
    this.#authority.release(callerClientId, "geometry");
    this.#authority.updatePresence(callerClientId, "background");
    this.#authority.updatePresence(parsedTarget, "foreground");
    this.#authority.claim(parsedTarget, "input");
    const handedOff = this.#assignController(parsedTarget);
    this.#completedHandoffs.set(replayKey, handedOff);
    if (this.#completedHandoffs.size > 32) {
      this.#completedHandoffs.delete(this.#completedHandoffs.keys().next().value!);
    }
    return handedOff;
  }

  releaseController(callerClientId: string, lease: SessionRuntimeControllerLease): void {
    const candidate = this.#validatedLease(lease);
    const releaseKey = this.#leaseKey(candidate);
    if (this.#releasedLeases.has(releaseKey) && candidate.clientId === callerClientId) return;
    this.assertController(candidate, callerClientId);
    this.#releasedLeases.add(releaseKey);
    if (this.#releasedLeases.size > 32) {
      this.#releasedLeases.delete(this.#releasedLeases.values().next().value!);
    }
    this.#clearController();
    this.#authority.release(callerClientId, "input");
    this.#authority.release(callerClientId, "geometry");
  }

  assertController(lease: SessionRuntimeControllerLease, callerClientId?: string): void {
    const parsedLease = this.#validatedLease(lease);
    if (
      parsedLease.generation !== this.generation ||
      parsedLease.session !== this.session ||
      (callerClientId !== undefined && parsedLease.clientId !== callerClientId) ||
      parsedLease.clientId !== this.#controllerClientId ||
      parsedLease.token !== this.#controllerToken ||
      parsedLease.revision !== this.#controllerRevision
    ) {
      throw new SessionRuntimeControllerLeaseError(
        "stale-controller-lease",
        "The controller lease is stale or belongs to another session generation.",
      );
    }
  }

  submitIntent(
    callerClientId: string,
    lease: SessionRuntimeControllerLease,
    operationId: string,
    intent: SessionRuntimeSemanticIntent,
  ): Promise<SessionRuntimeIntentResult> {
    try {
      this.assertController(lease, callerClientId);
      const surface = this.#consumersByClientId.get(callerClientId)?.surface;
      if (surface === undefined) throw new Error("Session runtime consumer disappeared");
      return this.#submitAuthorized(
        this,
        lease,
        operationId,
        intent,
        authoredOriginForSurface(surface),
        () => this.assertController(lease, callerClientId),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  sendInput(
    clientId: string,
    lease: SessionRuntimeControllerLease,
    semanticPaneId: string,
    rawInput: SessionRuntimeTerminalInput,
    performanceTraceId?: string,
    rawCausalProbe?: CausalCellProbeV1,
    onCausalResult?: (result: CausalCellLedgerResult) => void,
  ): void {
    this.assertController(lease, clientId);
    const inputLease = this.#authority.leaseFor(clientId, "input");
    if (!inputLease) {
      throw new SessionRuntimeControllerLeaseError(
        "stale-controller-lease",
        "The client no longer owns input authority.",
      );
    }
    const input = SessionRuntimeTerminalInputSchemaZ.parse(rawInput);
    if (performanceTraceId !== undefined) performanceTraceId = z.uuid().parse(performanceTraceId);
    const causalProbe =
      rawCausalProbe === undefined ? null : CausalCellProbeV1SchemaZ.parse(rawCausalProbe);
    if (causalProbe) {
      if (
        causalProbe.traceId !== performanceTraceId ||
        causalProbe.clientId !== clientId ||
        causalProbe.semanticPaneId !== semanticPaneId ||
        causalProbe.generation !== this.generation
      )
        throw new Error("Causal-cell authority binding mismatch");
      if (!onCausalResult) throw new Error("Causal-cell result sink is required");
      if (this.#activeCausalCellProbes >= 16) throw new Error("Causal-cell capacity exhausted");
    }
    const trace: SessionRuntimeTraceContext | null = performanceTraceId
      ? Object.freeze({
          traceId: performanceTraceId,
          scenario: "terminal-input-to-paint",
          authority: { generation: this.generation, incarnation: null },
        })
      : this.#observability.enabled
        ? this.#observability.beginTrace("terminal-input-to-paint", {
            generation: this.generation,
            incarnation: null,
          })
        : null;
    const started = this.#observability.enabled ? this.#observability.nowMicros() : 0;
    const replicaOwner = this.#terminalReplicaOwner(semanticPaneId);
    if (causalProbe) {
      this.#activeCausalCellProbes += 1;
      let settled = false;
      try {
        replicaOwner.armCausalCellProbe(causalProbe, (result) => {
          if (!settled) {
            settled = true;
            this.#activeCausalCellProbes -= 1;
          }
          onCausalResult!(result);
        });
      } catch (error) {
        this.#activeCausalCellProbes -= 1;
        throw error;
      }
    }
    if (trace && performanceTraceId) {
      this.#outputTraces ??= this.#createTraceCorrelator(this.#scheduler);
      replicaOwner.installOutputTraceReader(() => this.#takeOutputTrace(semanticPaneId));
      this.#outputTraces.arm(semanticPaneId, trace);
    }
    try {
      if (input.kind === "text")
        this.#mirror.sendText(
          this.session,
          semanticPaneId,
          input.data,
          performanceTraceId,
          causalProbe !== null,
        );
      else this.#mirror.sendKey(this.session, semanticPaneId, input.data, performanceTraceId);
      // Admission succeeded. Arm one product write independently of optional
      // qualification traces; rejected control writes must never affect the
      // parser's next unrelated output.
      replicaOwner.prioritizeNextWrite();
    } catch (error) {
      if (causalProbe) replicaOwner.failCausalCell("transport-closed");
      if (trace && performanceTraceId) this.#outputTraces?.take(semanticPaneId);
      throw error;
    }
    if (this.#observability.enabled)
      this.#observability.recordSpan(
        "tmux",
        "raw-input-command",
        started,
        this.#observability.nowMicros(),
        trace,
      );
    if (this.#observability.enabled && trace && performanceTraceId) {
      const scheduledAt = this.#observability.nowMicros();
      setImmediate(() => {
        this.#observability.recordSpan(
          "transport",
          "daemon-event-loop-turn",
          scheduledAt,
          this.#observability.nowMicros(),
          trace,
        );
      });
    }
  }

  failCausalCellProbe(
    semanticPaneId: string,
    traceId: string,
    reason: CausalCellFailureReasonV1,
  ): void {
    this.#terminalReplicas.get(semanticPaneId)?.failCausalCell(reason, traceId);
  }

  noteInputControlReply(traceId: string, ok: boolean): void {
    for (const owner of this.#terminalReplicas.values())
      owner.noteCausalCellControlReply(traceId, ok);
  }

  /**
   * Synchronous control-reader seam. SessionChannel invokes this immediately
   * before feeding the same output bytes to the terminal replica owner, so a
   * subsequent trace take observes timing for that exact output publication.
   */
  noteOutputObserved(
    semanticPaneId: string,
    ageMs: number | null,
    timing?: MirrorOutputTiming,
  ): void {
    if (!this.#observability.enabled) return;
    this.#outputObservations.set(
      semanticPaneId,
      Object.freeze({ ageMs, ...(timing ? { timing } : {}) }),
    );
  }

  fitViewport(
    clientId: string,
    lease: SessionRuntimeControllerLease,
    cols: number,
    rows: number,
  ): void {
    this.assertController(lease, clientId);
    const geometryLease =
      this.#authority.leaseFor(clientId, "geometry") ?? this.#authority.claim(clientId, "geometry");
    if (!geometryLease) {
      throw new SessionRuntimeControllerLeaseError(
        "invalid-client-capability",
        "The client is not the foreground geometry authority.",
      );
    }
    this.#mirror.setGeometryParticipation(this.session, true);
    this.#mirror.fitViewport(this.session, cols, rows);
  }

  async whenReady(): Promise<void> {
    if (this.#disposed) throw new Error(`SessionRuntime ${this.session} is disposed`);
    if (!this.#startPromise) {
      this.#startPromise = (async () => {
        await this.#restartBarrier;
        if (this.#disposed) throw new Error(`SessionRuntime ${this.session} is disposed`);
        const retention = await this.#mirror.retainSession(this.session);
        if (this.#disposed) {
          await retention.close();
          throw new Error(`SessionRuntime ${this.session} is disposed`);
        }
        this.#retention = retention;
      })().catch((error) => {
        this.#startPromise = null;
        throw error;
      });
    }
    await this.#startPromise;
  }

  async describe(): Promise<MirrorSessionDescription> {
    await this.whenReady();
    return await this.#mirror.describeSession(this.session);
  }

  qualifyTrustedInventory(runtimeSessionId: string): void {
    if (this.#disposed || !this.#retention) {
      throw new Error(`SessionRuntime ${this.session} is not retained`);
    }
    this.#trustedInventoryRuntimeSessionId = runtimeSessionId;
  }

  trustedInventoryQualified(): boolean {
    return !this.#disposed && this.#trustedInventoryRuntimeSessionId !== null;
  }

  async describeTrustedInventory(): Promise<TrustedMirrorSessionInventory | null> {
    if (!this.trustedInventoryQualified()) {
      throw new Error(`SessionRuntime ${this.session} is not inventory-qualified`);
    }
    await this.whenReady();
    const expectedRuntimeSessionId = this.#trustedInventoryRuntimeSessionId;
    if (!expectedRuntimeSessionId) return null;
    const inventory = await this.#mirror.describeTrustedInventory(
      this.session,
      expectedRuntimeSessionId,
    );
    if (
      inventory !== null &&
      inventory.runtimeSessionId !== this.#trustedInventoryRuntimeSessionId
    ) {
      return null;
    }
    if (!this.trustedInventoryQualified()) {
      throw new Error(`SessionRuntime ${this.session} changed during trusted inventory discovery`);
    }
    return inventory;
  }

  async attachedSessionIdentity(): Promise<{
    sessionName: string;
    runtimeSessionId: string;
  } | null> {
    await this.whenReady();
    return await this.#mirror.retainedSessionIdentity(this.session);
  }

  async subscribe(
    semanticPaneId: string,
    onEvent: (event: MirrorPaneEvent) => void,
    onLayout?: (event: MirrorLayoutEvent) => void,
  ): Promise<MirrorSubscription> {
    await this.whenReady();
    return await this.#mirror.subscribe({
      session: this.session,
      semanticPaneId,
      onEvent,
      onLayout,
    });
  }

  async subscribeReplica(
    semanticPaneId: string,
    onUpdate: (update: CanonicalTerminalReplicaUpdate) => void,
  ): Promise<TerminalReplicaSubscription> {
    await this.whenReady();
    // A replacement parser must never overlap the faulted owner's terminal or
    // revision epoch. This is intentionally separate from transport readiness:
    // the retained tmux channel may remain healthy while one pane parser fails.
    await this.#restartBarrier;
    const owner = this.#terminalReplicaOwner(semanticPaneId);
    try {
      return await owner.subscribe(onUpdate);
    } catch (error) {
      if (this.#terminalReplicas.get(semanticPaneId) === owner) {
        this.#terminalReplicas.delete(semanticPaneId);
      }
      await owner.dispose("session-restarted");
      throw error;
    }
  }

  async openTerminalDelivery(
    clientId: string,
    deliverySubscriberId: string,
    semanticPaneId: string,
    offer: TerminalDeliveryOffer,
    onMessage: (message: TerminalDeliveryServerMessage) => void | Promise<void>,
  ): Promise<TerminalDeliveryConnection> {
    await this.whenReady();
    await this.#restartBarrier;
    this.#assertConnected(clientId);
    return await this.#terminalDeliveryHub.open(
      deliverySubscriberId,
      semanticPaneId,
      offer,
      onMessage,
    );
  }

  #terminalReplicaOwner(semanticPaneId: string): SessionRuntimeTerminalReplicaOwner {
    let owner = this.#terminalReplicas.get(semanticPaneId);
    if (!owner) {
      this.#outputTraces?.clearPane(semanticPaneId);
      const clock = this.#terminalReplicaClocks.get(semanticPaneId) ?? { epoch: 0, revision: -1 };
      const initialRevision = clock.revision + 1;
      let candidate: SessionRuntimeTerminalReplicaOwner;
      candidate = new SessionRuntimeTerminalReplicaOwner(
        this.generation,
        this.session,
        semanticPaneId,
        this.#mirror,
        {
          incarnation: `${this.generation}:${clock.epoch}`,
          initialRevision,
          onRevision: (revision) => {
            const current = this.#terminalReplicaClocks.get(semanticPaneId) ?? clock;
            if (revision > current.revision) current.revision = revision;
            this.#terminalReplicaClocks.set(semanticPaneId, current);
          },
          onClosed: () => {
            if (this.#terminalReplicas.get(semanticPaneId) !== candidate) return;
            this.#outputTraces?.clearPane(semanticPaneId);
            this.#terminalReplicas.delete(semanticPaneId);
            const current = this.#terminalReplicaClocks.get(semanticPaneId) ?? clock;
            current.epoch += 1;
            this.#terminalReplicaClocks.set(semanticPaneId, current);
          },
          onFault: () => {
            if (this.#terminalReplicas.get(semanticPaneId) !== candidate) return;
            this.#outputTraces?.clearPane(semanticPaneId);
            this.#terminalReplicas.delete(semanticPaneId);
            this.#restartBarrier = this.#restartBarrier.then(async () => {
              await candidate.dispose("session-restarted");
              const current = this.#terminalReplicaClocks.get(semanticPaneId) ?? clock;
              current.epoch += 1;
              this.#terminalReplicaClocks.set(semanticPaneId, current);
            });
          },
          scheduler: this.#scheduler,
          observability: this.#observability,
          ...(this.#outputTraces
            ? { takeOutputTrace: () => this.#takeOutputTrace(semanticPaneId) }
            : {}),
        },
      );
      owner = candidate;
      this.#terminalReplicas.set(semanticPaneId, owner);
    }
    return owner;
  }

  #takeOutputTrace(semanticPaneId: string): SessionRuntimeTraceContext | null {
    const pending = this.#outputTraces?.take(semanticPaneId) ?? null;
    if (!pending) return null;
    const incarnation = this.#terminalReplicas
      .get(semanticPaneId)
      ?.qualificationSnapshot().incarnation;
    const authority = { generation: this.generation, incarnation: incarnation ?? null };
    if (!this.#observability.enabled) return Object.freeze({ ...pending, authority });
    const trace = this.#observability.beginTrace(pending.scenario, authority, pending.traceId);
    const observation = this.#outputObservations.get(semanticPaneId);
    this.#outputObservations.delete(semanticPaneId);
    if (trace && observation) {
      const observedAtMicros = this.#observability.nowMicros();
      if (observation.ageMs !== null) {
        this.#observability.recordSpan(
          "tmux",
          "tmux-output-server-age",
          observedAtMicros - observation.ageMs * 1_000,
          observedAtMicros,
          trace,
        );
      }
      if (observation.timing) {
        this.#observability.recordSpan(
          "parse",
          "control-stdout-parse",
          observation.timing.receivedAtMicros,
          observation.timing.parsedAtMicros,
          trace,
        );
        this.#observability.recordSpan(
          "reduce",
          "control-output-to-replica",
          observation.timing.parsedAtMicros,
          observedAtMicros,
          trace,
        );
      }
    }
    return trace;
  }

  release(consumer: SessionRuntimeConsumerImpl): void {
    this.#consumers.delete(consumer);
    if (this.#consumersByClientId.get(consumer.clientId) === consumer) {
      this.#consumersByClientId.delete(consumer.clientId);
    }
    if (this.#controllerClientId === consumer.clientId) this.#clearController();
    this.#authority.disconnect(consumer.clientId);
    this.#publishAuthority();
  }

  noteControlExit(): void {
    this.#trustedInventoryRuntimeSessionId = null;
    const retention = this.#retention;
    this.#retention = null;
    this.#startPromise = null;
    this.#outputTraces?.clear();
    this.#outputObservations.clear();
    const owners = [...this.#terminalReplicas.values()];
    this.#terminalReplicas.clear();
    this.#restartBarrier = this.#restartBarrier.then(async () => {
      await this.#terminalDeliveryHub.resetForSessionRestart();
      await Promise.allSettled(owners.map((owner) => owner.dispose("session-restarted")));
      await retention?.close();
      for (const clock of this.#terminalReplicaClocks.values()) clock.epoch += 1;
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#trustedInventoryRuntimeSessionId = null;
    const consumers = [...this.#consumers];
    await Promise.allSettled(consumers.map((consumer) => consumer.close()));
    this.#clearController();
    this.#authority.dispose();
    this.#authorityListeners.clear();
    this.#completedHandoffs.clear();
    this.#releasedLeases.clear();
    this.#outputTraces?.clear();
    await Promise.allSettled(
      [...this.#terminalReplicas.values()].map((owner) => owner.dispose("runtime-disposed")),
    );
    this.#terminalReplicas.clear();
    await this.#terminalDeliveryHub.close();
    await this.#startPromise?.catch(() => undefined);
    await this.#restartBarrier;
    await this.#retention?.close();
    this.#retention = null;
  }

  #assertConnected(clientId: string): void {
    if (!this.#consumersByClientId.has(clientId)) {
      throw new SessionRuntimeControllerLeaseError(
        "controller-target-unavailable",
        "The controller client is not connected to this session runtime.",
      );
    }
  }

  #assignController(clientId: string): SessionRuntimeControllerLease {
    this.#controllerRevision += 1;
    this.#controllerClientId = clientId;
    this.#controllerToken = z.uuid().parse(this.#createControllerToken());
    return this.#currentLease();
  }

  #clearController(): void {
    if (this.#controllerClientId === null && this.#controllerToken === null) return;
    this.#controllerRevision += 1;
    this.#controllerClientId = null;
    this.#controllerToken = null;
  }

  #currentLease(): SessionRuntimeControllerLease {
    if (this.#controllerClientId === null || this.#controllerToken === null) {
      throw new SessionRuntimeControllerLeaseError(
        "stale-controller-lease",
        "The session has no active controller.",
      );
    }
    return {
      generation: this.generation,
      session: this.session,
      clientId: this.#controllerClientId,
      token: this.#controllerToken,
      revision: this.#controllerRevision,
    };
  }

  #handoffKey(lease: SessionRuntimeControllerLease, targetClientId: string): string {
    return `${this.#leaseKey(lease)}\0${targetClientId}`;
  }

  #leaseKey(lease: SessionRuntimeControllerLease): string {
    return `${lease.generation}\0${lease.session}\0${lease.clientId}\0${lease.token}\0${lease.revision}`;
  }

  #isCurrentControllerLease(lease: SessionRuntimeControllerLease): boolean {
    return (
      lease.generation === this.generation &&
      lease.session === this.session &&
      lease.clientId === this.#controllerClientId &&
      lease.token === this.#controllerToken &&
      lease.revision === this.#controllerRevision
    );
  }

  #validatedLease(lease: SessionRuntimeControllerLease): SessionRuntimeControllerLease {
    const parsed = SessionRuntimeControllerLeaseSchemaZ.safeParse(lease);
    if (!parsed.success) {
      throw new SessionRuntimeControllerLeaseError(
        "stale-controller-lease",
        "The controller lease is malformed or belongs to another session generation.",
      );
    }
    return parsed.data;
  }

  #publishAuthority(): void {
    if (this.#disposed) return;
    const snapshot = this.#authority.snapshot();
    for (const listener of this.#authorityListeners) listener(snapshot);
  }
}

class SessionRuntimeConsumerImpl implements SessionRuntimeConsumer {
  readonly #runtime: SessionRuntime;
  readonly generation: SessionRuntimeGeneration;
  readonly session: string;
  readonly clientId: string;
  readonly #subscriptions = new Set<MirrorSubscription>();
  readonly #replicaSubscriptions = new Set<TerminalReplicaSubscription>();
  readonly #deliveryConnections = new Set<TerminalDeliveryConnection>();
  #closed = false;

  constructor(
    runtime: SessionRuntime,
    readonly surface: string,
    clientId: string,
  ) {
    this.#runtime = runtime;
    this.generation = runtime.generation;
    this.session = runtime.session;
    this.clientId = clientId;
  }

  controllerRole(): SessionRuntimeControllerRole {
    this.#assertOpen();
    return this.#runtime.controllerRole(this.clientId);
  }

  controllerSnapshot(): SessionRuntimeControllerSnapshot {
    this.#assertOpen();
    return this.#runtime.controllerSnapshot();
  }

  authoritySnapshot(): SessionRuntimeAuthoritySnapshot {
    this.#assertOpen();
    return this.#runtime.authoritySnapshot();
  }

  onAuthoritySnapshot(listener: (snapshot: SessionRuntimeAuthoritySnapshot) => void): () => void {
    this.#assertOpen();
    return this.#runtime.onAuthoritySnapshot(listener);
  }

  updatePresence(state: SessionRuntimePresenceState): void {
    this.#assertOpen();
    this.#runtime.updatePresence(this.clientId, state);
  }

  noteActivity(activity: SessionRuntimeActivityKind): void {
    this.#assertOpen();
    this.#runtime.noteActivity(this.clientId, activity);
  }

  acquireAuthority(authority: SessionRuntimeAuthorityKind): SessionRuntimeAuthorityLease | null {
    this.#assertOpen();
    return this.#runtime.acquireAuthority(this.clientId, authority);
  }

  releaseAuthority(authority: SessionRuntimeAuthorityKind): void {
    this.#assertOpen();
    this.#runtime.releaseAuthority(this.clientId, authority);
  }

  acquireController(): SessionRuntimeControllerLease {
    this.#assertOpen();
    return this.#runtime.acquireController(this.clientId);
  }

  handoffController(
    lease: SessionRuntimeControllerLease,
    targetClientId: string,
  ): SessionRuntimeControllerLease {
    this.#assertOpen();
    return this.#runtime.handoffController(this.clientId, lease, targetClientId);
  }

  releaseController(lease: SessionRuntimeControllerLease): void {
    this.#assertOpen();
    this.#runtime.releaseController(this.clientId, lease);
  }

  submitIntent(
    lease: SessionRuntimeControllerLease,
    operationId: string,
    intent: SessionRuntimeSemanticIntent,
  ): Promise<SessionRuntimeIntentResult> {
    this.#assertOpen();
    return this.#runtime.submitIntent(this.clientId, lease, operationId, intent);
  }

  sendInput(
    lease: SessionRuntimeControllerLease,
    semanticPaneId: string,
    input: SessionRuntimeTerminalInput,
    performanceTraceId?: string,
    causalProbe?: CausalCellProbeV1,
    onCausalResult?: (result: CausalCellLedgerResult) => void,
  ): void {
    this.#assertOpen();
    this.#runtime.sendInput(
      this.clientId,
      lease,
      semanticPaneId,
      input,
      performanceTraceId,
      causalProbe,
      onCausalResult,
    );
  }

  failCausalCellProbe(
    semanticPaneId: string,
    traceId: string,
    reason: CausalCellFailureReasonV1,
  ): void {
    this.#runtime.failCausalCellProbe(semanticPaneId, traceId, reason);
  }

  fitViewport(lease: SessionRuntimeControllerLease, cols: number, rows: number): void {
    this.#assertOpen();
    this.#runtime.fitViewport(this.clientId, lease, cols, rows);
  }

  async describe(): Promise<MirrorSessionDescription> {
    this.#assertOpen();
    return await this.#runtime.describe();
  }

  async subscribe(
    semanticPaneId: string,
    onEvent: (event: MirrorPaneEvent) => void,
    onLayout?: (event: MirrorLayoutEvent) => void,
  ): Promise<MirrorSubscription> {
    this.#assertOpen();
    const upstream = await this.#runtime.subscribe(semanticPaneId, onEvent, onLayout);
    if (this.#closed) {
      await upstream.close();
      throw new Error(`SessionRuntime consumer ${this.surface} is closed`);
    }
    let closed = false;
    const subscription: MirrorSubscription = {
      ...upstream,
      close: async () => {
        if (closed) return;
        closed = true;
        this.#subscriptions.delete(subscription);
        await upstream.close();
      },
    };
    this.#subscriptions.add(subscription);
    return subscription;
  }

  async subscribeReplica(
    semanticPaneId: string,
    onUpdate: (update: CanonicalTerminalReplicaUpdate) => void,
  ): Promise<TerminalReplicaSubscription> {
    this.#assertOpen();
    const upstream = await this.#runtime.subscribeReplica(semanticPaneId, onUpdate);
    if (this.#closed) {
      await upstream.close();
      throw new Error(`SessionRuntime consumer ${this.surface} is closed`);
    }
    let closed = false;
    const subscription: TerminalReplicaSubscription = {
      ...upstream,
      close: async () => {
        if (closed) return;
        closed = true;
        this.#replicaSubscriptions.delete(subscription);
        await upstream.close();
      },
    };
    this.#replicaSubscriptions.add(subscription);
    return subscription;
  }

  async openTerminalDelivery(
    deliverySubscriberId: string,
    semanticPaneId: string,
    offer: TerminalDeliveryOffer,
    onMessage: (message: TerminalDeliveryServerMessage) => void | Promise<void>,
  ): Promise<TerminalDeliveryConnection> {
    this.#assertOpen();
    const upstream = await this.#runtime.openTerminalDelivery(
      this.clientId,
      deliverySubscriberId,
      semanticPaneId,
      offer,
      onMessage,
    );
    if (this.#closed) {
      await upstream.close();
      throw new Error(`SessionRuntime consumer ${this.surface} is closed`);
    }
    let closed = false;
    const connection: TerminalDeliveryConnection = {
      negotiation: upstream.negotiation,
      ack: (ack: TerminalDeliveryAck) => upstream.ack(ack),
      nack: (nack: TerminalDeliveryNack) => upstream.nack(nack),
      setVisibility: (visibility: TerminalDeliveryVisibility) => upstream.setVisibility(visibility),
      close: async () => {
        if (closed) return;
        closed = true;
        this.#deliveryConnections.delete(connection);
        await upstream.close();
      },
    };
    this.#deliveryConnections.add(connection);
    return connection;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const subscriptions = [...this.#subscriptions];
    const replicaSubscriptions = [...this.#replicaSubscriptions];
    const deliveryConnections = [...this.#deliveryConnections];
    this.#subscriptions.clear();
    this.#replicaSubscriptions.clear();
    this.#deliveryConnections.clear();
    // Authority retirement is synchronous. A slow/frozen mirror subscription
    // must never keep controller leases or previously issued handles alive.
    this.#runtime.release(this);
    await Promise.allSettled(subscriptions.map((subscription) => subscription.close()));
    await Promise.allSettled(replicaSubscriptions.map((subscription) => subscription.close()));
    await Promise.allSettled(deliveryConnections.map((connection) => connection.close()));
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`SessionRuntime consumer ${this.surface} is closed`);
  }
}
