/**
 * G14-T101 — turn-diff projection unit tests.
 *
 * Mirrors turn-projection.test.ts: an in-memory FakeEventReader drives
 * the projection so the logic is exercised without sqlite. T090's
 * ChatEventStore satisfies the same ChatEventReader interface, so the
 * companion turn-diff-projection.sqlite.test.ts proves the production
 * wiring end-to-end.
 */

import { describe, expect, it } from "bun:test";

import type { ChatThreadEvent, CheckpointFile } from "@tmux-ide/contracts";
import {
  makeInMemoryCursorStore,
  ProjectionGapError,
  type ChatEventReader,
  type PersistedChatEvent,
} from "../../types.ts";
import {
  makeTurnDiffProjection,
  normaliseDiffStatus,
  type TurnDiffEntry,
} from "../turn-diff-projection.ts";

// ---------------------------------------------------------------------------
// FakeEventReader — identical to turn-projection.test.ts but kept local so
// the two suites stay independently editable.
// ---------------------------------------------------------------------------

interface FakeEventReader extends ChatEventReader {
  append(
    event: ChatThreadEvent,
    opts?: { occurredAt?: string; streamId?: string },
  ): PersistedChatEvent;
  appendSilent(
    event: ChatThreadEvent,
    opts?: { occurredAt?: string; streamId?: string },
  ): PersistedChatEvent;
  injectRaw(envelope: PersistedChatEvent, opts?: { notify?: boolean }): void;
}

