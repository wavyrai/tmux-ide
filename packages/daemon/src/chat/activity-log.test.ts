import { describe, expect, it } from "vitest";
import { makeActivityLog } from "./activity-log.ts";

const T = "thr_01";

function fixedClock(stamps: string[]): () => Date {
  let i = 0;
  return () => new Date(stamps[Math.min(i++, stamps.length - 1)]!);
}

describe("activity-log", () => {
  it("assigns a monotonic per-thread sequence", () => {
    const log = makeActivityLog();
    const a = log.append({ threadId: T, tone: "info", kind: "start", summary: "s1" });
    const b = log.append({ threadId: T, tone: "info", kind: "step", summary: "s2" });
    const c = log.append({ threadId: T, tone: "tool", kind: "exec", summary: "s3" });
    expect([a.sequence, b.sequence, c.sequence]).toEqual([0, 1, 2]);
  });

  it("keeps per-thread sequences independent", () => {
    const log = makeActivityLog();
    log.append({ threadId: T, tone: "info", kind: "k", summary: "a" });
    log.append({ threadId: T, tone: "info", kind: "k", summary: "b" });
    const other = log.append({ threadId: "other", tone: "info", kind: "k", summary: "x" });
    expect(other.sequence).toBe(0);
  });

  it("partitions by turnId via listByTurn", () => {
    const log = makeActivityLog();
    log.append({ threadId: T, tone: "info", kind: "k", summary: "a", turnId: "t1" });
    log.append({ threadId: T, tone: "info", kind: "k", summary: "b", turnId: "t2" });
    log.append({ threadId: T, tone: "info", kind: "k", summary: "c", turnId: "t1" });
    const t1 = log.listByTurn(T, "t1");
    expect(t1.map((a) => a.summary)).toEqual(["a", "c"]);
  });

  it("filters by sinceSeq for incremental polling", () => {
    const log = makeActivityLog();
    log.append({ threadId: T, tone: "info", kind: "k", summary: "a" });
    log.append({ threadId: T, tone: "info", kind: "k", summary: "b" });
    log.append({ threadId: T, tone: "info", kind: "k", summary: "c" });
    const tail = log.list({ threadId: T, sinceSeq: 0 });
    expect(tail.map((a) => a.summary)).toEqual(["b", "c"]);
  });

  it("treats payload as opaque and preserves it through append", () => {
    const log = makeActivityLog();
    const payload = { paneId: "%1", bytes: 42 };
    const a = log.append({
      threadId: T,
      tone: "tool",
      kind: "tmux.send_to_pane",
      summary: "sent",
      payload,
    });
    expect(a.payload).toEqual(payload);
  });

  it("uses injected clock + id for deterministic fixtures", () => {
    const log = makeActivityLog({
      now: fixedClock(["2026-05-11T10:00:00.000Z", "2026-05-11T10:00:01.000Z"]),
      randomId: () => "evt_fixed",
    });
    const a = log.append({ threadId: T, tone: "info", kind: "k", summary: "a" });
    expect(a.id).toBe("evt_fixed");
    expect(a.createdAt).toBe("2026-05-11T10:00:00.000Z");
  });

  it("clear(threadId) drops events and resets the sequence", () => {
    const log = makeActivityLog();
    log.append({ threadId: T, tone: "info", kind: "k", summary: "a" });
    log.append({ threadId: T, tone: "info", kind: "k", summary: "b" });
    log.clear(T);
    expect(log.list({ threadId: T })).toEqual([]);
    const fresh = log.append({ threadId: T, tone: "info", kind: "k", summary: "c" });
    expect(fresh.sequence).toBe(0);
  });

  it("latest() returns the most recent activity or null", () => {
    const log = makeActivityLog();
    expect(log.latest(T)).toBeNull();
    log.append({ threadId: T, tone: "info", kind: "k", summary: "a" });
    const b = log.append({ threadId: T, tone: "info", kind: "k", summary: "b" });
    expect(log.latest(T)).toEqual(b);
  });

  it("defaults turnId to null when not provided", () => {
    const log = makeActivityLog();
    const a = log.append({ threadId: T, tone: "info", kind: "k", summary: "ambient" });
    expect(a.turnId).toBeNull();
  });
});
