import { describe, expect, it } from "vitest";
import type { CheckpointSummary } from "@tmux-ide/contracts";
import { CheckpointStoreError, makeCheckpointStore } from "./checkpoint-store.ts";

const T = "thr_01";

function summary(overrides: Partial<CheckpointSummary> = {}): CheckpointSummary {
  return {
    turnId: "turn_01",
    checkpointTurnCount: 1,
    checkpointRef: "deadbeef",
    status: "ready",
    files: [],
    assistantMessageId: null,
    completedAt: "2026-05-11T10:00:00.000Z",
    ...overrides,
  };
}

describe("checkpoint-store", () => {
  it("upsert + get round-trips a CheckpointSummary", () => {
    const store = makeCheckpointStore();
    const s = summary({ turnId: "turn_01" });
    store.upsert(T, s);
    expect(store.get(T, "turn_01")).toEqual(s);
  });

  it("upsert overwrites the prior summary for the same turn", () => {
    const store = makeCheckpointStore();
    store.upsert(T, summary({ turnId: "turn_01", checkpointRef: "old" }));
    store.upsert(T, summary({ turnId: "turn_01", checkpointRef: "new" }));
    expect(store.get(T, "turn_01")?.checkpointRef).toBe("new");
  });

  it("list sorts by checkpointTurnCount", () => {
    const store = makeCheckpointStore();
    store.upsert(T, summary({ turnId: "t3", checkpointTurnCount: 3 }));
    store.upsert(T, summary({ turnId: "t1", checkpointTurnCount: 1 }));
    store.upsert(T, summary({ turnId: "t2", checkpointTurnCount: 2 }));
    expect(store.list(T).map((s) => s.turnId)).toEqual(["t1", "t2", "t3"]);
  });

  it("remove returns true on success and false on miss", () => {
    const store = makeCheckpointStore();
    store.upsert(T, summary({ turnId: "turn_01" }));
    expect(store.remove(T, "turn_01")).toBe(true);
    expect(store.remove(T, "turn_01")).toBe(false);
  });

  it("updateStatus mutates only the status field", () => {
    const store = makeCheckpointStore();
    store.upsert(T, summary({ turnId: "turn_01", status: "ready", checkpointRef: "abc" }));
    const next = store.updateStatus(T, "turn_01", "missing");
    expect(next.status).toBe("missing");
    expect(next.checkpointRef).toBe("abc");
  });

  it("updateStatus throws not_found when the checkpoint is missing", () => {
    const store = makeCheckpointStore();
    expect(() => store.updateStatus(T, "no-such", "error")).toThrow(CheckpointStoreError);
  });

  it("isolation between threads", () => {
    const store = makeCheckpointStore();
    store.upsert(T, summary({ turnId: "turn_01" }));
    store.upsert("other", summary({ turnId: "turn_01", checkpointRef: "other-ref" }));
    expect(store.get(T, "turn_01")?.checkpointRef).toBe("deadbeef");
    expect(store.get("other", "turn_01")?.checkpointRef).toBe("other-ref");
  });

  it("clear(threadId) drops all checkpoints for that thread", () => {
    const store = makeCheckpointStore();
    store.upsert(T, summary({ turnId: "t1" }));
    store.upsert(T, summary({ turnId: "t2" }));
    store.clear(T);
    expect(store.list(T)).toEqual([]);
  });

  it("get returns null for unknown threadId/turnId", () => {
    const store = makeCheckpointStore();
    expect(store.get("nope", "nope")).toBeNull();
    store.upsert(T, summary({ turnId: "turn_01" }));
    expect(store.get(T, "no-such")).toBeNull();
  });
});
