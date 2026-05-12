/**
 * T091 ↔ T090 integration: drive the real sqlite ChatEventStore through
 * the turn projection. Replaces the FakeEventReader test double with
 * the production reader so we prove the contract surface (PersistedChatEvent,
 * readFromSequence, subscribe) lines up across modules.
 *
 * Acceptance scenarios:
 *   - Bootstrap replay from a populated store reconstructs the same turn
 *     state on a fresh projection.
 *   - Incremental ingest fires subscribers for events appended after
 *     start().
 *   - Daemon-restart determinism: closing the db + reopening + starting
 *     a fresh projection over the persisted log produces identical state.
 *   - Projection cursor advances monotonically and matches the last
 *     applied event sequence.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChatThreadEvent } from "@tmux-ide/contracts";
import { openDatabase, type SqliteDb } from "../../../lib/sqlite-adapter.ts";
import { makeChatEventStore, type ChatEventStore } from "../../chat-event-store.ts";
import { makeInMemoryCursorStore } from "../../types.ts";
import { makeTurnProjection } from "../turn-projection.ts";

function turnStarted(threadId: string, turnId: string, ts = "2026-01-01T00:00:00.000Z"): ChatThreadEvent {
  return {
    type: "chat.turn.started",
    threadId,
    turnId,
    requestedAt: ts,
  };
}

function turnCompleted(threadId: string, turnId: string, ts = "2026-01-01T00:01:00.000Z"): ChatThreadEvent {
  return {
    type: "chat.turn.completed",
    threadId,
    turnId,
    state: "completed",
    completedAt: ts,
  };
}

function turnAborted(threadId: string, turnId: string): ChatThreadEvent {
  return {
    type: "chat.turn.aborted",
    threadId,
    turnId,
    reason: "cancelled",
  };
}

describe("turn-projection × chat-event-store (sqlite)", () => {
  let dir: string;
  let dbPath: string;
  let db: SqliteDb;
  let store: ChatEventStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tmux-ide-projection-sqlite-"));
    dbPath = join(dir, "daemon.sqlite");
    db = openDatabase(dbPath);
    store = makeChatEventStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("bootstrap replay rebuilds turn state from a populated store", () => {
    store.append({ event: turnStarted("T1", "turn-1"), actorKind: "user" });
    store.append({ event: turnCompleted("T1", "turn-1"), actorKind: "provider" });
    store.append({ event: turnStarted("T1", "turn-2"), actorKind: "user" });
    store.append({ event: turnStarted("T2", "turn-x"), actorKind: "user" });

    const projection = makeTurnProjection({
      reader: store,
      cursorStore: makeInMemoryCursorStore(),
    });
    projection.start();

    expect(projection.cursor()).toBe(4);
    expect(projection.get("T1", "turn-1")?.state).toBe("completed");
    expect(projection.get("T1", "turn-2")?.state).toBe("running");
    expect(projection.latest("T1")?.turnId).toBe("turn-2");
    expect(projection.list("T1")).toHaveLength(2);
    expect(projection.list("T2")).toHaveLength(1);
    projection.stop();
  });

  it("incremental ingest: events appended after start() flow to the projection", () => {
    const projection = makeTurnProjection({
      reader: store,
      cursorStore: makeInMemoryCursorStore(),
    });
    projection.start();
    expect(projection.cursor()).toBe(0);

    store.append({ event: turnStarted("T1", "turn-1"), actorKind: "user" });
    expect(projection.cursor()).toBe(1);
    expect(projection.get("T1", "turn-1")?.state).toBe("running");

    store.append({ event: turnAborted("T1", "turn-1"), actorKind: "system" });
    expect(projection.cursor()).toBe(2);
    expect(projection.get("T1", "turn-1")?.state).toBe("interrupted");
    projection.stop();
  });

  it("cursor advances 1-by-1 even for events the projection ignores", () => {
    // Activity events are not turn events but they still advance the
    // global sequence. The projection ingests them as no-ops; cursor
    // tracking must still advance or it would gap on the next turn
    // event.
    store.append({
      event: {
        type: "chat.activity.appended",
        threadId: "T1",
        seq: 0,
        activity: {
          id: "A1",
          tone: "info",
          kind: "user.message",
          summary: "hi",
          payload: {},
          turnId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      } as ChatThreadEvent,
      actorKind: "user",
    });
    store.append({ event: turnStarted("T1", "turn-1"), actorKind: "user" });

    const projection = makeTurnProjection({
      reader: store,
      cursorStore: makeInMemoryCursorStore(),
    });
    projection.start();

    expect(projection.cursor()).toBe(2);
    expect(projection.get("T1", "turn-1")?.state).toBe("running");
    projection.stop();
  });

  it("daemon-restart determinism: two fresh boots over the same log produce identical state", () => {
    store.append({ event: turnStarted("T1", "turn-1"), actorKind: "user" });
    store.append({ event: turnCompleted("T1", "turn-1"), actorKind: "provider" });
    store.append({ event: turnStarted("T1", "turn-2"), actorKind: "user" });

    const boot1 = makeTurnProjection({
      reader: store,
      cursorStore: makeInMemoryCursorStore(),
    });
    boot1.start();
    const snapshot1 = boot1.list("T1").map((t) => ({ turnId: t.turnId, state: t.state }));
    boot1.stop();

    db.close();

    // Reopen the same db file — proves persistence + idempotent
    // migrations + deterministic replay.
    db = openDatabase(dbPath);
    store = makeChatEventStore(db);
    const boot2 = makeTurnProjection({
      reader: store,
      cursorStore: makeInMemoryCursorStore(),
    });
    boot2.start();
    const snapshot2 = boot2.list("T1").map((t) => ({ turnId: t.turnId, state: t.state }));
    boot2.stop();

    expect(snapshot2).toEqual(snapshot1);
    expect(snapshot2).toEqual([
      { turnId: "turn-1", state: "completed" },
      { turnId: "turn-2", state: "running" },
    ]);
  });

  it("cursor persistence: a saved cursor skips already-applied events on resume", () => {
    // The cursor store records "I have already applied up to N". On
    // the next boot the projection only replays events > N. Read-model
    // durability across boots is the projection_turns table (T091's
    // proof notes this is in-memory today; a sqlite-backed read model
    // lands in G14-T06). Here we just prove the cursor itself is the
    // resume point — boot2 must NOT re-apply the already-seen events.
    store.append({ event: turnStarted("T1", "turn-1"), actorKind: "user" });
    store.append({ event: turnCompleted("T1", "turn-1"), actorKind: "provider" });

    const cursors = makeInMemoryCursorStore();
    const boot1 = makeTurnProjection({ reader: store, cursorStore: cursors });
    boot1.start();
    expect(boot1.cursor()).toBe(2);
    boot1.stop();
    expect(cursors.load("turn")).toBe(2);

    // New event after the saved cursor.
    store.append({ event: turnStarted("T1", "turn-2"), actorKind: "user" });

    const boot2 = makeTurnProjection({ reader: store, cursorStore: cursors });
    boot2.start();
    expect(boot2.cursor()).toBe(3);
    // turn-1 events are sequence 1+2, both ≤ saved cursor (2) → skipped.
    // turn-2 (sequence 3) is replayed and visible.
    expect(boot2.get("T1", "turn-1")).toBeNull();
    expect(boot2.get("T1", "turn-2")?.state).toBe("running");
    boot2.stop();
  });

  it("subscriber failure isolation: a throwing handler does not stop sibling subscribers or rollback the write", () => {
    let goodCalls = 0;
    const unsubBad = store.subscribe(() => {
      throw new Error("boom");
    });
    const unsubGood = store.subscribe(() => {
      goodCalls++;
    });

    // Silence the expected console.error from the throwing subscriber.
    const origError = console.error;
    console.error = () => undefined;
    try {
      store.append({ event: turnStarted("T1", "turn-1"), actorKind: "user" });
    } finally {
      console.error = origError;
    }

    expect(goodCalls).toBe(1);
    expect([...store.readAll()]).toHaveLength(1);
    unsubBad();
    unsubGood();
  });
});
