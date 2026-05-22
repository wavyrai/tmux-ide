import { describe, expect, it } from "vitest";
import type { ChatThreadEvent } from "@tmux-ide/contracts";
import { makeSessionStore, SessionStoreError } from "./session-store.ts";

const T = "thr_01";

function makeStore() {
  const events: ChatThreadEvent[] = [];
  let counter = 0;
  const store = makeSessionStore({
    now: () => new Date("2026-05-11T10:00:00.000Z"),
    randomId: () => `sess_${++counter}`,
    emit: (e) => events.push(e),
  });
  return { store, events };
}

describe("session-store", () => {
  it("adds a session with a generated id and emits chat.session.added", () => {
    const { store, events } = makeStore();
    const session = store.add({ threadId: T, providerName: "claude-code" });
    expect(session.id).toBe("sess_1");
    expect(session.status).toBe("idle");
    expect(session.runtimeMode).toBe("full-access");
    expect(events).toEqual([{ type: "chat.session.added", threadId: T, session }]);
  });

  it("preserves an explicit id", () => {
    const { store } = makeStore();
    const session = store.add({ threadId: T, id: "lead", providerName: "claude-code" });
    expect(session.id).toBe("lead");
  });

  it("rejects a duplicate session id", () => {
    const { store } = makeStore();
    store.add({ threadId: T, id: "dup", providerName: null });
    expect(() => store.add({ threadId: T, id: "dup", providerName: null })).toThrow(
      SessionStoreError,
    );
  });

  it("stores optional role / displayName / providerInstanceId / activeTurnId", () => {
    const { store } = makeStore();
    const session = store.add({
      threadId: T,
      providerName: "codex",
      providerInstanceId: "codex-default",
      role: "planner",
      displayName: "Plan B",
      activeTurnId: "turn_99",
    });
    expect(session.role).toBe("planner");
    expect(session.displayName).toBe("Plan B");
    expect(session.providerInstanceId).toBe("codex-default");
    expect(session.activeTurnId).toBe("turn_99");
  });

  it("get / list return null/[] for empty threads", () => {
    const { store } = makeStore();
    expect(store.get(T, "missing")).toBeNull();
    expect(store.list(T)).toEqual([]);
  });

  it("list returns all sessions for a thread, preserving insertion order", () => {
    const { store } = makeStore();
    const a = store.add({ threadId: T, providerName: "claude-code", role: "lead" });
    const b = store.add({ threadId: T, providerName: "codex", role: "teammate" });
    const c = store.add({ threadId: T, providerName: "codex", role: "validator" });
    expect(store.list(T).map((s) => s.id)).toEqual([a.id, b.id, c.id]);
  });

  it("isolates sessions per thread", () => {
    const { store } = makeStore();
    store.add({ threadId: "thr_a", id: "x", providerName: null });
    store.add({ threadId: "thr_b", id: "y", providerName: null });
    expect(store.list("thr_a").map((s) => s.id)).toEqual(["x"]);
    expect(store.list("thr_b").map((s) => s.id)).toEqual(["y"]);
  });

  it("remove drops the session and emits chat.session.removed", () => {
    const { store, events } = makeStore();
    const session = store.add({ threadId: T, providerName: "claude-code" });
    events.length = 0;
    const removed = store.remove(T, session.id!);
    expect(removed?.id).toBe(session.id);
    expect(store.get(T, session.id!)).toBeNull();
    expect(events).toEqual([{ type: "chat.session.removed", threadId: T, sessionId: session.id }]);
  });

  it("remove on unknown id returns null without emitting", () => {
    const { store, events } = makeStore();
    expect(store.remove(T, "ghost")).toBeNull();
    expect(events).toHaveLength(0);
  });

  it("updateStatus transitions and emits chat.session.status-changed", () => {
    const { store, events } = makeStore();
    const session = store.add({ threadId: T, providerName: "claude-code" });
    events.length = 0;
    const next = store.updateStatus({
      threadId: T,
      sessionId: session.id!,
      status: "running",
      activeTurnId: "turn_10",
    });
    expect(next.status).toBe("running");
    expect(next.activeTurnId).toBe("turn_10");
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.type).toBe("chat.session.status-changed");
    if (evt.type === "chat.session.status-changed") {
      expect(evt.status).toBe("running");
      expect(evt.activeTurnId).toBe("turn_10");
    }
  });

  it("updateStatus preserves activeTurnId when not supplied", () => {
    const { store } = makeStore();
    const session = store.add({
      threadId: T,
      providerName: "claude-code",
      activeTurnId: "turn_5",
    });
    const next = store.updateStatus({
      threadId: T,
      sessionId: session.id!,
      status: "ready",
    });
    expect(next.activeTurnId).toBe("turn_5");
  });

  it("updateStatus records lastError when supplied", () => {
    const { store } = makeStore();
    const session = store.add({ threadId: T, providerName: "codex" });
    const next = store.updateStatus({
      threadId: T,
      sessionId: session.id!,
      status: "error",
      lastError: "boom",
    });
    expect(next.lastError).toBe("boom");
    expect(next.status).toBe("error");
  });

  it("updateStatus on unknown session throws SessionStoreError", () => {
    const { store } = makeStore();
    expect(() => store.updateStatus({ threadId: T, sessionId: "ghost", status: "ready" })).toThrow(
      SessionStoreError,
    );
  });

  it("clear empties the thread bucket", () => {
    const { store } = makeStore();
    store.add({ threadId: T, providerName: null });
    store.add({ threadId: T, providerName: null });
    store.clear(T);
    expect(store.list(T)).toEqual([]);
  });

  it("does not emit when the store is created silently", () => {
    const store = makeSessionStore({
      randomId: () => "x",
      now: () => new Date("2026-05-11T10:00:00.000Z"),
    });
    // should not throw — emit defaults to a no-op
    expect(() => store.add({ threadId: T, providerName: null })).not.toThrow();
  });

  it("emits status-changed with null activeTurnId when explicitly cleared", () => {
    const { store, events } = makeStore();
    const session = store.add({
      threadId: T,
      providerName: "codex",
      activeTurnId: "turn_1",
    });
    events.length = 0;
    store.updateStatus({
      threadId: T,
      sessionId: session.id!,
      status: "interrupted",
      activeTurnId: null,
    });
    const evt = events[0];
    if (evt && evt.type === "chat.session.status-changed") {
      expect(evt.activeTurnId).toBeNull();
    } else {
      throw new Error("expected chat.session.status-changed");
    }
  });

  it("supports add → status → remove → re-add with same id (post-clear of conflicting id)", () => {
    const { store } = makeStore();
    store.add({ threadId: T, id: "ephemeral", providerName: null });
    store.updateStatus({ threadId: T, sessionId: "ephemeral", status: "running" });
    store.remove(T, "ephemeral");
    expect(() => store.add({ threadId: T, id: "ephemeral", providerName: null })).not.toThrow();
  });
});
