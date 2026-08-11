import {
  SessionRuntimeGenerationSchemaZ,
  type InteractionReceipt,
  type SessionRuntimeGeneration,
  type SessionRuntimeSemanticIntent,
} from "@tmux-ide/contracts";
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
}

export interface SessionRuntimeConsumer {
  readonly generation: SessionRuntimeGeneration;
  readonly session: string;
  readonly surface: string;
  describe(): Promise<MirrorSessionDescription>;
  subscribe(
    semanticPaneId: string,
    onEvent: (event: MirrorPaneEvent) => void,
    onLayout?: (event: MirrorLayoutEvent) => void,
  ): Promise<MirrorSubscription>;
  close(): Promise<void>;
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
  readonly #sessions = new Map<string, SessionRuntime>();
  readonly #stopExitObserver: () => void;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  constructor(options: SessionRuntimeRegistryOptions) {
    this.generation = SessionRuntimeGenerationSchemaZ.parse(options.generation);
    this.#mirror = new MirrorService(options.mirror);
    this.#semanticMutations = options.semanticMutations
      ? new SessionSemanticMutationExecutor(options.semanticMutations)
      : null;
    this.#stopExitObserver = this.#mirror.onSessionExit((session) => {
      this.#sessions.get(session)?.noteControlExit();
    });
  }

  connect(session: string, surface: string): SessionRuntimeConsumer {
    return this.#runtime(session).connect(surface);
  }

  async describeSession(session: string): Promise<MirrorSessionDescription> {
    return await this.#runtime(session).describe();
  }

  async subscribe(request: MirrorSubscribeRequest): Promise<MirrorSubscription> {
    const runtime = this.#runtime(request.session);
    await runtime.whenReady();
    return await this.#mirror.subscribe(request);
  }

  submitIntent(
    operationId: string,
    intent: SessionRuntimeSemanticIntent,
  ): Promise<SessionRuntimeIntentResult> {
    if (this.#disposed) return Promise.reject(new Error("SessionRuntimeRegistry is disposed"));
    if (!this.#semanticMutations) {
      return Promise.reject(new Error("Session semantic mutations are unavailable"));
    }
    return this.#semanticMutations.submit(operationId, intent);
  }

  observeTmuxInteraction(observation: SessionRuntimeTmuxObservation): void {
    this.#semanticMutations?.observe(observation);
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
    const runtime = new SessionRuntime(this.generation, session, this.#mirror);
    this.#sessions.set(session, runtime);
    return runtime;
  }
}

class SessionRuntime {
  readonly #mirror: MirrorService;
  readonly #consumers = new Set<SessionRuntimeConsumerImpl>();
  #retention: Awaited<ReturnType<MirrorService["retainSession"]>> | null = null;
  #startPromise: Promise<void> | null = null;
  #restartBarrier: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(
    readonly generation: SessionRuntimeGeneration,
    readonly session: string,
    mirror: MirrorService,
  ) {
    this.#mirror = mirror;
  }

  connect(surface: string): SessionRuntimeConsumer {
    if (this.#disposed) throw new Error(`SessionRuntime ${this.session} is disposed`);
    const consumer = new SessionRuntimeConsumerImpl(this, surface);
    this.#consumers.add(consumer);
    return consumer;
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
    await this.#restartBarrier;
    await this.#retention?.close();
    this.#retention = null;
  }
}

class SessionRuntimeConsumerImpl implements SessionRuntimeConsumer {
  readonly #runtime: SessionRuntime;
  readonly generation: SessionRuntimeGeneration;
  readonly session: string;
  readonly #subscriptions = new Set<MirrorSubscription>();
  #closed = false;

  constructor(
    runtime: SessionRuntime,
    readonly surface: string,
  ) {
    this.#runtime = runtime;
    this.generation = runtime.generation;
    this.session = runtime.session;
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
    await Promise.allSettled(subscriptions.map((subscription) => subscription.close()));
    this.#runtime.release(this);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`SessionRuntime consumer ${this.surface} is closed`);
  }
}