function makeFakeReader(): FakeEventReader {
  const rows: PersistedChatEvent[] = [];
  const subs = new Set<(e: PersistedChatEvent) => void>();
  let nextSeq = 1;

  function envelopeOf(
    event: ChatThreadEvent,
    opts?: { occurredAt?: string; streamId?: string; sequence?: number },
  ): PersistedChatEvent {
    const streamId = opts?.streamId ?? ("threadId" in event ? event.threadId : "default");
    const seq = opts?.sequence ?? nextSeq++;
    return {
      sequence: seq,
      eventId: `evt-${seq}`,
      occurredAt: opts?.occurredAt ?? new Date(2026, 0, 1, 0, 0, seq).toISOString(),
      aggregateKind: event.type === "chat.checkpoint.created" ? "checkpoint" : "thread",
      streamId,
      streamVersion: seq,
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

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

function file(path: string, kind: string, additions: number, deletions: number): CheckpointFile {
  return { path, kind, additions, deletions };
}

function checkpointCreated(
  threadId: string,
  turnId: string,
  files: ReadonlyArray<CheckpointFile>,
  occurredAt = "2026-05-12T10:00:00.000Z",
): ChatThreadEvent {
  return {
    type: "chat.checkpoint.created",
    threadId,
    checkpoint: {
      turnId,
      checkpointTurnCount: 1,
      checkpointRef: `ckpt/${turnId}`,
      status: "ready",
      files: files.slice(),
      assistantMessageId: null,
      completedAt: occurredAt,
    },
  } satisfies ChatThreadEvent;
}

function turnStarted(threadId: string, turnId: string): ChatThreadEvent {
  return {
    type: "chat.turn.started",
    threadId,
    turnId,
    requestedAt: "2026-05-12T10:00:00.000Z",
  } satisfies ChatThreadEvent;
}

// ---------------------------------------------------------------------------

describe("turn-diff-projection (in-memory)", () => {
  it("projects chat.checkpoint.created into per-turn entries in producer order", () => {
    const reader = makeFakeReader();
    const cursorStore = makeInMemoryCursorStore();
    const projection = makeTurnDiffProjection({ reader, cursorStore });
    projection.start();

    reader.append(turnStarted("T1", "turn-1"));
    reader.append(
      checkpointCreated("T1", "turn-1", [
        file("src/a.ts", "modified", 5, 2),
        file("src/b.ts", "added", 12, 0),
        file("src/c.ts", "deleted", 0, 8),
      ]),
    );

    const entries = projection.listForTurn("turn-1");
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(entries.map((e) => e.fileIndex)).toEqual([0, 1, 2]);
    expect(entries.map((e) => e.status)).toEqual(["modified", "added", "deleted"]);
    expect(entries[0]!.additions).toBe(5);
    expect(entries[0]!.deletions).toBe(2);

    projection.stop();
  });

  it("listForThread groups every turn's entries under the right threadId", () => {
    const reader = makeFakeReader();
    const cursorStore = makeInMemoryCursorStore();
    const projection = makeTurnDiffProjection({ reader, cursorStore });
    projection.start();

    reader.append(checkpointCreated("T1", "turn-1", [file("a.ts", "modified", 1, 0)]));
    reader.append(checkpointCreated("T1", "turn-2", [file("b.ts", "added", 4, 0)]));
    reader.append(checkpointCreated("T2", "turn-x", [file("c.ts", "modified", 2, 3)]));

    const t1 = projection.listForThread("T1");
    expect(Object.keys(t1).sort()).toEqual(["turn-1", "turn-2"]);
    expect(t1["turn-1"]!.map((e) => e.path)).toEqual(["a.ts"]);
    expect(t1["turn-2"]!.map((e) => e.path)).toEqual(["b.ts"]);

    const t2 = projection.listForThread("T2");
    expect(Object.keys(t2)).toEqual(["turn-x"]);

    // listForThread returns a fresh array — mutating it must not corrupt
    // the projection's state.
    t1["turn-1"]!.push({} as TurnDiffEntry);
    expect(projection.listForTurn("turn-1")).toHaveLength(1);

    projection.stop();
  });

  it("aggregateForThread sums additions, deletions, and file count across turns", () => {
    const reader = makeFakeReader();
    const cursorStore = makeInMemoryCursorStore();
    const projection = makeTurnDiffProjection({ reader, cursorStore });
    projection.start();

    reader.append(
      checkpointCreated("T1", "turn-1", [
        file("a.ts", "modified", 5, 2),
        file("b.ts", "added", 12, 0),
      ]),
    );
    reader.append(
      checkpointCreated("T1", "turn-2", [
        file("c.ts", "deleted", 0, 8),
        file("d.ts", "renamed", 1, 1),
      ]),
    );
    // A different thread must not contribute to T1's aggregate.
    reader.append(checkpointCreated("T2", "turn-x", [file("z.ts", "modified", 99, 99)]));

    const agg = projection.aggregateForThread("T1");
    expect(agg.filesChanged).toBe(4);
    expect(agg.totalAdditions).toBe(5 + 12 + 0 + 1); // 18
    expect(agg.totalDeletions).toBe(2 + 0 + 8 + 1); // 11

    const empty = projection.aggregateForThread("does-not-exist");
    expect(empty).toEqual({ totalAdditions: 0, totalDeletions: 0, filesChanged: 0 });

    projection.stop();
  });

  it("ignores non-checkpoint events but still advances cursor (no gap)", () => {
    const reader = makeFakeReader();
    const cursorStore = makeInMemoryCursorStore();
    const projection = makeTurnDiffProjection({ reader, cursorStore });
    projection.start();

    reader.append(turnStarted("T1", "turn-1")); // seq 1 — ignored, cursor advances
    reader.append(checkpointCreated("T1", "turn-1", [file("a.ts", "modified", 3, 1)])); // seq 2

    expect(projection.cursor()).toBe(2);
    expect(projection.listForTurn("turn-1")).toHaveLength(1);

    projection.stop();
  });

  it("rejects gap-injected events with ProjectionGapError", () => {
    const reader = makeFakeReader();
    const cursorStore = makeInMemoryCursorStore();
    const projection = makeTurnDiffProjection({ reader, cursorStore });
    projection.start();

    reader.append(checkpointCreated("T1", "turn-1", [file("a.ts", "modified", 1, 0)]));
    expect(projection.cursor()).toBe(1);

    // Inject an event with sequence 5 — that's a gap (expected: 2).
    expect(() => {
      reader.injectRaw(
        {
          sequence: 5,
          eventId: "evt-5",
          occurredAt: "2026-05-12T10:01:00.000Z",
          aggregateKind: "checkpoint",
          streamId: "T1",
          streamVersion: 5,
          actorKind: "system",
          event: checkpointCreated("T1", "turn-2", [file("b.ts", "added", 4, 0)]),
        },
        { notify: true },
      );
    }).toThrow(ProjectionGapError);

    projection.stop();
  });

  it("first-write-wins on duplicate chat.checkpoint.created for the same turn", () => {
    const reader = makeFakeReader();
    const cursorStore = makeInMemoryCursorStore();
    const projection = makeTurnDiffProjection({ reader, cursorStore });
    projection.start();

    reader.append(checkpointCreated("T1", "turn-1", [file("a.ts", "modified", 5, 2)]));
    // Duplicate event — must NOT clobber the first emission.
    reader.append(checkpointCreated("T1", "turn-1", [file("z.ts", "deleted", 0, 99)]));

    const entries = projection.listForTurn("turn-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe("a.ts");
    expect(entries[0]!.additions).toBe(5);

    projection.stop();
  });

  it("status normalisation handles git porcelain shorthand + verbose forms", () => {
    expect(normaliseDiffStatus("added")).toBe("added");
    expect(normaliseDiffStatus("A")).toBe("added");
    expect(normaliseDiffStatus("create")).toBe("added");
    expect(normaliseDiffStatus("modified")).toBe("modified");
    expect(normaliseDiffStatus("M")).toBe("modified");
    expect(normaliseDiffStatus("deleted")).toBe("deleted");
    expect(normaliseDiffStatus("D")).toBe("deleted");
    expect(normaliseDiffStatus("remove")).toBe("deleted");
    expect(normaliseDiffStatus("renamed")).toBe("renamed");
    expect(normaliseDiffStatus("R")).toBe("renamed");
    expect(normaliseDiffStatus("moved")).toBe("renamed");
    // Unknowns fall through to "modified".
    expect(normaliseDiffStatus("conflicted")).toBe("modified");
    expect(normaliseDiffStatus("")).toBe("modified");
  });

  it("listForTurn returns [] for an unknown turn (not undefined)", () => {
    const reader = makeFakeReader();
    const cursorStore = makeInMemoryCursorStore();
    const projection = makeTurnDiffProjection({ reader, cursorStore });
    projection.start();

    expect(projection.listForTurn("never-existed")).toEqual([]);
    expect(projection.listForThread("never-existed")).toEqual({});

    projection.stop();
  });

  it("bootstrap from a populated reader rebuilds without subscribing late events", () => {
    const reader = makeFakeReader();
    const cursorStore = makeInMemoryCursorStore();
    // Append BEFORE start() — these flow through bootstrap, not subscribe.
    reader.append(checkpointCreated("T1", "turn-1", [file("a.ts", "modified", 5, 2)]));
    reader.append(checkpointCreated("T1", "turn-2", [file("b.ts", "added", 4, 0)]));

    const projection = makeTurnDiffProjection({ reader, cursorStore });
    projection.start();

    expect(projection.cursor()).toBe(2);
    expect(projection.aggregateForThread("T1")).toEqual({
      filesChanged: 2,
      totalAdditions: 9,
      totalDeletions: 2,
    });

    projection.stop();
  });
});
