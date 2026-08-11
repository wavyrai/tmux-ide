import {
  SessionRuntimeClientIdSchemaZ,
  SessionRuntimeControllerLeaseSchemaZ,
  SessionRuntimeGenerationSchemaZ,
  SessionRuntimeSemanticIntentSchemaZ,
  type AuthoredInteractionOrigin,
  type InteractionReceipt,
  type SessionRuntimeControllerLease,
  type SessionRuntimeControllerRole,
  type SessionRuntimeControllerSnapshot,
  type SessionRuntimeGeneration,
  type SessionRuntimeSemanticIntent,
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
} from "./semantic-mutation-executor.ts";

export interface SessionRuntimeRegistryOptions {
  readonly generation: string;
  readonly mirror?: MirrorServiceOptions;
  readonly semanticMutations?: SessionSemanticMutationExecutorOptions;
  /** Deterministic seam for lease tests. Production uses cryptographic UUIDs. */
  readonly createControllerToken?: () => string;
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
  describe(): Promise<MirrorSessionDescription>;
  subscribe(
    semanticPaneId: string,
    onEvent: (event: MirrorPaneEvent) => void,
    onLayout?: (event: MirrorLayoutEvent) => void,
  ): Promise<MirrorSubscription>;
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
  readonly #sessions = new Map<string, SessionRuntime>();
  readonly #executionHandles = new WeakMap<object, ExecutionHandleState>();
  readonly #stopExitObserver: () => void;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  constructor(options: SessionRuntimeRegistryOptions) {
    this.generation = SessionRuntimeGenerationSchemaZ.parse(options.generation);
    this.#mirror = new MirrorService(options.mirror);
    this.#semanticMutations = options.semanticMutations
      ? new SessionSemanticMutationExecutor(options.semanticMutations)
      : null;
    this.#resolveSession = options.semanticMutations?.resolveSession ?? null;
    this.#createControllerToken = options.createControllerToken ?? randomUUID;
    this.#stopExitObserver = this.#mirror.onSessionExit((session) => {
      this.#sessions.get(session)?.noteControlExit();
    });
  }

  connect(session: string, surface: string, clientId: string): SessionRuntimeConsumer {
    return this.#runtime(session).connect(surface, SessionRuntimeClientIdSchemaZ.parse(clientId));
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

  dispose(): Promise<void> {
    if (!this.#disposePromise) {
      this.#disposed = true;
      this.#stopExitObserver();
      this.#disposePromise = (async () => {
        await this.#semanticMutations?.dispose();
        await Promise.allSettled([...this.#sessions.values()].map((runtime) => runtime.dispose()));
        this.#sessions.clear();
        await this.#mirror.dispose();
      })();
    }
    return this.#disposePromise;
  }

  #runtime(session: string): SessionRuntime {
    if (this.#disposed) throw new Error("SessionRuntimeRegistry is disposed");
    const existing = this.#sessions.get(session);
    if (existing) return existing;
    const runtime: SessionRuntime = new SessionRuntime(
      this.generation,
      session,
      this.#mirror,
      this.#createControllerToken,
      (owner, lease, operationId, intent, origin): Promise<SessionRuntimeIntentResult> =>
        this.#submitAuthorizedIntent(owner, lease, operationId, intent, null, undefined, origin),
    );
    this.#sessions.set(session, runtime);
    return runtime;
  }
}

class SessionRuntime {
  readonly #mirror: MirrorService;
  readonly #consumers = new Set<SessionRuntimeConsumerImpl>();
  readonly #consumersByClientId = new Map<string, SessionRuntimeConsumerImpl>();
  readonly #createControllerToken: () => string;
  readonly #submitAuthorized: (
    runtime: SessionRuntime,
    lease: SessionRuntimeControllerLease,
    operationId: string,
    intent: SessionRuntimeSemanticIntent,
    origin: AuthoredInteractionOrigin,
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

  constructor(
    readonly generation: SessionRuntimeGeneration,
    readonly session: string,
    mirror: MirrorService,
    createControllerToken: () => string,
    submitAuthorized: (
      runtime: SessionRuntime,
      lease: SessionRuntimeControllerLease,
      operationId: string,
      intent: SessionRuntimeSemanticIntent,
      origin: AuthoredInteractionOrigin,
    ) => Promise<SessionRuntimeIntentResult>,
  ) {
    this.#mirror = mirror;
    this.#createControllerToken = createControllerToken;
    this.#submitAuthorized = submitAuthorized;
  }

  connect(surface: string, clientId: string): SessionRuntimeConsumer {
    if (this.#disposed) throw new Error(`SessionRuntime ${this.session} is disposed`);
    if (this.#consumersByClientId.has(clientId)) {
      throw new TypeError(`SessionRuntime client ${clientId} is already connected`);
    }
    const consumer = new SessionRuntimeConsumerImpl(this, surface, clientId);
    this.#consumers.add(consumer);
    this.#consumersByClientId.set(clientId, consumer);
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

  ownsConsumer(candidate: SessionRuntimeConsumer): boolean {
    return this.#consumers.has(candidate as SessionRuntimeConsumerImpl);
  }

  hasController(): boolean {
    return this.#controllerClientId !== null;
  }

  acquireController(clientId: string): SessionRuntimeControllerLease {
    this.#assertConnected(clientId);
    if (this.#controllerClientId === clientId) return this.#currentLease();
    if (this.#controllerClientId !== null) {
      throw new SessionRuntimeControllerLeaseError(
        "controller-conflict",
        `Session ${this.session} already has a controller.`,
      );
    }
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
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async whenReady(): Promise<void> {
    if (this.#disposed) throw new Error(`SessionRuntime ${this.session} is disposed`);
    if (!this.#startPromise) {
      this.#startPromise = (async () => {
        await this.#restartBarrier;
        if (this.#disposed) throw new Error(`SessionRuntime ${this.session} is disposed`);
        this.#retention = await this.#mirror.retainSession(this.session);
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

  release(consumer: SessionRuntimeConsumerImpl): void {
    this.#consumers.delete(consumer);
    if (this.#consumersByClientId.get(consumer.clientId) === consumer) {
      this.#consumersByClientId.delete(consumer.clientId);
    }
    if (this.#controllerClientId === consumer.clientId) this.#clearController();
  }

  noteControlExit(): void {
    const retention = this.#retention;
    this.#retention = null;
    this.#startPromise = null;
    if (retention) {
      this.#restartBarrier = this.#restartBarrier.then(() => retention.close());
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const consumers = [...this.#consumers];
    await Promise.allSettled(consumers.map((consumer) => consumer.close()));
    this.#clearController();
    this.#completedHandoffs.clear();
    this.#releasedLeases.clear();
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
}

class SessionRuntimeConsumerImpl implements SessionRuntimeConsumer {
  readonly #runtime: SessionRuntime;
  readonly generation: SessionRuntimeGeneration;
  readonly session: string;
  readonly clientId: string;
  readonly #subscriptions = new Set<MirrorSubscription>();
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

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const subscriptions = [...this.#subscriptions];
    this.#subscriptions.clear();
    // Authority retirement is synchronous. A slow/frozen mirror subscription
    // must never keep controller leases or previously issued handles alive.
    this.#runtime.release(this);
    await Promise.allSettled(subscriptions.map((subscription) => subscription.close()));
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`SessionRuntime consumer ${this.surface} is closed`);
  }
}
