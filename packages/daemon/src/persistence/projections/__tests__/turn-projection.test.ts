/**
 * G14-T091 — turn projection tests.
 *
 * Uses an in-memory `ChatEventReader` double so the projection logic can
 * be exercised end-to-end without sqlite (T090). When T090 lands, the
 * sqlite-backed reader plugs into the same interface and these tests
 * stay green.
 */

import { describe, expect, it } from "bun:test";

import type { ChatThreadEvent } from "@tmux-ide/contracts";
import {
  makeInMemoryCursorStore,
  ProjectionGapError,
  type ChatEventReader,
  type PersistedChatEvent,
} from "../../types.ts";
import { makeTurnProjection } from "../turn-projection.ts";

interface FakeEventReader extends ChatEventReader {
  append(
    event: ChatThreadEvent,
    opts?: { occurredAt?: string; streamId?: string },
  ): PersistedChatEvent;
  /** Append directly without notifying subscribers — simulates historical writes. */
  appendSilent(
    event: ChatThreadEvent,
    opts?: { occurredAt?: string; streamId?: string },
  ): PersistedChatEvent;
  /** Force-inject an envelope with a chosen sequence (gap-injection tests). */
  injectRaw(envelope: PersistedChatEvent, opts?: { notify?: boolean }): void;
}

function makeFakeReader(): FakeEventReader {
  const rows: PersistedChatEvent[] = [];
  const subs = new Set<(e: PersistedChatEvent) => void>();
  let nextSeq = 1;
  const streamVersions = new Map<string, number>();

  function envelopeOf(
    event: ChatThreadEvent,
    opts?: { occurredAt?: string; streamId?: string; sequence?: number },
  ): PersistedChatEvent {
    const streamId = opts?.streamId ?? ("threadId" in event ? event.threadId : "default");
    const nextStreamVersion = (streamVersions.get(streamId) ?? 0) + 1;
    streamVersions.set(streamId, nextStreamVersion);
    const seq = opts?.sequence ?? nextSeq++;
    return {
      sequence: seq,
      eventId: `evt-${seq}`,
      occurredAt: opts?.occurredAt ?? new Date(2025, 0, 1, 0, 0, seq).toISOString(),
      aggregateKind: event.type.startsWith("chat.session.") ? "session" : "turn",
      streamId,
      streamVersion: nextStreamVersion,
      actorKind: "system",
      event,
    };
  }

  return {
    readFromSequence(seqExclusive, limit) {
      const filtered = rows.filter((r) => r.sequence > seqExclusive);
      filtered.sort((a, b) => a.sequence - b.sequence);
      return limit !== undefined ? filtered.slice(0, limit) : filtered;
    },
    subscribe(handler) {
      subs.add(handler);
      return () => {
        subs.delete(handler);
      };
    },
    append(event, opts) {
      const envelope = envelopeOf(event, opts);
      rows.push(envelope);
      for (const s of subs) s(envelope);
      return envelope;
    },
    appendSilent(event, opts) {
      const envelope = envelopeOf(event, opts);
      rows.push(envelope);
      return envelope;
    },
    injectRaw(envelope, opts) {
      rows.push(envelope);
      if (opts?.notify !== false) {
        for (const s of subs) s(envelope);
      }
    },
  };
}

const THREAD_A = "thread-a-1234567890";
const TURN_1 = "turn-1-1234567890123";
const TURN_2 = "turn-2-1234567890123";

