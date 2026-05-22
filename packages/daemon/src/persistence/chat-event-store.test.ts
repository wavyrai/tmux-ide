import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatThreadEvent } from "@tmux-ide/contracts";
import { openDatabase, type SqliteDb } from "../lib/sqlite-adapter.ts";
import {
  makeChatEventStore,
  runChatStoreMigrations,
  type ChatEventStore,
} from "./chat-event-store.ts";

function activityEvent(
  threadId: string,
  activityId: string,
  seq: number,
  turnId: string | null = null,
): ChatThreadEvent {
  return {
    type: "chat.activity.appended",
    threadId,
    seq,
    activity: {
      id: activityId,
      tone: "info",
      kind: "user.message",
      summary: `activity ${activityId}`,
      payload: { text: `hello ${activityId}` },
      turnId,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  } satisfies ChatThreadEvent;
}

function turnStartedEvent(threadId: string, turnId: string): ChatThreadEvent {
  return {
    type: "chat.turn.started",
    threadId,
    turnId,
    requestedAt: "2026-01-01T00:00:00.000Z",
  } satisfies ChatThreadEvent;
}

function turnAbortedEvent(threadId: string, turnId: string): ChatThreadEvent {
  return {
    type: "chat.turn.aborted",
    threadId,
    turnId,
    reason: "cancelled",
  } satisfies ChatThreadEvent;
}

describe("chat-event-store", () => {
  let dir: string;
  let dbPath: string;
  let db: SqliteDb;
  let store: ChatEventStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tmux-ide-chat-events-"));
    dbPath = join(dir, "daemon.sqlite");
    db = openDatabase(dbPath);
    store = makeChatEventStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("migrations create all 7 tables idempotently", () => {
    // Second call must be a no-op.
    runChatStoreMigrations(db);
    runChatStoreMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all<{ name: string }>()
      .map((r) => r.name);
    for (const required of [
      "_chat_migrations",
      "chat_events",
      "chat_commands",
      "projection_state",
      "projection_turns",
      "projection_activities",
      "projection_checkpoints",
      "projection_sessions",
    ]) {
      expect(tables).toContain(required);
    }
    // The bookkeeping table records exactly 7 migrations.
    const count = db.prepare("SELECT COUNT(*) AS n FROM _chat_migrations").get?.<{ n: number }>();
    expect(count?.n).toBe(7);
  });

  it("indexes on chat_events are present", () => {
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='chat_events' ORDER BY name",
      )
      .all<{ name: string }>()
      .map((r) => r.name);
    expect(idx).toContain("idx_chat_events_stream_version");
    expect(idx).toContain("idx_chat_events_stream_seq");
    expect(idx).toContain("idx_chat_events_correlation");
    expect(idx).toContain("idx_chat_events_session");
  });

  it("append assigns monotonic sequence + stream_version per stream", () => {
    const a1 = store.append({ event: activityEvent("T1", "A1", 0), actorKind: "user" });
    const a2 = store.append({ event: activityEvent("T1", "A2", 1), actorKind: "user" });
    const a3 = store.append({ event: activityEvent("T2", "A3", 0), actorKind: "user" });
    const a4 = store.append({ event: activityEvent("T1", "A4", 2), actorKind: "user" });

    expect(a1.sequence).toBe(1);
    expect(a2.sequence).toBe(2);
    expect(a3.sequence).toBe(3);
    expect(a4.sequence).toBe(4);

    // Stream versions are per-(aggregate_kind, stream_id).
    expect(a1.streamVersion).toBe(1);
    expect(a2.streamVersion).toBe(2);
    expect(a3.streamVersion).toBe(1); // first event on T2
    expect(a4.streamVersion).toBe(3); // third event on T1
  });

  it("appended event is recoverable by readBackStmt and equal in shape", () => {
    const evt = activityEvent("T1", "A1", 0, "turn-1");
    const stored = store.append({
      event: evt,
      actorKind: "user",
      sessionId: "S1",
      correlationId: "corr-1",
      metadata: { source: "test" },
    });
    expect(stored.aggregateKind).toBe("thread");
    expect(stored.streamId).toBe("T1");
    expect(stored.eventType).toBe("chat.activity.appended");
    expect(stored.sessionId).toBe("S1");
    expect(stored.correlationId).toBe("corr-1");
    expect(stored.metadata).toEqual({ source: "test" });
    expect(stored.event).toEqual(evt);
  });

  it("turn events resolve to aggregate_kind='turn' and reuse threadId as stream", () => {
    const t1 = store.append({ event: turnStartedEvent("T1", "turn-1"), actorKind: "provider" });
    expect(t1.aggregateKind).toBe("turn");
    expect(t1.streamId).toBe("T1");
    expect(t1.streamVersion).toBe(1);

    const t2 = store.append({ event: turnAbortedEvent("T1", "turn-1"), actorKind: "provider" });
    expect(t2.aggregateKind).toBe("turn");
    expect(t2.streamVersion).toBe(2); // same (kind, stream) → increments
  });

  it("readFromSequence(seq, limit) paginates global order", () => {
    for (let i = 0; i < 25; i++) {
      store.append({ event: activityEvent("T1", `A${i}`, i), actorKind: "user" });
    }
    const page1 = store.readFromSequence(0, 10);
    const page2 = store.readFromSequence(page1.at(-1)!.sequence, 10);
    const page3 = store.readFromSequence(page2.at(-1)!.sequence, 10);
    expect(page1).toHaveLength(10);
    expect(page2).toHaveLength(10);
    expect(page3).toHaveLength(5);
    expect(page1[0]!.sequence).toBe(1);
    expect(page2[0]!.sequence).toBe(11);
    expect(page3[0]!.sequence).toBe(21);
  });

  it("readByStream filters by streamId and respects sinceVersion", () => {
    store.append({ event: activityEvent("T1", "A1", 0), actorKind: "user" });
    store.append({ event: activityEvent("T2", "A2", 0), actorKind: "user" });
    store.append({ event: activityEvent("T1", "A3", 1), actorKind: "user" });
    store.append({ event: activityEvent("T1", "A4", 2), actorKind: "user" });

    const t1All = store.readByStream("T1");
    expect(t1All.map((e) => (e.event as { activity: { id: string } }).activity.id)).toEqual([
      "A1",
      "A3",
      "A4",
    ]);

    const sinceVersion1 = store.readByStream("T1", { aggregateKind: "thread", sinceVersion: 1 });
    expect(sinceVersion1.map((e) => e.streamVersion)).toEqual([2, 3]);
  });

  it("readByStream narrows by aggregate_kind so turn and activity streams stay separate", () => {
    store.append({ event: activityEvent("T1", "A1", 0), actorKind: "user" });
    store.append({ event: turnStartedEvent("T1", "turn-1"), actorKind: "provider" });
    store.append({ event: turnAbortedEvent("T1", "turn-1"), actorKind: "provider" });

    const threadStream = store.readByStream("T1", { aggregateKind: "thread" });
    const turnStream = store.readByStream("T1", { aggregateKind: "turn" });
    expect(threadStream).toHaveLength(1);
    expect(turnStream).toHaveLength(2);
    expect(turnStream.map((e) => e.streamVersion)).toEqual([1, 2]);
  });

  it("readAll yields every row in sequence order", () => {
    for (let i = 0; i < 7; i++) {
      store.append({ event: activityEvent("T1", `A${i}`, i), actorKind: "user" });
    }
    const all = [...store.readAll()];
    expect(all).toHaveLength(7);
    const seqs = all.map((e) => e.sequence);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(seqs).toEqual(sorted);
  });

  it("rejects malformed events at append time via ChatThreadEventZ", () => {
    const bogus = { type: "chat.activity.appended", threadId: "T1" } as unknown as ChatThreadEvent;
    expect(() => store.append({ event: bogus, actorKind: "user" })).toThrow(
      /ChatThreadEventZ validation/,
    );
  });

  it("rejects payload that fails schema on read", () => {
    // Bypass the safeguarded append and write directly so we can simulate
    // a row that drifted under us (e.g. older migration).
    db.prepare(
      `INSERT INTO chat_events (event_id, aggregate_kind, stream_id, stream_version,
         event_type, occurred_at, actor_kind, payload_json, metadata_json)
       VALUES ('bad-1', 'thread', 'T1', 1, 'chat.activity.appended',
               '2026-01-01T00:00:00.000Z', 'user', '{"type":"chat.activity.appended"}', '{}')`,
    ).run();
    expect(() => store.readFromSequence(0)).toThrow(/ChatThreadEventZ validation/);
  });

  it("rejects payload that is not valid JSON", () => {
    db.prepare(
      `INSERT INTO chat_events (event_id, aggregate_kind, stream_id, stream_version,
         event_type, occurred_at, actor_kind, payload_json, metadata_json)
       VALUES ('bad-2', 'thread', 'T1', 1, 'chat.activity.appended',
               '2026-01-01T00:00:00.000Z', 'user', 'not-json', '{}')`,
    ).run();
    expect(() => store.readFromSequence(0)).toThrow(/not valid JSON/);
  });

  it("survives reopen — migrations are no-ops on a populated db", () => {
    store.append({ event: activityEvent("T1", "A1", 0), actorKind: "user" });
    db.close();

    const db2 = openDatabase(dbPath);
    const store2 = makeChatEventStore(db2);
    const all = [...store2.readAll()];
    expect(all).toHaveLength(1);
    expect(all[0]!.streamVersion).toBe(1);

    // Appending after reopen continues monotonic numbering.
    const next = store2.append({ event: activityEvent("T1", "A2", 1), actorKind: "user" });
    expect(next.sequence).toBe(2);
    expect(next.streamVersion).toBe(2);
    db2.close();
    db = openDatabase(dbPath); // restore so afterEach can close cleanly
    store = makeChatEventStore(db);
  });

  it("metadata defaults to {} when omitted; roundtrips object values", () => {
    const a = store.append({ event: activityEvent("T1", "A1", 0), actorKind: "user" });
    expect(a.metadata).toEqual({});
    const b = store.append({
      event: activityEvent("T1", "A2", 1),
      actorKind: "user",
      metadata: { run_id: "run-1", tags: ["a", "b"] },
    });
    expect(b.metadata).toEqual({ run_id: "run-1", tags: ["a", "b"] });
  });

  it("unique constraint on (aggregate_kind, stream_id, stream_version) blocks duplicates", () => {
    // Direct INSERT bypassing the correlated subquery — simulates a buggy
    // appender. The unique index must reject it.
    store.append({ event: activityEvent("T1", "A1", 0), actorKind: "user" });
    expect(() => {
      db.prepare(
        `INSERT INTO chat_events (event_id, aggregate_kind, stream_id, stream_version,
           event_type, occurred_at, actor_kind, payload_json, metadata_json)
         VALUES ('dup-1', 'thread', 'T1', 1, 'chat.activity.appended',
                 '2026-01-01T00:00:00.000Z', 'user',
                 '${JSON.stringify(activityEvent("T1", "A1", 0)).replace(/'/g, "''")}', '{}')`,
      ).run();
    }).toThrow();
  });

  it("perf: 1000 appends + readFromSequence(0, 1000) under 100 ms", () => {
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      store.append({ event: activityEvent("T1", `A${i}`, i), actorKind: "user" });
    }
    const all = store.readFromSequence(0, 1000);
    const elapsed = performance.now() - t0;
    expect(all).toHaveLength(1000);
    // Acceptance gate from goal-14 §2.1 Phase 1.
    expect(elapsed).toBeLessThan(100);
  });
});
