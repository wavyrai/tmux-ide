import { describe, expect, it, vi } from "vitest";

import {
  ResizeTransactionController,
  type ResizeTransactionState,
  type ResizeTransactionSubmission,
} from "./resize-transaction.ts";

function harness(options: { submitError?: Error } = {}) {
  let time = 1_000;
  let nextOperation = 1;
  const states: ResizeTransactionState[] = [];
  const submissions: ResizeTransactionSubmission[] = [];
  const timers = new Map<number, { callback: () => void; cancelled: boolean }>();
  let nextTimer = 1;
  const submit = vi.fn((submission: ResizeTransactionSubmission) => {
    submissions.push(submission);
    if (options.submitError) throw options.submitError;
  });
  const controller = new ResizeTransactionController({
    timeoutMs: 250,
    operationId: () => `operation-${nextOperation++}`,
    now: () => time,
    schedule: (callback) => {
      const id = nextTimer++;
      timers.set(id, { callback, cancelled: false });
      return () => {
        const timer = timers.get(id);
        if (timer) timer.cancelled = true;
      };
    },
    submit,
    onState: (state) => states.push(state),
  });
  return {
    controller,
    states,
    submissions,
    submit,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    fireTimers: () => {
      for (const timer of timers.values()) if (!timer.cancelled) timer.callback();
    },
  };
}

const begin = {
  authorityGeneration: "lane-a",
  workspaceName: "workspace.alpha",
  semanticPaneId: "pane.editor",
  axis: "cols" as const,
  canonicalCells: 40,
};

function observation(operationId: string, cells = 60) {
  return {
    operationId,
    authorityGeneration: begin.authorityGeneration,
    workspaceName: begin.workspaceName,
    semanticPaneId: begin.semanticPaneId,
    axis: begin.axis,
    cells,
  };
}

