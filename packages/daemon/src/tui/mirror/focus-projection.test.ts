import { describe, expect, it, vi } from "vitest";
import { FocusProjectionController } from "./focus-projection.ts";

function harness() {
  let now = 0;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const submitted = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const timers: Array<() => void> = [];
  const focus = vi.fn();
  const rejected = vi.fn();
  const submit = vi.fn(() => submitted);
  const controller = new FocusProjectionController({
    generation: "daemon-a",
    initialPaneId: "%1",
    timeoutMs: 100,
    now: () => now,
    operationId: () => "operation-1",
    schedule: (callback) => {
      timers.push(callback);
      return vi.fn();
    },
    submit,
    onFocus: focus,
    onRejected: rejected,
  });
  return {
    controller,
    focus,
    rejected,
    submit,
    resolve,
    reject,
    timers,
    advance: () => (now = 100),
  };
}

describe("OpenTUI focus projection", () => {
  it("previews synchronously, submits exactly once and commits only on observation", async () => {
    const h = harness();
    expect(h.controller.select("%2")).toBe("operation-1");
    expect(h.controller.focus()).toBe("%2");
    expect(h.focus).toHaveBeenLastCalledWith("%2");
    expect(h.submit).toHaveBeenCalledOnce();
    h.resolve();
    await Promise.resolve();
    expect(h.controller.focus()).toBe("%2");
    h.controller.observe("%1");
    expect(h.controller.focus()).toBe("%2");
    h.controller.observe("%2");
    expect(h.controller.focus()).toBe("%2");
  });

  it("rolls back a rejected focus once", async () => {
    const h = harness();
    h.controller.select("%2");
    h.reject(new Error("viewer only"));
    await Promise.resolve();
    expect(h.controller.focus()).toBe("%1");
    expect(h.rejected).toHaveBeenCalledOnce();
  });

  it("expires an unobserved focus without another submit", () => {
    const h = harness();
    h.controller.select("%2");
    h.advance();
    h.timers[0]!();
    expect(h.controller.focus()).toBe("%1");
    expect(h.submit).toHaveBeenCalledOnce();
    expect(h.rejected).toHaveBeenCalledWith("pane focus timed out");
  });

  it("does not submit an already derived focus target", () => {
    const h = harness();
    expect(h.controller.select("%1")).toBeNull();
    expect(h.submit).not.toHaveBeenCalled();
    h.controller.select("%2");
    expect(h.controller.select("%2")).toBeNull();
    expect(h.submit).toHaveBeenCalledOnce();
  });
});
