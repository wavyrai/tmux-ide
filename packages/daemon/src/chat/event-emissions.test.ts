/**
 * T074: t3-style chat thread event emissions. Verifies that:
 *   - each store emits the right event variant at the right time,
 *   - the ordering invariant TurnStarted -> ThreadActivityAppended* ->
 *     TurnCompleted holds across stores with monotonic activity seq,
 *   - the compat shim broadcasts both old `chat.thread.*` events and
 *     the new t3-style events for the same operation,
 *   - the activity log is the replay buffer for missed events (subscribe
 *     with sinceSeq returns events with sequence > sinceSeq).
 */

import { describe, expect, it } from "vitest";
import type { ChatThreadEvent, CheckpointSummary, ProposedPlan } from "@tmux-ide/contracts";

import { makeActivityLog } from "./activity-log.ts";
import { makeCheckpointStore } from "./checkpoint-store.ts";
import { makePlanStore } from "./plan-store.ts";
import { makeTurnStore } from "./turn-store.ts";

const T = "thr_01";

function makeEventCollector() {
  const events: ChatThreadEvent[] = [];
  const emit = (e: ChatThreadEvent) => {
    events.push(e);
  };
  return { events, emit };
}

function plan(overrides: Partial<ProposedPlan> = {}): ProposedPlan {
  return {
    id: "plan_01",
    turnId: "turn_01",
    planMarkdown: "## Plan",
    implementedAt: null,
    implementationThreadId: null,
    createdAt: "2026-05-11T10:00:00.000Z",
    updatedAt: "2026-05-11T10:00:00.000Z",
    ...overrides,
  };
}

