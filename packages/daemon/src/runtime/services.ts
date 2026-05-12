/**
 * G14-T093 — Effect service tags for the daemon's chat persistence pipeline.
 *
 * Schema-at-edge per docs/goal-14-architecture-parity.md §2.2: Effect runs
 * the persistence + reactor + projection layers; HTTP/IPC code keeps using
 * plain TS. These tags describe the daemon-side surfaces only. No tag here
 * is exported across the contracts boundary — the public contract surface
 * (packages/contracts) stays Effect-free.
 *
 * One-shape-per-service:
 *   - ChatEventStoreService — durable append + replay + subscribe
 *   - TurnProjectionService — read model over the event log
 *   - ChatReactorService    — bounded queue for side-effect handlers
 *
 * Each service follows t3's
 *   `apps/server/src/persistence/Services/OrchestrationEventStore.ts` pattern:
 * an `interface FooShape` declaring the typed methods, and a `class Foo
 * extends Context.Tag(...)<Foo, FooShape>` providing the dependency-injection
 * tag. Layers (see `layers.ts`) bind the shapes to concrete implementations.
 */

import { Context, type Effect } from "effect";

import type {
  AppendInput,
  ChatEventStore,
  PersistedChatEvent,
} from "../persistence/chat-event-store.ts";
import type { TurnProjection, TurnRecord } from "../persistence/projections/turn-projection.ts";
import type { LatestTurn } from "@tmux-ide/contracts";
import type { Reactor } from "../chat/reactors/reactor.ts";

import type { ChatEventStoreError, ProjectionError, ReactorError } from "./errors.ts";

// ---------------------------------------------------------------------------
// ChatEventStoreService
// ---------------------------------------------------------------------------

export interface ChatEventStoreServiceShape {
  readonly append: (input: AppendInput) => Effect.Effect<PersistedChatEvent, ChatEventStoreError>;
  readonly readFromSequence: (
    seqExclusive: number,
    limit?: number,
  ) => Effect.Effect<readonly PersistedChatEvent[], ChatEventStoreError>;
  /**
   * Register a synchronous subscriber. The returned `unsubscribe` Effect is
   * resource-safe (always succeeds). Subscriber exceptions are caught
   * inside the event store and never propagate to the append caller.
   */
  readonly subscribe: (
    handler: (event: PersistedChatEvent) => void,
  ) => Effect.Effect<() => void, never>;
  /** Escape hatch: get the underlying plain-TS event store. Use sparingly. */
  readonly raw: ChatEventStore;
}

export class ChatEventStoreService extends Context.Tag(
  "@tmux-ide/daemon/runtime/ChatEventStoreService",
)<ChatEventStoreService, ChatEventStoreServiceShape>() {}

// ---------------------------------------------------------------------------
// TurnProjectionService
// ---------------------------------------------------------------------------

export interface TurnProjectionServiceShape {
  /** Bootstrap from cursor and subscribe to new events. Idempotent. */
  readonly start: Effect.Effect<void, ProjectionError>;
  /** Detach subscription. Read methods still resolve. */
  readonly stop: Effect.Effect<void, never>;
  readonly cursor: Effect.Effect<number, never>;
  readonly latest: (threadId: string) => Effect.Effect<LatestTurn | null, never>;
  readonly list: (threadId: string) => Effect.Effect<readonly TurnRecord[], never>;
  /** Escape hatch — direct access to the plain projection. */
  readonly raw: TurnProjection;
}

export class TurnProjectionService extends Context.Tag(
  "@tmux-ide/daemon/runtime/TurnProjectionService",
)<TurnProjectionService, TurnProjectionServiceShape>() {}

// ---------------------------------------------------------------------------
// ChatReactorService
// ---------------------------------------------------------------------------

export interface ChatReactorServiceShape {
  readonly start: Effect.Effect<void, ReactorError>;
  /** Drains the queue + halts further processing. */
  readonly dispose: Effect.Effect<void, ReactorError>;
  /** Wait until the queue is empty and no event is in-flight. */
  readonly drain: Effect.Effect<void, ReactorError>;
  /** Push an event into the reactor's queue. Returns immediately. */
  readonly enqueue: (event: PersistedChatEvent) => Effect.Effect<void, never>;
  /** Escape hatch — direct access to the underlying reactor. */
  readonly raw: Reactor<PersistedChatEvent>;
}

export class ChatReactorService extends Context.Tag(
  "@tmux-ide/daemon/runtime/ChatReactorService",
)<ChatReactorService, ChatReactorServiceShape>() {}
