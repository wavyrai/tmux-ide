// Generic reactor scaffolding.
//
// Shape (T092 contract — unchanged):
//   const r = makeReactor({ name, process, onFailure?, logger? });
//   const dispose = await r.start();
//   r.enqueue(event);          // any number of times, anywhere
//   await r.drain();           // resolves when queue empty + no in-flight work
//   await dispose();           // drains, then halts further processing
//
// Implementation (T094): Effect.gen internals — Queue.unbounded + Ref
// + Deferred + Effect.forkScoped, modeled on t3's `DrainableWorker` at
// context/t3code/packages/shared/src/DrainableWorker.ts. The public API
// is Promise-shaped at the boundary so callers (HTTP handlers, tests,
// thread-manager) stay Effect-free — schema-at-edge per G14 §2.2.
//
// Failure isolation: a throw inside process(event) is caught via
// `Effect.catchAllCause`; everything except a pure `Interrupt` cause is
// squashed and emitted as a synthetic `chat.reactor.failure` event handed
// to onFailure. A throwing onFailure is itself caught + logged. Matches
// t3's CheckpointReactor `processInputSafely` shape exactly.

import { Cause, Deferred, Effect, Exit, Queue, Ref, Scope } from "effect";

/** Synthetic event emitted when a reactor's process() throws. */
export interface ReactorFailureEvent<TEvent = unknown> {
  type: "chat.reactor.failure";
  reactor: string;
  cause: { message: string; stack?: string };
  causationEvent: TEvent;
  occurredAt: string;
}

export interface ReactorLogEntry {
  level: "info" | "warn" | "error";
  msg: string;
  cause?: unknown;
}

export interface Reactor<TEvent> {
  /** Enqueue an event for processing. Returns immediately. */
  enqueue(event: TEvent): void;
  /**
   * Start the worker loop. Resolves once the reactor is ready to consume.
   * Returns a disposer that drains the queue then halts further processing.
   * Idempotent — calling start() twice returns the same disposer.
   */
  start(): Promise<() => Promise<void>>;
  /** Resolves when the queue is empty AND no event is in-flight. */
  drain(): Promise<void>;
  /** Inspect current outstanding event count (queued + in-flight). */
  readonly queueDepth: number;
}

export interface MakeReactorOptions<TEvent> {
  /** Reactor identity — surfaces in logs and ReactorFailureEvent.reactor. */
  name: string;
  /** Per-event handler. May be async. Non-matching events should noop. */
  process: (event: TEvent) => void | Promise<void>;
  /**
   * Called when process() throws. Default: log-only. A production wiring
   * appends ReactorFailureEvent to the event store; tests can collect
   * failures into an array.
   */
  onFailure?: (failure: ReactorFailureEvent<TEvent>) => void | Promise<void>;
  logger?: (entry: ReactorLogEntry) => void;
  /** Clock seam for tests. Defaults to () => new Date().toISOString(). */
  now?: () => string;
}

/**
 * Minimal subscribe interface for an event source feeding a reactor.
 * Intentionally narrow so callers can plug in T090's ChatEventStore, a
 * Node EventEmitter, or an in-memory test double without coupling.
 */
