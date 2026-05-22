/**
 * Sqlite-backed event store for the chat aggregate (G14-T05 / T090).
 *
 * Mirrors t3's `apps/server/src/persistence/Services/OrchestrationEventStore.ts`
 * minus the Effect runtime — plain TS + Zod here; Effect adoption is
 * G14-T07 territory. Phase-1 scope per
 * `docs/goal-14-architecture-parity.md` §2.1: append + read; projections
 * land in T091.
 *
 * Storage layout (see §2.1 DDL):
 *   - `chat_events`           — the append-only event log.
 *   - `chat_commands`         — Phase-3 command receipts; DDL only.
 *   - `projection_state`      — Phase-2 cursors; DDL only.
 *   - `projection_turns`      — Phase-2 turn projection; DDL only.
 *   - `projection_activities` — Phase-2 activity projection; DDL only.
 *   - `projection_checkpoints`— Phase-2 checkpoint projection; DDL only.
 *   - `projection_sessions`   — Phase-2 session projection (T078); DDL only.
 *
 * The Phase-2 projection tables are landed empty now so T091 can replay
 * into them without a schema migration.
 *
 * Invariants:
 *   - `sequence` is globally monotonic (AUTOINCREMENT PK).
 *   - `(aggregate_kind, stream_id, stream_version)` is unique and
 *     monotonic per stream. Assignment happens *inside* the INSERT via a
 *     correlated subquery — sqlite serializes writes, so the subquery
 *     sees the latest version atomically.
 *   - `payload_json` is the original `ChatThreadEvent` JSON; read-side
 *     validation uses `ChatThreadEventZ`. We do not re-encode on write.
 */

import { randomUUID } from "node:crypto";
import { ChatThreadEventZ, type ChatThreadEvent } from "@tmux-ide/contracts";
import type { SqliteDb } from "../lib/sqlite-adapter.ts";
import type { ChatEventReader, PersistedChatEvent } from "./types.ts";

export type ChatEventActorKind = "user" | "provider" | "system";

export type ChatEventAggregateKind = "thread" | "turn" | "session" | "checkpoint" | "plan";

export type { PersistedChatEvent } from "./types.ts";

export interface AppendInput {
  event: ChatThreadEvent;
  actorKind: ChatEventActorKind;
  /** Optional ULID/UUID. Generated when omitted. */
  eventId?: string;
  /** ISO-8601. Generated when omitted. */
  occurredAt?: string;
  correlationId?: string;
  causationEventId?: string;
  commandId?: string;
  /** Denormalized for multi-agent queries (T078). */
  sessionId?: string;
  /** Free-form metadata serialized as JSON. */
  metadata?: Record<string, unknown>;
}

/**
 * The store satisfies the `ChatEventReader` contract from `./types.ts`
 * (used by projections in T091) plus the append-side surface.
 */
export interface ChatEventStore extends ChatEventReader {
  append(input: AppendInput): PersistedChatEvent;
  readByStream(
    streamId: string,
    options?: { aggregateKind?: ChatEventAggregateKind; sinceVersion?: number; limit?: number },
  ): PersistedChatEvent[];
  readAll(): Generator<PersistedChatEvent>;
}

// ---------------------------------------------------------------------------
// Migrations.
//
// `_chat_migrations` is a separate bookkeeping table so the chat store can
// coexist with `events.sqlite`-style stores that use their own `_migrations`
// table. Each migration is a single SQL string; sqlite runs CREATE TABLE
// IF NOT EXISTS so re-running is a no-op even outside the bookkeeping
// check, but we still gate on `_chat_migrations` so migrations with side
// effects (data backfills in later phases) only run once.
// ---------------------------------------------------------------------------

interface ChatMigration {
  id: number;
  name: string;
  sql: string;
}

