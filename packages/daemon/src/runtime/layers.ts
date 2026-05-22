/**
 * G14-T093 — Effect Layers binding daemon services to concrete implementations.
 *
 * Two flavors per service:
 *   - `*Live`   — production wiring: wraps the plain-TS implementations
 *                  from T090 (chat-event-store), T091 (turn-projection),
 *                  T092 (reactor).
 *   - `*FromValue` — pre-constructed instance bindings, useful for tests
 *                  that build their own doubles or for composing the
 *                  pipeline against an in-memory event store.
 *
 * The Live layers are resource-safe via `Layer.scoped`:
 *   - `TurnProjectionLive` releases its subscription on Scope close.
 *   - `ChatReactorLive` calls its disposer on Scope close.
 *
 * Schema-at-edge: callers in HTTP/IPC land construct a Live Layer once at
 * daemon startup, then `Effect.provide` it to any Effect program. No HTTP
 * handler imports Effect itself; they call `Effect.runPromise(...)`
 * exactly at the boundary.
 */

import { Effect, Layer, Scope } from "effect";

import type { SqliteDb } from "../lib/sqlite-adapter.ts";
import {
  makeChatEventStore,
  type AppendInput,
  type ChatEventStore,
  type PersistedChatEvent,
} from "../persistence/chat-event-store.ts";
import {
  makeInMemoryCursorStore,
  type ChatEventReader,
  type ProjectionCursorStore,
} from "../persistence/types.ts";
import {
  makeTurnProjection,
  type TurnProjection,
} from "../persistence/projections/turn-projection.ts";
import {
  makeTurnDiffProjection,
  type TurnDiffProjection,
} from "../persistence/projections/turn-diff-projection.ts";
import { makeReactor, type Reactor } from "../chat/reactors/reactor.ts";
import {
  makeProviderApprovalPolicy,
  type PermissionRequestEmission,
  type ProviderApprovalPolicy,
  type ProviderApprovalRules,
} from "../chat/provider-approval-policy.ts";
import {
  makeProviderCapabilitiesStore,
  type ProviderCapabilitiesOverride,
  type ProviderCapabilitiesStore,
} from "../chat/provider-capabilities.ts";

import {
  ApprovalPolicyError,
  ChatEventStoreError,
  ProjectionError,
  ReactorError,
} from "./errors.ts";
import {
  ChatEventStoreService,
  ChatReactorService,
  ProviderApprovalPolicyService,
  ProviderCapabilitiesService,
  TurnDiffProjectionService,
  TurnProjectionService,
  type ChatEventStoreServiceShape,
  type ChatReactorServiceShape,
  type ProviderApprovalPolicyServiceShape,
  type ProviderCapabilitiesServiceShape,
  type TurnDiffProjectionServiceShape,
  type TurnProjectionServiceShape,
} from "./services.ts";

// ---------------------------------------------------------------------------
// ChatEventStoreService
// ---------------------------------------------------------------------------