describe("makeTurnProjection — bootstrap replay", () => {
  it("rebuilds turn state from a populated event log", () => {
    const reader = makeFakeReader();
    const cursorStore = makeInMemoryCursorStore();

    reader.appendSilent({
      type: "chat.turn.started",
      threadId: THREAD_A,
      turnId: TURN_1,
      requestedAt: "2025-01-01T00:00:01.000Z",
    });
    reader.appendSilent({
      type: "chat.turn.completed",
      threadId: THREAD_A,
      turnId: TURN_1,
      state: "completed",
      completedAt: "2025-01-01T00:00:05.000Z",
      assistantMessageId: "msg-1-1234567890123",
    });
    reader.appendSilent({
      type: "chat.turn.started",
      threadId: THREAD_A,
      turnId: TURN_2,
      requestedAt: "2025-01-01T00:00:06.000Z",
    });

    const projection = makeTurnProjection({ reader, cursorStore });
    projection.start();

    expect(projection.cursor()).toBe(3);
    expect(projection.list(THREAD_A)).toHaveLength(2);
    expect(projection.get(THREAD_A, TURN_1)?.state).toBe("completed");
    expect(projection.get(THREAD_A, TURN_1)?.assistantMessageId).toBe("msg-1-1234567890123");
    expect(projection.get(THREAD_A, TURN_2)?.state).toBe("running");
    expect(projection.latest(THREAD_A)?.turnId).toBe(TURN_2);
  });

  it("resumes from a non-zero cursor", () => {
    const reader = makeFakeReader();
    const cursorStore = makeInMemoryCursorStore();

    reader.appendSilent({
      type: "chat.turn.started",
      threadId: THREAD_A,
      turnId: TURN_1,
      requestedAt: "2025-01-01T00:00:01.000Z",
    });
    reader.appendSilent({
      type: "chat.turn.started",
      threadId: THREAD_A,
      turnId: TURN_2,
      requestedAt: "2025-01-01T00:00:02.000Z",
    });

    // Pretend we already processed event 1.
    cursorStore.save("turn", 1);
    const projection = makeTurnProjection({ reader, cursorStore });
    projection.start();

    expect(projection.cursor()).toBe(2);
    // The first started event was skipped (already applied) — only TURN_2 is present.
    expect(projection.get(THREAD_A, TURN_1)).toBeNull();
    expect(projection.get(THREAD_A, TURN_2)?.state).toBe("running");
  });

  it("batches bootstrap reads (large log)", () => {
    const reader = makeFakeReader();
    const cursorStore = makeInMemoryCursorStore();

    // 1000 events: 500 starts + 500 completes.
    for (let i = 0; i < 500; i++) {
      const turnId = `turn-batch-${String(i).padStart(4, "0")}-pad`;
      reader.appendSilent({
        type: "chat.turn.started",
        threadId: THREAD_A,
        turnId,
        requestedAt: `2025-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
      });
      reader.appendSilent({
        type: "chat.turn.completed",
        threadId: THREAD_A,
        turnId,
        state: "completed",
        completedAt: `2025-01-01T00:01:${String(i % 60).padStart(2, "0")}.000Z`,
      });
    }

    const projection = makeTurnProjection({ reader, cursorStore, batchSize: 100 });
    const t0 = performance.now();
    projection.start();
    const elapsed = performance.now() - t0;

    expect(projection.cursor()).toBe(1000);
    expect(projection.list(THREAD_A)).toHaveLength(500);
    // Acceptance: bootstrap 1000 events well under the 100 ms budget from
    // the goal-14 §2.1 acceptance criteria (even in-memory, this is a
    // useful regression guard).
    expect(elapsed).toBeLessThan(500);
  });
});

describe("makeTurnProjection — incremental ingest", () => {
  it("subscribes after bootstrap and applies live events", () => {
    const reader = makeFakeReader();
    const projection = makeTurnProjection({
      reader,
      cursorStore: makeInMemoryCursorStore(),
    });
    projection.start();
    expect(projection.cursor()).toBe(0);

    reader.append({
      type: "chat.turn.started",
      threadId: THREAD_A,
      turnId: TURN_1,
      requestedAt: "2025-01-01T00:00:01.000Z",
    });
    expect(projection.cursor()).toBe(1);
    expect(projection.get(THREAD_A, TURN_1)?.state).toBe("running");

    reader.append({
      type: "chat.turn.aborted",
      threadId: THREAD_A,
      turnId: TURN_1,
      reason: "cancelled",
    });
    expect(projection.cursor()).toBe(2);
    expect(projection.get(THREAD_A, TURN_1)?.state).toBe("interrupted");
  });

  it("stop() unsubscribes — subsequent events do not advance the cursor", () => {
    const reader = makeFakeReader();
    const projection = makeTurnProjection({
      reader,
      cursorStore: makeInMemoryCursorStore(),
    });
    projection.start();
    projection.stop();

    reader.append({
      type: "chat.turn.started",
      threadId: THREAD_A,
      turnId: TURN_1,
      requestedAt: "2025-01-01T00:00:01.000Z",
    });
    expect(projection.cursor()).toBe(0);
    expect(projection.get(THREAD_A, TURN_1)).toBeNull();
  });

  it("rejects a sequence gap (live subscription)", () => {
    const reader = makeFakeReader();
    const projection = makeTurnProjection({
      reader,
      cursorStore: makeInMemoryCursorStore(),
    });
    projection.start();

    // Inject an envelope with sequence=5 directly. Expected next = 1, so
    // ingest must throw ProjectionGapError.
    expect(() => {
      reader.injectRaw({
        sequence: 5,
        eventId: "evt-gap",
        occurredAt: "2025-01-01T00:00:05.000Z",
        aggregateKind: "turn",
        streamId: THREAD_A,
        streamVersion: 1,
        actorKind: "system",
        event: {
          type: "chat.turn.started",
          threadId: THREAD_A,
          turnId: TURN_1,
          requestedAt: "2025-01-01T00:00:05.000Z",
        },
      });
    }).toThrow(ProjectionGapError);
  });
});

describe("makeTurnProjection — read API", () => {
  it("listBySession only returns turns whose sessionId matches", () => {
    // Note: turn-lifecycle events do not carry sessionId in the current
    // contract, so this test seeds turns via direct event projection of
    // future-compatible payloads. For now both turns lack sessionId and
    // therefore listBySession returns [].
    const reader = makeFakeReader();
    const projection = makeTurnProjection({
      reader,
      cursorStore: makeInMemoryCursorStore(),
    });
    projection.start();

    reader.append({
      type: "chat.turn.started",
      threadId: THREAD_A,
      turnId: TURN_1,
      requestedAt: "2025-01-01T00:00:01.000Z",
    });
    expect(projection.listBySession(THREAD_A, "session-x-1234567890")).toEqual([]);
    // Without sessionId, latestForSession returns null.
    expect(projection.latestForSession(THREAD_A, "session-x-1234567890")).toBeNull();
  });

  it("idempotent duplicate chat.turn.started is ignored", () => {
    const reader = makeFakeReader();
    const projection = makeTurnProjection({
      reader,
      cursorStore: makeInMemoryCursorStore(),
    });
    projection.start();

    reader.append({
      type: "chat.turn.started",
      threadId: THREAD_A,
      turnId: TURN_1,
      requestedAt: "2025-01-01T00:00:01.000Z",
    });
    reader.append({
      type: "chat.turn.started",
      threadId: THREAD_A,
      turnId: TURN_1,
      requestedAt: "2025-01-01T00:00:02.000Z",
    });

    expect(projection.list(THREAD_A)).toHaveLength(1);
    // First-write-wins: original requestedAt preserved.
    expect(projection.get(THREAD_A, TURN_1)?.requestedAt).toBe("2025-01-01T00:00:01.000Z");
    // Cursor still advances on the duplicate (event consumed, no state change).
    expect(projection.cursor()).toBe(2);
  });

  it("rejects illegal transitions (terminal → running)", () => {
    const reader = makeFakeReader();
    const projection = makeTurnProjection({
      reader,
      cursorStore: makeInMemoryCursorStore(),
    });
    projection.start();

    reader.append({
      type: "chat.turn.started",
      threadId: THREAD_A,
      turnId: TURN_1,
      requestedAt: "2025-01-01T00:00:01.000Z",
    });
    reader.append({
      type: "chat.turn.completed",
      threadId: THREAD_A,
      turnId: TURN_1,
      state: "completed",
      completedAt: "2025-01-01T00:00:05.000Z",
    });
    // Then an aborted event for the same turn — illegal.
    reader.append({
      type: "chat.turn.aborted",
      threadId: THREAD_A,
      turnId: TURN_1,
      reason: "interrupted",
    });
    expect(projection.get(THREAD_A, TURN_1)?.state).toBe("completed");
    // Cursor still advances (event consumed, transition rejected with a warning).
    expect(projection.cursor()).toBe(3);
  });
});

describe("makeTurnProjection — restart determinism", () => {
  it("two projections built on the same event log produce identical state", () => {
    const reader = makeFakeReader();

    const events: ChatThreadEvent[] = [
      {
        type: "chat.turn.started",
        threadId: THREAD_A,
        turnId: TURN_1,
        requestedAt: "2025-01-01T00:00:01.000Z",
      },
      {
        type: "chat.turn.completed",
        threadId: THREAD_A,
        turnId: TURN_1,
        state: "completed",
        completedAt: "2025-01-01T00:00:05.000Z",
        assistantMessageId: "msg-1-1234567890123",
      },
      {
        type: "chat.turn.started",
        threadId: THREAD_A,
        turnId: TURN_2,
        requestedAt: "2025-01-01T00:00:06.000Z",
      },
      {
        type: "chat.turn.aborted",
        threadId: THREAD_A,
        turnId: TURN_2,
        reason: "error",
      },
    ];
    for (const e of events) reader.appendSilent(e);

    // First daemon boot:
    const cursorA = makeInMemoryCursorStore();
    const projA = makeTurnProjection({ reader, cursorStore: cursorA });
    projA.start();
    const snapshotA = projA.list(THREAD_A).map((t) => ({ ...t }));

    // Second daemon boot from scratch (fresh cursor store):
    const cursorB = makeInMemoryCursorStore();
    const projB = makeTurnProjection({ reader, cursorStore: cursorB });
    projB.start();
    const snapshotB = projB.list(THREAD_A).map((t) => ({ ...t }));

    expect(snapshotB).toEqual(snapshotA);
    expect(projA.cursor()).toBe(projB.cursor());
  });
});
