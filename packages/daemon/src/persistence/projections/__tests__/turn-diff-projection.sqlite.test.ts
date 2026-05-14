/**
 * T101 ↔ T090 integration: drive the sqlite ChatEventStore through the
 * turn-diff projection. Proves the contract surface lines up across
 * modules and that daemon-restart determinism holds — the same persisted
 * event log produces the same diff state on a fresh projection.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChatThreadEvent, CheckpointFile } from "@tmux-ide/contracts";
import { openDatabase, type SqliteDb } from "../../../lib/sqlite-adapter.ts";
import { makeChatEventStore, type ChatEventStore } from "../../chat-event-store.ts";
import { makeInMemoryCursorStore } from "../../types.ts";
import { makeTurnDiffProjection } from "../turn-diff-projection.ts";

function file(path: string, kind: string, additions: number, deletions: number): CheckpointFile {
  return { path, kind, additions, deletions };
}

function checkpointCreated(
  threadId: string,
  turnId: string,
  files: ReadonlyArray<CheckpointFile>,
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
      completedAt: "2026-05-12T10:00:00.000Z",
    },
  };
}

describe("turn-diff-projection × chat-event-store (sqlite)", () => {
  let dir: string;
  let dbPath: string;
  let db: SqliteDb;
  let store: ChatEventStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tmux-ide-turn-diff-sqlite-"));
    dbPath = join(dir, "daemon.sqlite");
    db = openDatabase(dbPath);
    store = makeChatEventStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("bootstrap replay rebuilds diff state from a populated store", () => {
    store.append({
      event: checkpointCreated("T1", "turn-1", [
        file("src/a.ts", "modified", 5, 2),
        file("src/b.ts", "added", 12, 0),
      ]),
      actorKind: "system",
    });
    store.append({
      event: checkpointCreated("T1", "turn-2", [file("src/c.ts", "deleted", 0, 8)]),
      actorKind: "system",
    });
    store.append({
      event: checkpointCreated("T2", "turn-x", [file("z.ts", "modified", 3, 3)]),
      actorKind: "system",
    });

    const projection = makeTurnDiffProjection({
      reader: store,
      cursorStore: makeInMemoryCursorStore(),
    });
    projection.start();

    expect(projection.cursor()).toBe(3);
    expect(projection.listForTurn("turn-1")).toHaveLength(2);
    expect(projection.listForTurn("turn-2")).toHaveLength(1);

    const t1Agg = projection.aggregateForThread("T1");
    expect(t1Agg).toEqual({
      filesChanged: 3,
      totalAdditions: 5 + 12 + 0,
      totalDeletions: 2 + 0 + 8,
    });

    projection.stop();
  });

  it("incremental ingest: checkpoints appended after start() flow into the projection", () => {
    const projection = makeTurnDiffProjection({
      reader: store,
      cursorStore: makeInMemoryCursorStore(),
    });
    projection.start();

    expect(projection.cursor()).toBe(0);

    store.append({
      event: checkpointCreated("T1", "turn-1", [file("a.ts", "added", 7, 0)]),
      actorKind: "system",
    });
    expect(projection.cursor()).toBe(1);
    expect(projection.listForTurn("turn-1")[0]!.additions).toBe(7);

    store.append({
      event: checkpointCreated("T1", "turn-2", [file("b.ts", "modified", 3, 2)]),
      actorKind: "system",
    });
    expect(projection.cursor()).toBe(2);
    expect(projection.aggregateForThread("T1")).toEqual({
      filesChanged: 2,
      totalAdditions: 10,
      totalDeletions: 2,
    });

    projection.stop();
  });

  it("daemon-restart determinism: two fresh boots over the same log produce identical aggregates", () => {
    store.append({
      event: checkpointCreated("T1", "turn-1", [
        file("a.ts", "modified", 5, 2),
        file("b.ts", "added", 12, 0),
      ]),
      actorKind: "system",
    });
    store.append({
      event: checkpointCreated("T1", "turn-2", [file("c.ts", "deleted", 0, 8)]),
      actorKind: "system",
    });

    const boot1 = makeTurnDiffProjection({
      reader: store,
      cursorStore: makeInMemoryCursorStore(),
    });
    boot1.start();
    const aggregate1 = boot1.aggregateForThread("T1");
    const snapshot1 = boot1.listForThread("T1");
    boot1.stop();

    db.close();
    db = openDatabase(dbPath);
    store = makeChatEventStore(db);

    const boot2 = makeTurnDiffProjection({
      reader: store,
      cursorStore: makeInMemoryCursorStore(),
    });
    boot2.start();
    const aggregate2 = boot2.aggregateForThread("T1");
    const snapshot2 = boot2.listForThread("T1");
    boot2.stop();

    expect(aggregate2).toEqual(aggregate1);
    expect(Object.keys(snapshot2).sort()).toEqual(Object.keys(snapshot1).sort());
    for (const turnId of Object.keys(snapshot1)) {
      expect(snapshot2[turnId]).toEqual(snapshot1[turnId]);
    }
    // Sanity on the actual numbers.
    expect(aggregate2).toEqual({
      filesChanged: 3,
      totalAdditions: 17,
      totalDeletions: 10,
    });
  });
});