describe("ResizeTransactionController", () => {
  it("submits first/latest of 1000 moves and drains the release target once", () => {
    const h = harness();
    h.controller.begin(begin);
    for (let index = 1; index <= 1_000; index += 1) h.controller.move(40 + index);
    expect(h.submit).toHaveBeenCalledOnce();
    expect(h.submissions[0]!.intent.cells).toBe(41);
    expect(h.controller.state()).toMatchObject({
      phase: "pending",
      canonicalCells: 40,
      previewCells: 1040,
    });
    h.controller.release();
    h.controller.release();
    h.controller.observeLayout(observation("operation-1", 41));
    expect(h.submissions.map((submission) => submission.intent.cells)).toEqual([41, 1040]);
    h.controller.release();
    h.controller.observeLayout(observation("operation-2", 1040));
    h.controller.release();
    expect(h.submit).toHaveBeenCalledTimes(2);
    expect(h.controller.state()).toMatchObject({ phase: "idle", canonicalCells: 1040 });
  });

  it("restores A after B even when release returns to the gesture origin", () => {
    const h = harness();
    h.controller.begin(begin);
    h.controller.move(60);
    h.controller.move(40);
    h.controller.release();
    expect(
      h.controller.observeLayout({ ...observation("operation-1"), authorityGeneration: "retired" }),
    ).toBe(false);
    h.controller.observeLayout(observation("operation-1", 60));
    expect(h.submissions.map((submission) => submission.intent.cells)).toEqual([60, 40]);
    expect(h.controller.observeLayout(observation("operation-1", 60))).toBe(false);
    h.controller.observeLayout(observation("operation-2", 40));
    expect(h.controller.state()).toMatchObject({ phase: "idle", canonicalCells: 40 });
  });

  it("continues dragging after canonical settlement without retrying a clamped target", () => {
    const h = harness();
    h.controller.begin(begin);
    h.controller.move(60);
    h.controller.observeLayout(observation("operation-1", 58));
    expect(h.controller.state()).toMatchObject({
      phase: "dragging",
      canonicalCells: 58,
      previewCells: 60,
    });
    expect(h.submit).toHaveBeenCalledOnce();
    h.controller.move(55);
    h.controller.release();
    h.controller.observeLayout(observation("operation-2", 55));
    expect(h.submissions.map((submission) => submission.intent.cells)).toEqual([60, 55]);
  });

  it("keeps the final preview visible until a matching observed layout settles", () => {
    const h = harness();
    h.controller.begin(begin);
    h.controller.move(60);
    const operationId = h.controller.release()!;

    expect(h.controller.state()).toMatchObject({
      phase: "pending",
      operationId,
      canonicalCells: 40,
      previewCells: 60,
    });
    h.advance(100);
    expect(h.controller.state().phase).toBe("pending");
    expect(h.controller.observeLayout(observation("another-operation"))).toBe(false);
    expect(h.controller.state().phase).toBe("pending");

    expect(h.controller.observeLayout(observation(operationId))).toBe(true);
    expect(h.controller.state()).toEqual({
      phase: "idle",
      canonicalCells: 60,
      outcome: {
        kind: "settled",
        operationId,
        source: "layout",
        cells: 60,
      },
    });
    h.fireTimers();
    expect(h.states.at(-1)).toBe(h.controller.state());
  });

  it("reverts once for a typed rejection and ignores its duplicate", () => {
    const h = harness();
    h.controller.begin(begin);
    h.controller.move(60);
    const operationId = h.controller.release()!;
    const before = h.states.length;

    expect(
      h.controller.reject({ operationId, code: "minimum-size", message: "tmux clamped the pane" }),
    ).toBe(true);
    expect(h.controller.state()).toEqual({
      phase: "idle",
      canonicalCells: 40,
      outcome: {
        kind: "reverted",
        operationId,
        reason: {
          kind: "rejected",
          code: "minimum-size",
          message: "tmux clamped the pane",
        },
      },
    });
    expect(h.controller.reject({ operationId, code: "minimum-size", message: "duplicate" })).toBe(
      false,
    );
    expect(h.states).toHaveLength(before + 1);
  });

  it("ignores duplicate and reordered layout settlement after the core operation is terminal", () => {
    const h = harness();
    h.controller.begin(begin);
    h.controller.move(60);
    const operationId = h.controller.release()!;
    expect(h.controller.observeLayout(observation(operationId, 58))).toBe(true);
    const afterFirst = h.states.length;

    expect(h.controller.observeLayout(observation(operationId, 60))).toBe(false);
    expect(h.controller.observeLayout(observation("older-operation", 40))).toBe(false);
    expect(h.states).toHaveLength(afterFirst);
    expect(h.controller.state()).toMatchObject({ canonicalCells: 58 });
  });

  it("rejects empty routing identity before creating the core generation", () => {
    const h = harness();
    expect(() => h.controller.begin({ ...begin, workspaceName: "" })).toThrow(
      "workspaceName must not be empty",
    );
    expect(() => h.controller.begin({ ...begin, semanticPaneId: "" })).toThrow(
      "semanticPaneId must not be empty",
    );
  });

  it("times out and reverts exactly once without resubmitting", () => {
    const h = harness();
    h.controller.begin(begin);
    h.controller.move(60);
    const operationId = h.controller.release()!;
    h.fireTimers();
    const afterFirstTimeout = h.states.length;

    expect(h.controller.state()).toEqual({
      phase: "idle",
      canonicalCells: 40,
      outcome: {
        kind: "reverted",
        operationId,
        reason: { kind: "timed-out", timeoutMs: 250 },
      },
    });
    h.fireTimers();
    expect(h.states).toHaveLength(afterFirstTimeout);
    expect(h.submit).toHaveBeenCalledOnce();
  });

  it("rejects an overlapping begin until the pending operation settles", () => {
    const h = harness();
    expect(h.controller.begin(begin)).toBe(true);
    h.controller.move(55);
    const first = h.controller.release()!;

    expect(h.controller.begin({ ...begin, canonicalCells: 44 })).toBe(false);
    expect(h.controller.state()).toMatchObject({ phase: "pending", operationId: first });
    expect(h.controller.observeLayout(observation(first, 55))).toBe(true);
    expect(h.controller.begin({ ...begin, canonicalCells: 55 })).toBe(true);
  });

  it("retires a runtime generation and ignores its late layout and rejection", () => {
    const h = harness();
    h.controller.begin(begin);
    h.controller.move(60);
    const operationId = h.controller.release()!;
    h.controller.retire();
    const afterRetire = h.states.length;

    expect(h.controller.observeLayout(observation(operationId, 60))).toBe(false);
    expect(h.controller.reject({ operationId, code: "retired", message: "late old lane" })).toBe(
      false,
    );
    expect(h.states).toHaveLength(afterRetire);
    expect(h.controller.state()).toEqual({ phase: "idle", canonicalCells: null, outcome: null });

    expect(h.controller.begin({ ...begin, authorityGeneration: "lane-b" })).toBe(true);
  });

  it("does not submit an unchanged gesture and can cancel before release", () => {
    const h = harness();
    h.controller.begin(begin);
    expect(h.controller.release()).toBeNull();
    expect(h.submit).not.toHaveBeenCalled();

    h.controller.begin(begin);
    h.controller.move(52);
    expect(h.controller.cancelDrag()).toBe(true);
    h.controller.move(70);
    h.controller.release();
    h.controller.observeLayout(observation("operation-1", 52));
    expect(h.submit).toHaveBeenCalledOnce();
    expect(h.controller.state()).toMatchObject({ phase: "idle", canonicalCells: 52 });
  });

  it("disposes a pending gesture without dispatching queued motion or accepting late settlement", () => {
    const h = harness();
    h.controller.begin(begin);
    h.controller.move(60);
    h.controller.move(70);
    h.controller.dispose();
    h.fireTimers();
    expect(h.controller.observeLayout(observation("operation-1", 60))).toBe(false);
    expect(h.controller.begin(begin)).toBe(false);
    expect(h.controller.release()).toBeNull();
    expect(h.submit).toHaveBeenCalledOnce();
  });

  it("turns a synchronous submit failure into one typed local revert", () => {
    const h = harness({ submitError: new Error("socket closed") });
    h.controller.begin(begin);
    h.controller.move(60);
    h.controller.release();
    const operationId = h.submissions[0]!.operationId;

    expect(h.submit).toHaveBeenCalledOnce();
    expect(h.controller.state()).toEqual({
      phase: "idle",
      canonicalCells: 40,
      outcome: {
        kind: "reverted",
        operationId,
        reason: { kind: "submit-failed", message: "socket closed" },
      },
    });
    h.fireTimers();
    expect(h.submit).toHaveBeenCalledOnce();
  });
});