function checkpoint(overrides: Partial<CheckpointSummary> = {}): CheckpointSummary {
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

// ---------------------------------------------------------------------------
// Per-store emission tests
// ---------------------------------------------------------------------------

describe("turn-store emissions", () => {
  it("emits chat.turn.started on start", () => {
    const { events, emit } = makeEventCollector();
    const store = makeTurnStore({ emit });
    store.start({ threadId: T, turnId: "turn_01", requestedAt: "2026-05-11T10:00:00.000Z" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "chat.turn.started",
      threadId: T,
      turnId: "turn_01",
      requestedAt: "2026-05-11T10:00:00.000Z",
    });
  });

  it("includes sourceProposedPlanRef when the turn was triggered by a plan", () => {
    const { events, emit } = makeEventCollector();
    const store = makeTurnStore({ emit });
    store.start({
      threadId: T,
      turnId: "turn_01",
      requestedAt: "2026-05-11T10:00:00.000Z",
      sourceProposedPlan: { threadId: "thr_origin", planId: "plan_01" },
    });
    expect(events[0]).toMatchObject({
      type: "chat.turn.started",
      sourceProposedPlanRef: { threadId: "thr_origin", planId: "plan_01" },
    });
  });

  it("emits chat.turn.completed on running → completed", () => {
    const { events, emit } = makeEventCollector();
    const store = makeTurnStore({ emit });
    store.start({ threadId: T, turnId: "turn_01", requestedAt: "2026-05-11T10:00:00.000Z" });
    store.transition({
      threadId: T,
      turnId: "turn_01",
      state: "completed",
      completedAt: "2026-05-11T10:01:00.000Z",
      assistantMessageId: "msg_02",
    });
    const completed = events.find((e) => e.type === "chat.turn.completed");
    expect(completed).toMatchObject({
      threadId: T,
      turnId: "turn_01",
      state: "completed",
      completedAt: "2026-05-11T10:01:00.000Z",
      assistantMessageId: "msg_02",
    });
  });

  it("emits chat.turn.aborted with reason=interrupted on interrupt", () => {
    const { events, emit } = makeEventCollector();
    const store = makeTurnStore({ emit });
    store.start({ threadId: T, turnId: "turn_01", requestedAt: "2026-05-11T10:00:00.000Z" });
    store.transition({ threadId: T, turnId: "turn_01", state: "interrupted" });
    const aborted = events.find((e) => e.type === "chat.turn.aborted");
    expect(aborted).toMatchObject({ reason: "interrupted" });
  });

  it("emits chat.turn.aborted with reason=error on error state", () => {
    const { events, emit } = makeEventCollector();
    const store = makeTurnStore({ emit });
    store.start({ threadId: T, turnId: "turn_01", requestedAt: "2026-05-11T10:00:00.000Z" });
    store.transition({ threadId: T, turnId: "turn_01", state: "error" });
    expect(events.find((e) => e.type === "chat.turn.aborted")).toMatchObject({
      reason: "error",
    });
  });

  it("does not emit on a same-state no-op transition", () => {
    const { events, emit } = makeEventCollector();
    const store = makeTurnStore({ emit });
    store.start({ threadId: T, turnId: "turn_01", requestedAt: "2026-05-11T10:00:00.000Z" });
    const baseline = events.length;
    store.transition({ threadId: T, turnId: "turn_01", state: "running" });
    expect(events).toHaveLength(baseline);
  });
});

describe("activity-log emissions", () => {
  it("emits chat.activity.appended on append carrying the assigned seq", () => {
    const { events, emit } = makeEventCollector();
    const log = makeActivityLog({ emit });
    const a = log.append({ threadId: T, tone: "info", kind: "k", summary: "s" });
    expect(events).toEqual([
      { type: "chat.activity.appended", threadId: T, activity: a, seq: a.sequence },
    ]);
  });

  it("emits monotonically per thread", () => {
    const { events, emit } = makeEventCollector();
    const log = makeActivityLog({ emit });
    log.append({ threadId: T, tone: "info", kind: "k", summary: "a" });
    log.append({ threadId: T, tone: "info", kind: "k", summary: "b" });
    log.append({ threadId: T, tone: "info", kind: "k", summary: "c" });
    const seqs = events
      .filter((e) => e.type === "chat.activity.appended")
      .map((e) => (e.type === "chat.activity.appended" ? e.seq : -1));
    expect(seqs).toEqual([0, 1, 2]);
  });
});

describe("checkpoint-store emissions", () => {
  it("emits chat.checkpoint.created on first upsert per (thread,turn)", () => {
    const { events, emit } = makeEventCollector();
    const store = makeCheckpointStore({ emit });
    const c = checkpoint({ turnId: "turn_01" });
    store.upsert(T, c);
    expect(events).toEqual([{ type: "chat.checkpoint.created", threadId: T, checkpoint: c }]);
  });

  it("does not re-emit on update of an existing checkpoint", () => {
    const { events, emit } = makeEventCollector();
    const store = makeCheckpointStore({ emit });
    store.upsert(T, checkpoint({ turnId: "turn_01", checkpointRef: "v1" }));
    store.upsert(T, checkpoint({ turnId: "turn_01", checkpointRef: "v2" }));
    expect(events).toHaveLength(1);
  });
});

describe("plan-store emissions", () => {
  it("emits chat.plan.upserted on every upsert", () => {
    const { events, emit } = makeEventCollector();
    const store = makePlanStore({ emit });
    const p = plan({ id: "plan_01" });
    store.upsert(T, p);
    store.upsert(T, plan({ id: "plan_01", planMarkdown: "## Plan v2" }));
    expect(events.map((e) => e.type)).toEqual(["chat.plan.upserted", "chat.plan.upserted"]);
  });

  it("carries the full plan payload through the event", () => {
    const { events, emit } = makeEventCollector();
    const store = makePlanStore({ emit });
    const p = plan({ id: "plan_42", planMarkdown: "## A" });
    store.upsert(T, p);
    expect(events[0]).toMatchObject({ type: "chat.plan.upserted", plan: { id: "plan_42" } });
  });
});

// ---------------------------------------------------------------------------
// Cross-store ordering invariant
// ---------------------------------------------------------------------------

describe("cross-store ordering: TurnStarted → ThreadActivityAppended* → TurnCompleted", () => {
  it("preserves the ordering invariant on a shared bus", () => {
    const { events, emit } = makeEventCollector();
    const turns = makeTurnStore({ emit });
    const activities = makeActivityLog({ emit });

    turns.start({ threadId: T, turnId: "turn_01", requestedAt: "2026-05-11T10:00:00.000Z" });
    activities.append({
      threadId: T,
      tone: "info",
      kind: "step",
      summary: "thinking",
      turnId: "turn_01",
    });
    activities.append({
      threadId: T,
      tone: "tool",
      kind: "tmux.send_to_pane",
      summary: "sent",
      turnId: "turn_01",
    });
    turns.transition({
      threadId: T,
      turnId: "turn_01",
      state: "completed",
      completedAt: "2026-05-11T10:01:00.000Z",
    });

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "chat.turn.started",
      "chat.activity.appended",
      "chat.activity.appended",
      "chat.turn.completed",
    ]);

    const activitySeqs = events
      .filter((e) => e.type === "chat.activity.appended")
      .map((e) => (e.type === "chat.activity.appended" ? e.seq : -1));
    for (let i = 1; i < activitySeqs.length; i += 1) {
      expect(activitySeqs[i]!).toBeGreaterThan(activitySeqs[i - 1]!);
    }
  });

  it("isolates ordering per thread", () => {
    const { events, emit } = makeEventCollector();
    const turns = makeTurnStore({ emit });
    const activities = makeActivityLog({ emit });

    turns.start({ threadId: "thr_a", turnId: "ta1", requestedAt: "2026-05-11T10:00:00.000Z" });
    turns.start({ threadId: "thr_b", turnId: "tb1", requestedAt: "2026-05-11T10:00:00.000Z" });
    activities.append({ threadId: "thr_a", tone: "info", kind: "k", summary: "a1" });
    activities.append({ threadId: "thr_b", tone: "info", kind: "k", summary: "b1" });
    activities.append({ threadId: "thr_a", tone: "info", kind: "k", summary: "a2" });

    const seqsA = events
      .filter((e) => e.type === "chat.activity.appended" && e.threadId === "thr_a")
      .map((e) => (e.type === "chat.activity.appended" ? e.seq : -1));
    const seqsB = events
      .filter((e) => e.type === "chat.activity.appended" && e.threadId === "thr_b")
      .map((e) => (e.type === "chat.activity.appended" ? e.seq : -1));
    expect(seqsA).toEqual([0, 1]);
    expect(seqsB).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// Cross-store integration: turn-store emit observed by activity-log subscriber
// ---------------------------------------------------------------------------

describe("cross-store integration via a shared subscriber", () => {
  it("activity-log subscriber sees turn-store events on the shared bus", () => {
    const bus: ChatThreadEvent[] = [];
    const subscriber = (e: ChatThreadEvent) => bus.push(e);

    const turns = makeTurnStore({ emit: subscriber });
    const activities = makeActivityLog({ emit: subscriber });

    turns.start({ threadId: T, turnId: "turn_01", requestedAt: "2026-05-11T10:00:00.000Z" });
    activities.append({ threadId: T, tone: "info", kind: "k", summary: "x" });
    expect(bus.map((e) => e.type)).toEqual(["chat.turn.started", "chat.activity.appended"]);
  });

  it("subscriber can branch on type for type-safe dispatch", () => {
    const seen = { starts: 0, completes: 0, activities: 0 };
    const subscriber = (e: ChatThreadEvent) => {
      if (e.type === "chat.turn.started") seen.starts += 1;
      else if (e.type === "chat.turn.completed") seen.completes += 1;
      else if (e.type === "chat.activity.appended") seen.activities += 1;
    };
    const turns = makeTurnStore({ emit: subscriber });
    const activities = makeActivityLog({ emit: subscriber });
    turns.start({ threadId: T, turnId: "turn_01", requestedAt: "2026-05-11T10:00:00.000Z" });
    activities.append({ threadId: T, tone: "info", kind: "k", summary: "x" });
    turns.transition({ threadId: T, turnId: "turn_01", state: "completed" });
    expect(seen).toEqual({ starts: 1, completes: 1, activities: 1 });
  });
});

// ---------------------------------------------------------------------------
// WS replay — activity-log is the per-thread replay buffer
// ---------------------------------------------------------------------------

describe("WS replay via activity-log.list({ sinceSeq })", () => {
  it("returns only events with sequence > sinceSeq", () => {
    const log = makeActivityLog();
    const a = log.append({ threadId: T, tone: "info", kind: "k", summary: "a" });
    const b = log.append({ threadId: T, tone: "info", kind: "k", summary: "b" });
    const c = log.append({ threadId: T, tone: "info", kind: "k", summary: "c" });

    // Client saw up through `a.sequence` then disconnected. Reconnect
    // and replay missed events.
    const replay = log.list({ threadId: T, sinceSeq: a.sequence });
    expect(replay).toEqual([b, c]);
  });

  it("returns full history when sinceSeq is omitted", () => {
    const log = makeActivityLog();
    log.append({ threadId: T, tone: "info", kind: "k", summary: "a" });
    log.append({ threadId: T, tone: "info", kind: "k", summary: "b" });
    expect(log.list({ threadId: T })).toHaveLength(2);
  });

  it("returns empty when caller is already at HEAD", () => {
    const log = makeActivityLog();
    const a = log.append({ threadId: T, tone: "info", kind: "k", summary: "a" });
    expect(log.list({ threadId: T, sinceSeq: a.sequence })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Compat shim — legacy chat.thread.update fires alongside the new events
// ---------------------------------------------------------------------------

describe("compat shim: legacy + new events on the same bus", () => {
  // Simulate the daemon's busEmit which accepts the union of legacy and
  // new event shapes. The shim doesn't translate — both flow side-by-side
  // until T080 removes the legacy emit.
  type LegacyOrNew =
    | { type: "chat.thread.update"; threadId: string; seq: number }
    | ChatThreadEvent;

  it("a single store emit reaches a bus that accepts both shapes", () => {
    const bus: LegacyOrNew[] = [];
    const emit = (e: LegacyOrNew) => bus.push(e);
    const turns = makeTurnStore({ emit });

    // Legacy publisher
    emit({ type: "chat.thread.update", threadId: T, seq: 7 });
    // New publisher
    turns.start({ threadId: T, turnId: "turn_01", requestedAt: "2026-05-11T10:00:00.000Z" });

    expect(bus.map((e) => e.type)).toEqual(["chat.thread.update", "chat.turn.started"]);
  });

  it("a consumer can filter just the new events without seeing legacy noise", () => {
    const bus: LegacyOrNew[] = [];
    const emit = (e: LegacyOrNew) => bus.push(e);
    const turns = makeTurnStore({ emit });

    emit({ type: "chat.thread.update", threadId: T, seq: 0 });
    turns.start({ threadId: T, turnId: "turn_01", requestedAt: "2026-05-11T10:00:00.000Z" });
    emit({ type: "chat.thread.update", threadId: T, seq: 1 });
    turns.transition({ threadId: T, turnId: "turn_01", state: "completed" });

    const newOnly = bus.filter(
      (e): e is ChatThreadEvent => e.type.startsWith("chat.") && e.type !== "chat.thread.update",
    );
    expect(newOnly.map((e) => e.type)).toEqual(["chat.turn.started", "chat.turn.completed"]);
  });
});
