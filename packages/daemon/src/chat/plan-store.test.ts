import { describe, expect, it } from "vitest";
import type { ChatThreadEvent, ProposedPlan } from "@tmux-ide/contracts";
import { makePlanStore, PlanNotFoundError } from "./plan-store.ts";

const T = "thr-1";

function makePlan(overrides: Partial<ProposedPlan> = {}): ProposedPlan {
  return {
    id: "plan-1",
    turnId: null,
    planMarkdown: "# Plan",
    implementedAt: null,
    implementationThreadId: null,
    createdAt: "2026-05-11T10:00:00.000Z",
    updatedAt: "2026-05-11T10:00:00.000Z",
    ...overrides,
  };
}

function collector() {
  const events: ChatThreadEvent[] = [];
  return { events, emit: (e: ChatThreadEvent) => events.push(e) };
}

describe("plan-store", () => {
  it("upserts a new plan and returns it", () => {
    const store = makePlanStore();
    const p = makePlan();
    const result = store.upsert(T, p);
    expect(result).toEqual(p);
    expect(store.get(T, p.id)).toEqual(p);
  });

  it("upsert replaces an existing plan with the same id", () => {
    const store = makePlanStore();
    store.upsert(T, makePlan({ id: "p", planMarkdown: "v1" }));
    const v2 = makePlan({ id: "p", planMarkdown: "v2" });
    store.upsert(T, v2);
    expect(store.get(T, "p")).toEqual(v2);
    expect(store.list(T)).toHaveLength(1);
  });

  it("emits chat.plan.upserted on every upsert", () => {
    const { events, emit } = collector();
    const store = makePlanStore({ emit });
    store.upsert(T, makePlan({ id: "a" }));
    store.upsert(T, makePlan({ id: "a", planMarkdown: "v2" }));
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === "chat.plan.upserted")).toBe(true);
  });

  it("get returns null for an unknown plan id", () => {
    const store = makePlanStore();
    expect(store.get(T, "nope")).toBeNull();
    expect(store.get("missing-thread", "nope")).toBeNull();
  });

  it("list / listForThread return plans sorted by createdAt", () => {
    const store = makePlanStore();
    store.upsert(T, makePlan({ id: "b", createdAt: "2026-05-11T11:00:00.000Z" }));
    store.upsert(T, makePlan({ id: "a", createdAt: "2026-05-11T10:00:00.000Z" }));
    store.upsert(T, makePlan({ id: "c", createdAt: "2026-05-11T12:00:00.000Z" }));
    expect(store.list(T).map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(store.listForThread(T).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("list returns an empty array for an unknown thread", () => {
    const store = makePlanStore();
    expect(store.list("nope")).toEqual([]);
    expect(store.listForThread("nope")).toEqual([]);
  });

  it("plans on different threads are isolated", () => {
    const store = makePlanStore();
    store.upsert("thr-A", makePlan({ id: "p" }));
    store.upsert("thr-B", makePlan({ id: "p" }));
    expect(store.list("thr-A")).toHaveLength(1);
    expect(store.list("thr-B")).toHaveLength(1);
    store.clear("thr-A");
    expect(store.list("thr-A")).toEqual([]);
    expect(store.list("thr-B")).toHaveLength(1);
  });

  it("markImplemented stamps implementedAt + implementationThreadId and re-emits", () => {
    const { events, emit } = collector();
    const store = makePlanStore({ emit, now: () => new Date("2026-05-11T12:00:00.000Z") });
    store.upsert(T, makePlan({ id: "p" }));
    const updated = store.markImplemented(T, "p", "thr-child");
    expect(updated.implementedAt).toBe("2026-05-11T12:00:00.000Z");
    expect(updated.implementationThreadId).toBe("thr-child");
    expect(updated.updatedAt).toBe("2026-05-11T12:00:00.000Z");
    expect(store.get(T, "p")).toEqual(updated);
    expect(events.map((e) => e.type)).toEqual(["chat.plan.upserted", "chat.plan.upserted"]);
  });

  it("markImplemented honors an explicit implementedAt override", () => {
    const store = makePlanStore();
    store.upsert(T, makePlan({ id: "p" }));
    const updated = store.markImplemented(T, "p", "thr-child", "2027-01-01T00:00:00.000Z");
    expect(updated.implementedAt).toBe("2027-01-01T00:00:00.000Z");
    expect(updated.updatedAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("markImplemented throws PlanNotFoundError for an unknown plan", () => {
    const store = makePlanStore();
    expect(() => store.markImplemented(T, "missing", "thr")).toThrow(PlanNotFoundError);
  });

  it("markRejected sets the rejected field with timestamp + optional reason", () => {
    const { events, emit } = collector();
    const store = makePlanStore({ emit, now: () => new Date("2026-05-11T13:00:00.000Z") });
    store.upsert(T, makePlan({ id: "p" }));
    const rejected = store.markRejected(T, "p", { reason: "wrong direction" });
    expect(rejected.rejected).toEqual({
      at: "2026-05-11T13:00:00.000Z",
      reason: "wrong direction",
    });
    expect(rejected.updatedAt).toBe("2026-05-11T13:00:00.000Z");
    expect(rejected.implementedAt).toBeNull();
    expect(events).toHaveLength(2);
  });

  it("markRejected without a reason still stamps the rejection timestamp", () => {
    const store = makePlanStore({ now: () => new Date("2026-05-11T14:00:00.000Z") });
    store.upsert(T, makePlan({ id: "p" }));
    const rejected = store.markRejected(T, "p");
    expect(rejected.rejected).toEqual({ at: "2026-05-11T14:00:00.000Z" });
  });

  it("markRejected throws PlanNotFoundError for an unknown plan", () => {
    const store = makePlanStore();
    expect(() => store.markRejected(T, "missing")).toThrow(PlanNotFoundError);
  });

  it("remove returns true when a plan existed and false otherwise", () => {
    const store = makePlanStore();
    store.upsert(T, makePlan({ id: "p" }));
    expect(store.remove(T, "p")).toBe(true);
    expect(store.remove(T, "p")).toBe(false);
    expect(store.get(T, "p")).toBeNull();
  });

  it("clear drops every plan on the thread", () => {
    const store = makePlanStore();
    store.upsert(T, makePlan({ id: "a" }));
    store.upsert(T, makePlan({ id: "b" }));
    store.clear(T);
    expect(store.list(T)).toEqual([]);
  });
});