export interface ReactorEventSource<TEvent> {
  subscribe(handler: (event: TEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Effect-level core. Produces the queue + counters + worker fiber. Lives
// inside the long-lived Scope provided by makeReactor() so finalizers
// (Queue.shutdown, worker interrupt) run when the scope closes.
// ---------------------------------------------------------------------------
type ReactorCore<TEvent> = {
  enqueueEff: (event: TEvent) => Effect.Effect<void>;
  drainEff: Effect.Effect<void>;
  queueDepthEff: Effect.Effect<number>;
};

const makeReactorCore = <TEvent>(opts: MakeReactorOptions<TEvent>) =>
  Effect.gen(function* () {
    const now = opts.now ?? (() => new Date().toISOString());
    const log = opts.logger ?? (() => undefined);

    // acquireRelease wires Queue.shutdown as a scope finalizer — closing
    // the scope drains parked takers and frees the queue without explicit
    // cleanup at the call site.
    const queue = yield* Effect.acquireRelease(Queue.unbounded<TEvent>(), Queue.shutdown);
    const outstanding = yield* Ref.make(0);
    const drainSignals = yield* Ref.make<Array<Deferred.Deferred<void>>>([]);

    // The `outstanding` counter alone is authoritative: it increments
    // BEFORE Queue.offer in enqueue and decrements AFTER process()
    // resolves in the worker. So outstanding === 0 implies (queue empty
    // AND no in-flight work). We don't consult Queue.size — Effect's
    // Queue.size returns a NEGATIVE count when a taker is parked, which
    // is the worker's normal idle state.
    const wakeDrainersIfIdle: Effect.Effect<void> = Effect.gen(function* () {
      const n = yield* Ref.get(outstanding);
      if (n > 0) return;
      const pending = yield* Ref.getAndSet(drainSignals, []);
      for (const d of pending) {
        yield* Deferred.succeed(d, undefined as void);
      }
    });

    const emitFailure = (event: TEvent, err: unknown): Effect.Effect<void> =>
      Effect.gen(function* () {
        const error = err instanceof Error ? err : new Error(String(err));
        const failure: ReactorFailureEvent<TEvent> = {
          type: "chat.reactor.failure",
          reactor: opts.name,
          cause: { message: error.message, stack: error.stack },
          causationEvent: event,
          occurredAt: now(),
        };
        log({
          level: "error",
          msg: `[${opts.name}] reactor failed: ${error.message}`,
          cause: error,
        } satisfies ReactorLogEntry);
        if (!opts.onFailure) return;
        // A throwing onFailure must not poison the worker — catchAll into void.
        yield* Effect.tryPromise({
          try: () => Promise.resolve(opts.onFailure!(failure)),
          catch: (handlerErr) => handlerErr,
        }).pipe(
          Effect.catchAll((handlerErr) =>
            Effect.sync(() =>
              log({
                level: "error",
                msg: `[${opts.name}] onFailure handler threw: ${(handlerErr as Error).message}`,
                cause: handlerErr,
              }),
            ),
          ),
        );
      });

    // process(event) may be sync or async. tryPromise wraps both —
    // a sync throw and a rejected Promise both surface as a Cause.Fail.
    const processSafe = (event: TEvent) =>
      Effect.tryPromise<void, unknown>({
        try: async () => {
          await opts.process(event);
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catchAllCause((cause) => {
          // Interrupts propagate so the worker shuts down cleanly when
          // the scope closes. Everything else becomes a synthetic
          // chat.reactor.failure and the worker keeps consuming —
          // matches t3's CheckpointReactor processInputSafely.
          if (Cause.isInterruptedOnly(cause)) {
            return Effect.failCause(cause as Cause.Cause<never>);
          }
          const squashed = Cause.squash(cause);
          return emitFailure(event, squashed);
        }),
      );

    // Single-worker loop, forked into the enclosing scope. Mirrors t3's
    // DrainableWorker: Queue.take -> process -> decrement -> wake drainers.
    yield* Queue.take(queue).pipe(
      Effect.tap((event) =>
        Effect.ensuring(
          processSafe(event),
          Ref.update(outstanding, (n) => n - 1).pipe(Effect.zipRight(wakeDrainersIfIdle)),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const enqueueEff = (event: TEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.update(outstanding, (n) => n + 1);
        yield* Queue.offer(queue, event);
      });

    const drainEff: Effect.Effect<void> = Effect.gen(function* () {
      const n = yield* Ref.get(outstanding);
      if (n === 0) return;
      const deferred = yield* Deferred.make<void>();
      yield* Ref.update(drainSignals, (xs) => [...xs, deferred]);
      yield* Deferred.await(deferred);
    });

    const queueDepthEff: Effect.Effect<number> = Ref.get(outstanding);

    return { enqueueEff, drainEff, queueDepthEff } satisfies ReactorCore<TEvent>;
  });

// ---------------------------------------------------------------------------
// Public factory — Promise-shaped, byte-compatible with T092's makeReactor.
// Caller code never sees Effect; we runFork / runPromise at the seam.
// ---------------------------------------------------------------------------
export function makeReactor<TEvent>(opts: MakeReactorOptions<TEvent>): Reactor<TEvent> {
  const log = opts.logger ?? (() => undefined);

  // One CloseableScope per reactor — closed by dispose(). The forkScoped
  // worker interrupts and Queue.shutdown runs as the scope finalizer.
  // Pane 2's `ChatReactorLive` (packages/daemon/src/runtime/layers.ts)
  // wraps this in Layer.scoped, so the Layer's own Scope is responsible
  // for calling our disposer — the two scopes nest cleanly.
  const scope = Effect.runSync(Scope.make());

  // Boot the core eagerly so enqueue() before start() still buffers
  // (T092 contract). Queue.unbounded + Ref.make + forkScoped are all
  // non-blocking, so runSync is safe. Do NOT wrap in Effect.scoped —
  // that would close the scope immediately and interrupt the forked
  // worker before the first enqueue. `Scope.extend` provides our
  // long-lived scope without closing it.
  const core = Effect.runSync(Scope.extend(makeReactorCore<TEvent>(opts), scope));

  let stopped = false;
  let disposer: (() => Promise<void>) | null = null;

  return {
    enqueue(event: TEvent): void {
      if (stopped) {
        log({
          level: "warn",
          msg: `[${opts.name}] enqueue after dispose; dropping event`,
        });
        return;
      }
      // Fire-and-forget. enqueueEff is non-blocking (Ref.update +
      // Queue.offer to unbounded). runFork drops the fiber handle —
      // same semantics as T092's void loop().
      Effect.runFork(core.enqueueEff(event));
    },

    async start(): Promise<() => Promise<void>> {
      if (disposer) return disposer;
      // The forkScoped worker is already running from boot. start()
      // exists for API parity (T092 also just flipped a flag here).
      disposer = async () => {
        if (stopped) return;
        // Drain in-flight + queued work first, then close the scope to
        // interrupt the worker fiber and run Queue.shutdown.
        await Effect.runPromise(core.drainEff);
        stopped = true;
        await Effect.runPromise(Scope.close(scope, Exit.void));
      };
      return disposer;
    },

    drain(): Promise<void> {
      return Effect.runPromise(core.drainEff);
    },

    get queueDepth(): number {
      return Effect.runSync(core.queueDepthEff);
    },
  };
}

export function bindReactor<TEvent>(
  reactor: Reactor<TEvent>,
  source: ReactorEventSource<TEvent>,
): () => void {
  return source.subscribe((event) => reactor.enqueue(event));
}