const CHAT_MIGRATIONS: ChatMigration[] = [
  {
    id: 1,
    name: "chat_events",
    sql: `
      CREATE TABLE IF NOT EXISTS chat_events (
        sequence            INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id            TEXT NOT NULL UNIQUE,
        aggregate_kind      TEXT NOT NULL,
        stream_id           TEXT NOT NULL,
        stream_version      INTEGER NOT NULL,
        event_type          TEXT NOT NULL,
        occurred_at         TEXT NOT NULL,
        command_id          TEXT,
        causation_event_id  TEXT,
        correlation_id      TEXT,
        actor_kind          TEXT NOT NULL,
        session_id          TEXT,
        payload_json        TEXT NOT NULL,
        metadata_json       TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_events_stream_version
        ON chat_events(aggregate_kind, stream_id, stream_version);
      CREATE INDEX IF NOT EXISTS idx_chat_events_stream_seq
        ON chat_events(aggregate_kind, stream_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_chat_events_correlation
        ON chat_events(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_chat_events_session
        ON chat_events(session_id);
    `,
  },
  {
    id: 2,
    name: "chat_commands",
    sql: `
      CREATE TABLE IF NOT EXISTS chat_commands (
        command_id      TEXT PRIMARY KEY,
        command_type    TEXT NOT NULL,
        received_at     TEXT NOT NULL,
        decided_at      TEXT NOT NULL,
        outcome         TEXT NOT NULL,
        rejection_code  TEXT,
        input_json      TEXT NOT NULL,
        actor_kind      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_commands_received
        ON chat_commands(received_at);
    `,
  },
  {
    id: 3,
    name: "projection_state",
    sql: `
      CREATE TABLE IF NOT EXISTS projection_state (
        projection_name        TEXT PRIMARY KEY,
        last_applied_sequence  INTEGER NOT NULL,
        updated_at             TEXT NOT NULL
      );
    `,
  },
  {
    id: 4,
    name: "projection_turns",
    sql: `
      CREATE TABLE IF NOT EXISTS projection_turns (
        turn_id                TEXT PRIMARY KEY,
        thread_id              TEXT NOT NULL,
        session_id             TEXT,
        state                  TEXT NOT NULL,
        requested_at           TEXT NOT NULL,
        started_at             TEXT,
        completed_at           TEXT,
        assistant_message_id   TEXT,
        source_plan_id         TEXT,
        source_plan_thread_id  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_proj_turns_thread
        ON projection_turns(thread_id);
    `,
  },
  {
    id: 5,
    name: "projection_activities",
    sql: `
      CREATE TABLE IF NOT EXISTS projection_activities (
        activity_id     TEXT PRIMARY KEY,
        thread_id       TEXT NOT NULL,
        turn_id         TEXT,
        session_id      TEXT,
        sequence        INTEGER NOT NULL,
        tone            TEXT NOT NULL,
        kind            TEXT NOT NULL,
        summary         TEXT NOT NULL,
        payload_json    TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_proj_act_thread_seq
        ON projection_activities(thread_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_proj_act_thread_turn
        ON projection_activities(thread_id, turn_id);
      CREATE INDEX IF NOT EXISTS idx_proj_act_thread_session
        ON projection_activities(thread_id, session_id);
    `,
  },
  {
    id: 6,
    name: "projection_checkpoints",
    sql: `
      CREATE TABLE IF NOT EXISTS projection_checkpoints (
        thread_id              TEXT NOT NULL,
        turn_id                TEXT NOT NULL,
        checkpoint_ref         TEXT NOT NULL,
        status                 TEXT NOT NULL,
        files_json             TEXT NOT NULL,
        assistant_message_id   TEXT,
        completed_at           TEXT NOT NULL,
        checkpoint_turn_count  INTEGER NOT NULL,
        PRIMARY KEY (thread_id, turn_id)
      );
    `,
  },
  {
    id: 7,
    name: "projection_sessions",
    sql: `
      CREATE TABLE IF NOT EXISTS projection_sessions (
        session_id              TEXT NOT NULL,
        thread_id               TEXT NOT NULL,
        status                  TEXT NOT NULL,
        provider_name           TEXT,
        provider_instance_id    TEXT,
        role                    TEXT,
        display_name            TEXT,
        runtime_mode            TEXT NOT NULL,
        active_turn_id          TEXT,
        last_error              TEXT,
        updated_at              TEXT NOT NULL,
        PRIMARY KEY (thread_id, session_id)
      );
    `,
  },
];

