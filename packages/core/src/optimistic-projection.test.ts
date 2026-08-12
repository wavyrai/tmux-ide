import { describe, expect, it } from "vitest";

import {
  createOptimisticProjection,
  deriveOptimisticProjection,
  enqueueOptimisticOperation,
  expireOptimisticOperations,
  reconcileOptimisticOperation,
  replaceCommittedProjection,
} from "./optimistic-projection.ts";

interface CounterIntent {
  readonly client: string;
  readonly delta: number;
}

const options = {
  predict: (value: number, intent: CounterIntent) => value + intent.delta,
  terminalHistoryLimit: 4,
};

function enqueue(
  state: ReturnType<typeof createOptimisticProjection<number, CounterIntent>>,
  operationId: string,
  client: string,
  delta: number,
) {
  return enqueueOptimisticOperation(state, {
    operationId,
    intent: { client, delta },
    acceptedAtMs: 10,
    deadlineAtMs: 1_000,
  });
}

describe("committed/pending/derived projection", () => {
  it("applies interleaved client predictions in admission order", () => {
    let state = createOptimisticProjection<number, CounterIntent>({
      generation: "daemon-a",
      revision: 1,
      value: 10,
    });
    state = enqueue(state, "web-1", "web", 2);
    state = enqueue(state, "tui-1", "tui", 3);
    state = enqueue(state, "sdk-1", "sdk", -1);
    expect(deriveOptimisticProjection(state, options)).toBe(14);
    expect(state.pending.map(({ operationId }) => operationId)).toEqual([
      "web-1",
      "tui-1",
      "sdk-1",
    ]);
  });

  it("settles duplicate and reordered terminal receipts exactly once", () => {
    let state = createOptimisticProjection<number, CounterIntent>({
      generation: "daemon-a",
      revision: 1,
      value: 0,
    });
    state = enqueue(state, "web-1", "web", 4);
    state = enqueue(state, "tui-1", "tui", 5);
    state = reconcileOptimisticOperation(state, "tui-1", "observed", options);
    const settled = state;
    state = reconcileOptimisticOperation(state, "tui-1", "rejected", options);
    expect(state).toBe(settled);
    expect(deriveOptimisticProjection(state, options)).toBe(4);

    const terminalFirst = reconcileOptimisticOperation(
      createOptimisticProjection<number, CounterIntent>({
        generation: "daemon-a",
        revision: 1,
        value: 0,
      }),
      "late-admission",
      "observed",
      options,
    );
    expect(enqueue(terminalFirst, "late-admission", "sdk", 10)).toBe(terminalFirst);
  });

  it("retains safe pending intent across generations until observed or expired", () => {
    let state = createOptimisticProjection<number, CounterIntent>({
      generation: "daemon-a",
      revision: 8,
      value: 10,
    });
    state = enqueue(state, "web-1", "web", 2);
    state = enqueue(state, "tui-1", "tui", 3);
    state = replaceCommittedProjection(
      state,
      { generation: "daemon-b", revision: 0, value: 12 },
      { observedOperationIds: ["web-1"], nowMs: 20 },
    );
    expect(state.pending.map(({ operationId }) => operationId)).toEqual(["tui-1"]);
    expect(deriveOptimisticProjection(state, options)).toBe(15);
    expect(enqueue(state, "web-1", "web", 99)).toBe(state);
    state = expireOptimisticOperations(state, 1_000, options);
    expect(state.pending).toEqual([]);
    expect(deriveOptimisticProjection(state, options)).toBe(12);
  });

  it("rejects stale same-generation commits and duplicate operation admission", () => {
    let state = createOptimisticProjection<number, CounterIntent>({
      generation: "daemon-a",
      revision: 5,
      value: 10,
    });
    state = enqueue(state, "same", "web", 1);
    expect(enqueue(state, "same", "web", 99)).toBe(state);
    expect(
      replaceCommittedProjection(
        state,
        { generation: "daemon-a", revision: 4, value: 999 },
        { nowMs: 20 },
      ),
    ).toBe(state);
  });
});