function wrapEventStore(store: ChatEventStore): ChatEventStoreServiceShape {
  return {
    append(input: AppendInput) {
      return Effect.try({
        try: () => store.append(input),
        catch: (cause) =>
          new ChatEventStoreError({
            operation: "append",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
    },
    readFromSequence(seqExclusive: number, limit?: number) {
      return Effect.try({
        try: () => store.readFromSequence(seqExclusive, limit),
        catch: (cause) =>
          new ChatEventStoreError({
            operation: "readFromSequence",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
    },
    subscribe(handler) {
      return Effect.sync(() => store.subscribe(handler));
    },
    raw: store,
  };
}

/**
 * Live layer backed by a real sqlite database. Pass in a connected
 * `SqliteDb` (better-sqlite3 in production, bun:sqlite in tests).
 */
export const ChatEventStoreLive = (db: SqliteDb): Layer.Layer<ChatEventStoreService> =>
  Layer.sync(ChatEventStoreService, () => wrapEventStore(makeChatEventStore(db)));

/**
 * Bind an already-constructed event store (e.g. an in-memory fake) as the
 * service. Useful for projection/reactor tests that ship their own store.
 */
export const ChatEventStoreFromValue = (
  store: ChatEventStore,
): Layer.Layer<ChatEventStoreService> =>
  Layer.succeed(ChatEventStoreService, wrapEventStore(store));

// ---------------------------------------------------------------------------
// TurnProjectionService
// ---------------------------------------------------------------------------

function readerFromStore(store: ChatEventStore): ChatEventReader {
  return {
    readFromSequence: (seq, limit) => store.readFromSequence(seq, limit),
    subscribe: (handler) => store.subscribe(handler),
  };
}

interface MakeTurnProjectionLayerOptions {
  /**
   * Cursor store; defaults to in-memory. Production wires the sqlite-backed
   * `projection_state` table here (will land alongside T094/T095).
   */
  cursorStore?: ProjectionCursorStore;
  name?: string;
  batchSize?: number;
}

function wrapProjection(projection: TurnProjection): TurnProjectionServiceShape {
  const start = Effect.try({
    try: () => projection.start(),
    catch: (cause) =>
      new ProjectionError({
        projection: "turn",
        reason: "bootstrap",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
  const stop = Effect.sync(() => projection.stop());
  return {
    start,
    stop,
    cursor: Effect.sync(() => projection.cursor()),
    latest: (threadId) => Effect.sync(() => projection.latest(threadId)),
    list: (threadId) => Effect.sync(() => projection.list(threadId)),
    raw: projection,
  };
}

/**
 * Build the turn projection from a `ChatEventStoreService`. Scoped so the
 * subscription is released when the Scope closes.
 */
export const TurnProjectionLive = (
  options: MakeTurnProjectionLayerOptions = {},
): Layer.Layer<TurnProjectionService, never, ChatEventStoreService> =>
  Layer.scoped(
    TurnProjectionService,
    Effect.gen(function* () {
      const eventStore = yield* ChatEventStoreService;
      const projection = makeTurnProjection({
        reader: readerFromStore(eventStore.raw),
        cursorStore: options.cursorStore ?? makeInMemoryCursorStore(),
        name: options.name,
        batchSize: options.batchSize,
      });
      const shape = wrapProjection(projection);
      // Register cleanup: stop the projection (releases the subscription)
      // when the Scope closes.
      yield* Effect.addFinalizer(() => Effect.sync(() => projection.stop()));
      return shape;
    }),
  );

// ---------------------------------------------------------------------------
// TurnDiffProjectionService (G14-T101)
// ---------------------------------------------------------------------------

function wrapTurnDiffProjection(projection: TurnDiffProjection): TurnDiffProjectionServiceShape {
  const start = Effect.try({
    try: () => projection.start(),
    catch: (cause) =>
      new ProjectionError({
        projection: "turn-diff",
        reason: "bootstrap",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
  return {
    start,
    stop: Effect.sync(() => projection.stop()),
    cursor: Effect.sync(() => projection.cursor()),
    listForTurn: (turnId) => Effect.sync(() => projection.listForTurn(turnId)),
    listForThread: (threadId) => Effect.sync(() => projection.listForThread(threadId)),
    aggregateForThread: (threadId) => Effect.sync(() => projection.aggregateForThread(threadId)),
    raw: projection,
  };
}

/**
 * Build the turn-diff projection from a `ChatEventStoreService`. Scoped
 * so the subscription is released on Scope close — same lifecycle as
 * `TurnProjectionLive`.
 */
export const TurnDiffProjectionLive = (
  options: MakeTurnProjectionLayerOptions = {},
): Layer.Layer<TurnDiffProjectionService, never, ChatEventStoreService> =>
  Layer.scoped(
    TurnDiffProjectionService,
    Effect.gen(function* () {
      const eventStore = yield* ChatEventStoreService;
      const projection = makeTurnDiffProjection({
        reader: readerFromStore(eventStore.raw),
        cursorStore: options.cursorStore ?? makeInMemoryCursorStore(),
        name: options.name ? `${options.name}-diff` : undefined,
        batchSize: options.batchSize,
      });
      const shape = wrapTurnDiffProjection(projection);
      yield* Effect.addFinalizer(() => Effect.sync(() => projection.stop()));
      return shape;
    }),
  );

// ---------------------------------------------------------------------------
// ProviderApprovalPolicyService (G14-T12 / T102)
// ---------------------------------------------------------------------------

interface MakeProviderApprovalPolicyLayerOptions {
  initialRules?: Record<string, ProviderApprovalRules>;
  emitPermissionRequest?: (req: PermissionRequestEmission) => void;
  now?: () => Date;
  randomId?: () => string;
}

function wrapApprovalPolicy(policy: ProviderApprovalPolicy): ProviderApprovalPolicyServiceShape {
  return {
    evaluate: (input) =>
      Effect.try({
        try: () => policy.evaluate(input),
        catch: (cause) =>
          new ApprovalPolicyError({
            operation: "evaluate",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),
    register: (provider, rules) =>
      Effect.try({
        try: () => policy.register(provider, rules),
        catch: (cause) =>
          new ApprovalPolicyError({
            operation: "register",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),
    getRules: (provider) => Effect.sync(() => policy.getRules(provider)),
    resolvePrompt: (promptId, decision, reason) =>
      Effect.try({
        try: () => policy.resolvePrompt(promptId, decision, reason),
        catch: (cause) =>
          new ApprovalPolicyError({
            operation: "resolve",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),
    pendingPrompts: Effect.sync(() => policy.pendingPrompts()),
    raw: policy,
  };
}

/**
 * Build the approval policy from initial rules. No external dependencies
 * — the policy is a pure in-memory rule table + emission callback, so
 * Layer.sync is enough (Layer.scoped only buys us release semantics we
 * don't need here).
 */
export const ProviderApprovalPolicyLive = (
  options: MakeProviderApprovalPolicyLayerOptions = {},
): Layer.Layer<ProviderApprovalPolicyService> =>
  Layer.sync(ProviderApprovalPolicyService, () =>
    wrapApprovalPolicy(
      makeProviderApprovalPolicy({
        ...(options.initialRules ? { initialRules: options.initialRules } : {}),
        ...(options.emitPermissionRequest
          ? { emitPermissionRequest: options.emitPermissionRequest }
          : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.randomId ? { randomId: options.randomId } : {}),
      }),
    ),
  );

/**
 * Bind a pre-constructed policy instance — useful when tests want to
 * inspect `.pendingPrompts()` outside the Effect runtime.
 */
export const ProviderApprovalPolicyFromValue = (
  policy: ProviderApprovalPolicy,
): Layer.Layer<ProviderApprovalPolicyService> =>
  Layer.succeed(ProviderApprovalPolicyService, wrapApprovalPolicy(policy));

// ---------------------------------------------------------------------------
// ProviderCapabilitiesService (G14-T13 / T103)
// ---------------------------------------------------------------------------

interface MakeProviderCapabilitiesLayerOptions {
  overrides?: Record<string, ProviderCapabilitiesOverride>;
}

function wrapCapabilitiesStore(store: ProviderCapabilitiesStore): ProviderCapabilitiesServiceShape {
  return {
    forInstance: (instance) => Effect.sync(() => store.forInstance(instance)),
    setOverride: (id, override) => Effect.sync(() => store.setOverride(id, override)),
    clearOverride: (id) => Effect.sync(() => store.clearOverride(id)),
    getOverride: (id) => Effect.sync(() => store.getOverride(id)),
    negotiate: (instance, requested) => Effect.sync(() => store.negotiate(instance, requested)),
    raw: store,
  };
}

/**
 * In-memory capabilities store + Live layer. Pure synchronous wrapper —
 * no I/O, no Effect failure channel, so Layer.sync is sufficient.
 */
export const ProviderCapabilitiesLive = (
  options: MakeProviderCapabilitiesLayerOptions = {},
): Layer.Layer<ProviderCapabilitiesService> =>
  Layer.sync(ProviderCapabilitiesService, () =>
    wrapCapabilitiesStore(
      makeProviderCapabilitiesStore({
        ...(options.overrides ? { overrides: options.overrides } : {}),
      }),
    ),
  );

/** Bind a pre-built store — useful when tests want to inspect side-effects
 *  outside the Effect runtime. */
export const ProviderCapabilitiesFromValue = (
  store: ProviderCapabilitiesStore,
): Layer.Layer<ProviderCapabilitiesService> =>
  Layer.succeed(ProviderCapabilitiesService, wrapCapabilitiesStore(store));

// ---------------------------------------------------------------------------
// ChatReactorService
// ---------------------------------------------------------------------------

interface MakeChatReactorLayerOptions {
  name?: string;
  /**
   * Per-event handler. The reactor scaffolding (T092) guarantees one
   * concurrent invocation; failures are caught and re-emitted as
   * `chat.reactor.failure` synthetic events.
   */
  process: (event: PersistedChatEvent) => void | Promise<void>;
  /**
   * Whether the reactor auto-subscribes to the event store on start. When
   * `false`, callers drive enqueue manually (useful for tests where the
   * event order must be deterministic).
   */
  bindToEventStore?: boolean;
  logger?: (entry: { level: "info" | "warn" | "error"; msg: string; cause?: unknown }) => void;
}

function wrapReactor(reactor: Reactor<PersistedChatEvent>): ChatReactorServiceShape {
  const startEff = Effect.tryPromise({
    try: () => reactor.start(),
    catch: (cause) =>
      new ReactorError({
        reactor: "chat",
        phase: "start",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
  const drainEff = Effect.tryPromise({
    try: () => reactor.drain(),
    catch: (cause) =>
      new ReactorError({
        reactor: "chat",
        phase: "drain",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
  return {
    // `start` is exposed as a one-shot effect; the disposer is captured
    // inside the Layer's Scope rather than handed to callers.
    start: Effect.asVoid(startEff),
    dispose: Effect.suspend(() =>
      Effect.tryPromise({
        try: async () => {
          // Drain then mark stopped — uses reactor.drain because the
          // disposer returned by start() is owned by the Layer's Scope.
          await reactor.drain();
        },
        catch: (cause) =>
          new ReactorError({
            reactor: "chat",
            phase: "dispose",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),
    ),
    drain: drainEff,
    enqueue: (event) => Effect.sync(() => reactor.enqueue(event)),
    raw: reactor,
  };
}

export const ChatReactorLive = (
  options: MakeChatReactorLayerOptions,
): Layer.Layer<ChatReactorService, ReactorError, ChatEventStoreService> =>
  Layer.scoped(
    ChatReactorService,
    Effect.gen(function* () {
      const eventStore = yield* ChatEventStoreService;
      const reactor = makeReactor<PersistedChatEvent>({
        name: options.name ?? "chat",
        process: options.process,
        ...(options.logger ? { logger: options.logger } : {}),
      });

      // Bind to the event store: every appended event flows into the
      // reactor's queue. The unsubscribe runs in the finalizer below.
      let unsubscribe: (() => void) | null = null;
      if (options.bindToEventStore !== false) {
        unsubscribe = eventStore.raw.subscribe((event) => reactor.enqueue(event));
      }

      const disposer = yield* Effect.tryPromise({
        try: () => reactor.start(),
        catch: (cause) =>
          new ReactorError({
            reactor: options.name ?? "chat",
            phase: "start",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          if (unsubscribe) unsubscribe();
          try {
            await disposer();
          } catch {
            // Disposer failures are best-effort during shutdown.
          }
        }),
      );

      return wrapReactor(reactor);
    }),
  );

// ---------------------------------------------------------------------------
// Composite — full chat-turn pipeline layer
// ---------------------------------------------------------------------------

export interface ChatTurnPipelineLayerOptions {
  /** The sqlite db; if omitted, caller must provide `ChatEventStoreFromValue`. */
  db?: SqliteDb;
  reactor: MakeChatReactorLayerOptions;
  projection?: MakeTurnProjectionLayerOptions;
  /** Optional initial approval-policy config (T102). */
  approvalPolicy?: MakeProviderApprovalPolicyLayerOptions;
  /** Optional initial provider capability overrides (T103). */
  capabilities?: MakeProviderCapabilitiesLayerOptions;
}

/**
 * Compose ChatEventStore + TurnProjection + ChatReactor in one Layer. The
 * sqlite db is the only environment requirement; everything else is wired
 * internally.
 *
 * Usage:
 *   const layer = ChatTurnPipelineLive({ db, reactor: { process } });
 *   await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped));
 */
export const ChatTurnPipelineLive = (
  options: ChatTurnPipelineLayerOptions,
): Layer.Layer<
  | ChatEventStoreService
  | TurnProjectionService
  | TurnDiffProjectionService
  | ChatReactorService
  | ProviderApprovalPolicyService
  | ProviderCapabilitiesService,
  ReactorError,
  Scope.Scope
> => {
  const eventStoreLayer = options.db
    ? ChatEventStoreLive(options.db)
    : Layer.fail(
        new ReactorError({
          reactor: "pipeline",
          phase: "start",
          message: "ChatTurnPipelineLive: pass `db` or compose your own ChatEventStore layer",
        }),
      );
  const projectionLayer = TurnProjectionLive(options.projection ?? {});
  // The turn-diff projection rides on the same event-store subscription
  // path as TurnProjection (T091); both projections see every committed
  // event in sequence order via their own subscribe handle. Composing it
  // here means HTTP/IPC callers get the "changed files" panel for free
  // as soon as they pull a ChatTurnPipelineLive into their runtime.
  const turnDiffLayer = TurnDiffProjectionLive(options.projection ?? {});
  const reactorLayer = ChatReactorLive(options.reactor);
  // Approval policy (T102) — independent of the event store / reactor,
  // so it joins the merge without a Layer.provide chain.
  const policyLayer = ProviderApprovalPolicyLive(options.approvalPolicy ?? {});
  // Provider capabilities (T103) — pure in-memory store; same shape as
  // the approval-policy layer above.
  const capabilitiesLayer = ProviderCapabilitiesLive(options.capabilities ?? {});

  return Layer.mergeAll(
    eventStoreLayer,
    Layer.provide(projectionLayer, eventStoreLayer),
    Layer.provide(turnDiffLayer, eventStoreLayer),
    Layer.provide(reactorLayer, eventStoreLayer),
    policyLayer,
    capabilitiesLayer,
  ) as Layer.Layer<
    | ChatEventStoreService
    | TurnProjectionService
    | TurnDiffProjectionService
    | ChatReactorService
    | ProviderApprovalPolicyService
    | ProviderCapabilitiesService,
    ReactorError,
    Scope.Scope
  >;
};