/**
 * Apply the standard pragma set we want on every chat-event-store db:
 *   - `journal_mode = WAL`  → readers don't block writers; the daemon
 *     can stream events from sqlite while reactors append.
 *   - `synchronous = NORMAL` → trades durable-on-syscall for durable-on-
 *     checkpoint. Crash recovery still works (WAL is replayed); we accept
 *     losing the most recent N ms of writes on a power cut. Event sourcing
 *     means the worst case is one replayed reactor cycle, not data loss.
 *   - `foreign_keys = ON`   → defensive default; the schema has no FKs yet
 *     but projections in T091 will.
 *
 * Without these the perf gate (1000 appends under 100 ms) fails badly: a
 * default sqlite open fsyncs every commit, and our schema has one
 * INSERT per event.
 */
export function applyChatStorePragmas(db: SqliteDb): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
}

/**
 * Idempotent migration runner. Safe to call on every daemon start.
 * Exported for tests that want to assert ordering or post-migration shape.
 */
export function runChatStoreMigrations(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _chat_migrations (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    );
  `);
  const applied = new Set(
    db
      .prepare("SELECT id FROM _chat_migrations")
      .all<{ id: number }>()
      .map((r) => r.id),
  );
  const insert = db.prepare("INSERT INTO _chat_migrations (id, name, applied_at) VALUES (?, ?, ?)");
  const now = new Date().toISOString();
  for (const migration of CHAT_MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec(migration.sql);
    insert.run(migration.id, migration.name, now);
  }
}

// ---------------------------------------------------------------------------
// Event store
// ---------------------------------------------------------------------------

interface ChatEventRow {
  sequence: number;
  event_id: string;
  aggregate_kind: string;
  stream_id: string;
  stream_version: number;
  event_type: string;
  occurred_at: string;
  command_id: string | null;
  causation_event_id: string | null;
  correlation_id: string | null;
  actor_kind: string;
  session_id: string | null;
  payload_json: string;
  metadata_json: string;
}

/** Map an internal ChatThreadEvent to its aggregate_kind. */
function aggregateKindForEvent(event: ChatThreadEvent): ChatEventAggregateKind {
  // The discriminator in the contract is `type`; reuse its prefix so we
  // don't duplicate the map maintained in chat-thread.ts.
  switch (event.type) {
    case "chat.turn.started":
    case "chat.turn.completed":
    case "chat.turn.aborted":
      return "turn";
    case "chat.plan.upserted":
      return "plan";
    case "chat.checkpoint.created":
      return "checkpoint";
    case "chat.session.added":
    case "chat.session.removed":
    case "chat.session.status-changed":
      return "session";
    case "chat.activity.appended":
    case "chat.thread.reverted":
      return "thread";
  }
}

/**
 * Pick the stream identifier for an event. All current ChatThreadEvent
 * shapes carry `threadId`; per-turn / per-session events stream on the
 * thread but are still indexed by `aggregate_kind` so `readByStream`
 * with an explicit kind narrows correctly.
 */
function streamIdForEvent(event: ChatThreadEvent): string {
  return event.threadId;
}

function rowToPersisted(row: ChatEventRow): PersistedChatEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch (err) {
    throw new Error(
      `chat-event-store: payload_json for sequence ${row.sequence} is not valid JSON`,
      { cause: err },
    );
  }
  const parsed = ChatThreadEventZ.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `chat-event-store: payload at sequence ${row.sequence} failed ChatThreadEventZ validation: ${parsed.error.message}`,
    );
  }
  let metadata: Record<string, unknown> = {};
  if (row.metadata_json && row.metadata_json !== "{}") {
    try {
      const meta = JSON.parse(row.metadata_json);
      if (meta && typeof meta === "object" && !Array.isArray(meta)) {
        metadata = meta as Record<string, unknown>;
      }
    } catch {
      // Metadata is best-effort: corrupted JSON should not break a read.
    }
  }
  // Optional fields are emitted as `undefined` (not `null`) so the
  // returned shape lines up with `PersistedChatEvent` from types.ts —
  // the canonical interface T091's turn projection consumes.
  const persisted: PersistedChatEvent = {
    sequence: row.sequence,
    eventId: row.event_id,
    aggregateKind: row.aggregate_kind,
    streamId: row.stream_id,
    streamVersion: row.stream_version,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    actorKind: row.actor_kind as ChatEventActorKind,
    event: parsed.data,
    metadata,
  };
  if (row.command_id !== null) persisted.commandId = row.command_id;
  if (row.causation_event_id !== null) persisted.causationEventId = row.causation_event_id;
  if (row.correlation_id !== null) persisted.correlationId = row.correlation_id;
  if (row.session_id !== null) persisted.sessionId = row.session_id;
  return persisted;
}

export function makeChatEventStore(db: SqliteDb): ChatEventStore {
  applyChatStorePragmas(db);
  runChatStoreMigrations(db);

  // Subscribers receive every persisted event in append order. The
  // handler runs synchronously in the append path; projections (T091)
  // use it to advance their cursor without polling. A throwing handler
  // is caught + logged here so one buggy reactor cannot stall the
  // append loop or corrupt the in-flight write. Matches the failure-
  // isolation principle in §2.3.
  const subscribers = new Set<(event: PersistedChatEvent) => void>();

  // Correlated subquery assigns stream_version atomically. sqlite
  // serializes writes; the subquery observes the latest committed value
  // for the same (aggregate_kind, stream_id) tuple, so concurrent appends
  // can't collide on the unique index.
  //
  // Implementation note: `RETURNING` is sqlite ≥ 3.35 (2021). better-
  // sqlite3 12.x ships with a newer engine; bun:sqlite (used in tests)
  // also supports it. We read the assigned (sequence, stream_version)
  // back via a follow-up SELECT keyed on event_id rather than RETURNING,
  // for compatibility with thin sqlite shims that don't surface the
  // result columns.
  const appendStmt = db.prepare(`
    INSERT INTO chat_events (
      event_id, aggregate_kind, stream_id, stream_version,
      event_type, occurred_at, command_id, causation_event_id,
      correlation_id, actor_kind, session_id, payload_json, metadata_json
    ) VALUES (
      ?, ?, ?,
      (SELECT COALESCE(MAX(stream_version), 0) + 1
       FROM chat_events
       WHERE aggregate_kind = ? AND stream_id = ?),
      ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);
  const readBackStmt = db.prepare(`
    SELECT sequence, event_id, aggregate_kind, stream_id, stream_version,
           event_type, occurred_at, command_id, causation_event_id,
           correlation_id, actor_kind, session_id, payload_json, metadata_json
    FROM chat_events
    WHERE event_id = ?
  `);
  const readFromSeqStmt = db.prepare(`
    SELECT sequence, event_id, aggregate_kind, stream_id, stream_version,
           event_type, occurred_at, command_id, causation_event_id,
           correlation_id, actor_kind, session_id, payload_json, metadata_json
    FROM chat_events
    WHERE sequence > ?
    ORDER BY sequence ASC
    LIMIT ?
  `);
  const readAllStmt = db.prepare(`
    SELECT sequence, event_id, aggregate_kind, stream_id, stream_version,
           event_type, occurred_at, command_id, causation_event_id,
           correlation_id, actor_kind, session_id, payload_json, metadata_json
    FROM chat_events
    ORDER BY sequence ASC
  `);

  function append(input: AppendInput): PersistedChatEvent {
    // Validate the incoming event before persisting. We want a typed
    // failure at the boundary rather than a corrupt row that only shows
    // up on read.
    const validated = ChatThreadEventZ.safeParse(input.event);
    if (!validated.success) {
      throw new Error(
        `chat-event-store.append: event failed ChatThreadEventZ validation: ${validated.error.message}`,
      );
    }
    const event = validated.data;
    const aggregateKind = aggregateKindForEvent(event);
    const streamId = streamIdForEvent(event);
    const eventId = input.eventId ?? randomUUID();
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const payloadJson = JSON.stringify(event);
    const metadataJson = JSON.stringify(input.metadata ?? {});
    appendStmt.run(
      eventId,
      aggregateKind,
      streamId,
      // correlated subquery params
      aggregateKind,
      streamId,
      // remaining columns
      event.type,
      occurredAt,
      input.commandId ?? null,
      input.causationEventId ?? null,
      input.correlationId ?? null,
      input.actorKind,
      input.sessionId ?? null,
      payloadJson,
      metadataJson,
    );
    const row = readBackStmt.get?.<ChatEventRow>(eventId);
    if (!row) {
      throw new Error(
        `chat-event-store.append: insert succeeded but read-back returned no row for event_id=${eventId}`,
      );
    }
    const persisted = rowToPersisted(row);
    for (const handler of subscribers) {
      try {
        handler(persisted);
      } catch (err) {
        // A buggy subscriber must not roll back the write or stall
        // sibling subscribers. Log via console.error so the daemon
        // surface picks it up; reactors observe the failure via their
        // own audit channel (T092 chat.reactor.failure event).
        // eslint-disable-next-line no-console
        console.error("[chat-event-store] subscriber threw:", err);
      }
    }
    return persisted;
  }

  function subscribe(handler: (event: PersistedChatEvent) => void): () => void {
    subscribers.add(handler);
    return () => {
      subscribers.delete(handler);
    };
  }

  function readFromSequence(seqExclusive: number, limit = 1000): PersistedChatEvent[] {
    const rows = readFromSeqStmt.all<ChatEventRow>(seqExclusive, limit);
    return rows.map(rowToPersisted);
  }

  function readByStream(
    streamId: string,
    options: { aggregateKind?: ChatEventAggregateKind; sinceVersion?: number; limit?: number } = {},
  ): PersistedChatEvent[] {
    const since = options.sinceVersion ?? 0;
    const limit = options.limit ?? 10_000;
    if (options.aggregateKind) {
      const stmt = db.prepare(`
        SELECT sequence, event_id, aggregate_kind, stream_id, stream_version,
               event_type, occurred_at, command_id, causation_event_id,
               correlation_id, actor_kind, session_id, payload_json, metadata_json
        FROM chat_events
        WHERE aggregate_kind = ? AND stream_id = ? AND stream_version > ?
        ORDER BY stream_version ASC
        LIMIT ?
      `);
      return stmt
        .all<ChatEventRow>(options.aggregateKind, streamId, since, limit)
        .map(rowToPersisted);
    }
    const stmt = db.prepare(`
      SELECT sequence, event_id, aggregate_kind, stream_id, stream_version,
             event_type, occurred_at, command_id, causation_event_id,
             correlation_id, actor_kind, session_id, payload_json, metadata_json
      FROM chat_events
      WHERE stream_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `);
    return stmt.all<ChatEventRow>(streamId, since, limit).map(rowToPersisted);
  }

  function* readAll(): Generator<PersistedChatEvent> {
    // Could stream via a sqlite cursor; better-sqlite3's `iterate()` is
    // ideal but not exposed by the shim. For our event volumes (a few
    // thousand per active thread) materializing into memory is fine.
    const rows = readAllStmt.all<ChatEventRow>();
    for (const row of rows) yield rowToPersisted(row);
  }

  return { append, subscribe, readFromSequence, readByStream, readAll };
}
