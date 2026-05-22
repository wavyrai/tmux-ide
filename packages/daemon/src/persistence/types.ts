/**
 * G14-T091 — shared contract surface between the chat event store (T090)
 * and the projections that consume from it.
 *
 * The event store (T090, packages/daemon/src/persistence/chat-event-store.ts)
 * implements `ChatEventReader`. Projections (this directory's `projections/`)
 * consume from that interface and persist their cursor via
 * `ProjectionCursorStore`. Both interfaces stay storage-agnostic so an
 * in-memory implementation can drive tests with no sqlite dependency.
 */

import type { ChatThreadEvent } from "@tmux-ide/contracts";

/**
 * One event as it lives in the event log. The `event` field carries the
 * canonical `ChatThreadEvent` discriminated union from contracts; the
 * surrounding fields are the persistence-layer envelope (sequence, ids,
 * causality, occurredAt, actor).
 */
export interface PersistedChatEvent {
  /** Monotonic, store-wide. Assigned by the event store on append. */
  sequence: number;
  /** Stable per-event id (ulid/uuid). Set on append. */
  eventId: string;
  /** ISO8601 timestamp recorded at append-time. */
  occurredAt: string;
  /** Aggregate kind: "thread" | "turn" | "session" | "checkpoint" | "plan". */
  aggregateKind: string;
  /** Stream key — typically a threadId for thread-scoped events. */
  streamId: string;
  /** Per-stream monotonic version. */
  streamVersion: number;
  /**
   * Convenience copy of `event.type`. Stored as its own column on
   * `chat_events` so reactors can filter without parsing payload JSON.
   * Optional in the contract so test doubles don't have to redeclare it.
   */
  eventType?: string;
  /** Who emitted this. */
  actorKind: "user" | "provider" | "system";
  /** Optional cross-event correlation id. */
  correlationId?: string;
  /** The event that caused this one (for reactor chains). */
  causationEventId?: string;
  /** Ties the event back to its `chat_commands` receipt (Phase 3). */
  commandId?: string;
  /** Optional denormalized session attribution (T078). */
  sessionId?: string;
  /** Free-form envelope metadata; defaults to `{}` on read. */
  metadata?: Record<string, unknown>;
  /** The typed event payload. */
  event: ChatThreadEvent;
}

/**
 * Read API the event store exposes to projections.
 *
 * Projections call `readFromSequence` during bootstrap to catch up from
 * their persisted cursor, then `subscribe` to receive new events as they
 * are appended.
 */
export interface ChatEventReader {
  /**
   * Read events with `sequence > seqExclusive`, in ascending order, up to
   * `limit` rows. Returns an empty array when no more events exist after
   * `seqExclusive`. The store guarantees no gaps: consecutive rows have
   * consecutive sequence numbers.
   */
  readFromSequence(seqExclusive: number, limit?: number): PersistedChatEvent[];

  /**
   * Subscribe to events appended AFTER subscription. The handler runs
   * synchronously in the append path; throwing from it must not corrupt
   * the store. Returns an unsubscribe function.
   */
  subscribe(handler: (event: PersistedChatEvent) => void): () => void;
}

/**
 * Persistence for a projection's "last applied sequence" cursor. T090
 * ships a sqlite-backed implementation against the `projection_state`
 * table; tests use an in-memory map.
 */
export interface ProjectionCursorStore {
  /** Returns the last applied sequence for a named projection, or 0 if unseen. */
  load(name: string): number;
  /** Persists the new cursor value. Must be atomic relative to event ingest. */
  save(name: string, lastAppliedSequence: number): void;
}

/**
 * Thrown when a projection observes a sequence gap (e.g. a new subscribed
 * event arrives with sequence != cursor + 1). The projection refuses to
 * advance — the daemon must reload from the event store to fill the gap.
 */
export class ProjectionGapError extends Error {
  constructor(
    readonly projectionName: string,
    readonly expectedSequence: number,
    readonly observedSequence: number,
  ) {
    super(
      `Projection "${projectionName}" gap: expected sequence ${expectedSequence}, observed ${observedSequence}`,
    );
    this.name = "ProjectionGapError";
  }
}

/**
 * In-memory cursor store for tests and ephemeral daemons.
 */
export function makeInMemoryCursorStore(): ProjectionCursorStore {
  const map = new Map<string, number>();
  return {
    load(name) {
      return map.get(name) ?? 0;
    },
    save(name, lastAppliedSequence) {
      map.set(name, lastAppliedSequence);
    },
  };
}
