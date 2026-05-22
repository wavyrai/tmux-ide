import { describe, expect, it } from "vitest";
import { makeTurnStore, TurnStoreError } from "./turn-store.ts";

const T = "thr_01";

describe("turn-store", () => {
  it("starts a turn in 'running' state and pins LatestTurn", () => {
    const store = makeTurnStore();
    const record = store.start({
      threadId: T,
      turnId: "turn_01",
      requestedAt: "2026-05-11T10:00:00.000Z",
    });
    expect(record.state).toBe("running");
    expect(record.completedAt).toBeNull();
    expect(store.latest(T)?.turnId).toBe("turn_01");
  });

  it("rejects starting a duplicate turn", () => {
    const store = makeTurnStore();
    store.start({ threadId: T, turnId: "turn_01", requestedAt: "2026-05-11T10:00:00.000Z" });
    expect(() =>
      store.start({ threadId: T, turnId: "turn_01", requestedAt: "2026-05-11T10:00:00.000Z" }),
    ).toThrow(TurnStoreError);
  });

  it("transitions running → completed and records completedAt", () => {
    const store = makeTurnStore();
    store.start({ threadId: T, turnId: "turn_01", requestedAt: "2026-05-11T10:00:00.000Z" });
    const completed = store.transition({
      threadId: T,
      turnId: "turn_01",
      state: "completed",
      completedAt: "2026-05-11T10:01:00.000Z",
    });
    expect(completed.state).toBe("completed");
    expect(completed.completedAt).toBe("2026-05-11T10:01:00.000Z");
  });

  it("auto-fills completedAt when omitted on terminal transition", () => {
    const store = makeTurnStore();
    store.start({ threadId: T, turnId: "turn_01", requestedAt: "2026-05-11T10:00:00.000Z" });
    const interrupted = store.transition({
      threadId: T,
      turnId: "turn_01",
      state: "interrupted",
    });
    expect(interrupted.completedAt).not.toBeNull();
  });

  it("refuses to transition from a terminal state back to running", () => {
    const store = makeTurnStore();
    store.start({ threadId: T, turnId: "turn_01", requestedAt: "2026-05-11T10:00:00.000Z" });
    store.transition({ threadId: T, turnId: "turn_01", state: "completed" });
    expect(() =>
      store.transition({ threadId: T, turnId: "turn_01", state: "running" }),
    ).toThrowError(/Illegal turn transition/);
  });

  it("allows idempotent same-state transitions (no-op semantics)", () => {
    const store = makeTurnStore();
    store.start({ threadId: T, turnId: "turn_01", requestedAt: "2026-05-11T10:00:00.000Z" });
    expect(() =>
      store.transition({ threadId: T, turnId: "turn_01", state: "running" }),
    ).not.toThrow();
  });

  it("throws not_found when transitioning a missing turn", () => {
    const store = makeTurnStore();
    expect(() => store.transition({ threadId: T, turnId: "no-such", state: "completed" })).toThrow(
      TurnStoreError,
    );
  });

  it("pins assistantMessageId on transition without erasing prior values", () => {
    const store = makeTurnStore();
    store.start({
      threadId: T,
      turnId: "turn_01",
      requestedAt: "2026-05-11T10:00:00.000Z",
      assistantMessageId: "msg_initial",
    });
    const next = store.transition({
      threadId: T,
      turnId: "turn_01",
      state: "completed",
      assistantMessageId: "msg_final",
    });
    expect(next.assistantMessageId).toBe("msg_final");
  });

  it("lists turns for a thread without leaking across threads", () => {
    const store = makeTurnStore();
    store.start({ threadId: T, turnId: "t1", requestedAt: "2026-05-11T10:00:00.000Z" });
    store.start({ threadId: T, turnId: "t2", requestedAt: "2026-05-11T10:01:00.000Z" });
    store.start({ threadId: "other", turnId: "x1", requestedAt: "2026-05-11T10:00:00.000Z" });
    expect(store.list(T).map((r) => r.turnId)).toEqual(["t1", "t2"]);
    expect(store.list("other").map((r) => r.turnId)).toEqual(["x1"]);
  });

  it("clear(threadId) drops all turns and the latest pointer", () => {
    const store = makeTurnStore();
    store.start({ threadId: T, turnId: "t1", requestedAt: "2026-05-11T10:00:00.000Z" });
    store.clear(T);
    expect(store.list(T)).toEqual([]);
    expect(store.latest(T)).toBeNull();
  });

  it("latest() returns null without any turns", () => {
    const store = makeTurnStore();
    expect(store.latest(T)).toBeNull();
  });

  it("latest() omits threadId from the LatestTurn shape", () => {
    const store = makeTurnStore();
    store.start({ threadId: T, turnId: "t1", requestedAt: "2026-05-11T10:00:00.000Z" });
    const latest = store.latest(T);
    expect(latest).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(latest as object, "threadId")).toBe(false);
  });
});
