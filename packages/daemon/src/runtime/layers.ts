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
import { makeReactor, type Reactor } from "../chat/reactors/reactor.ts";

import { ChatEventStoreError, ProjectionError, ReactorError } from "./errors.ts";
import {
  ChatEventStoreService,
  ChatReactorService,
  TurnProjectionService,
  type ChatEventStoreServiceShape,
  type ChatReactorServiceShape,
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
  ChatEventStoreService | TurnProjectionService | ChatReactorService,
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
  const reactorLayer = ChatReactorLive(options.reactor);

  return Layer.mergeAll(
    eventStoreLayer,
    Layer.provide(projectionLayer, eventStoreLayer),
    Layer.provide(reactorLayer, eventStoreLayer),
  ) as Layer.Layer<
    ChatEventStoreService | TurnProjectionService | ChatReactorService,
    ReactorError,
    Scope.Scope
  >;
};
