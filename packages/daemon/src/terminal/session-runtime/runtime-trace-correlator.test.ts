import { describe, expect, it } from "vitest";
import type { SessionRuntimeScheduler } from "./runtime-scheduler.ts";
import { RuntimeTraceCorrelator } from "./runtime-trace-correlator.ts";
import type { SessionRuntimeTraceContext } from "./runtime-observability.ts";

function trace(id: string): SessionRuntimeTraceContext {
  return {
    traceId: id,
    scenario: "terminal-input-to-paint",
    authority: { generation: "11111111-1111-4111-8111-111111111111", incarnation: null },
  };
}

function rig() {
  const timers: Array<{ task: () => void; cancelled: boolean }> = [];
  const scheduler: SessionRuntimeScheduler = {
    nowMs: () => 0,
    createId: () => "00000000-0000-4000-8000-000000000001",
    microtask: (task) => task(),
    timer: (task) => {
      const timer = { task, cancelled: false };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
  };
  return { correlator: new RuntimeTraceCorrelator(scheduler), timers };
}

describe("RuntimeTraceCorrelator", () => {
  it("keeps one bounded latest probe per pane and consumes it exactly once", () => {
    const { correlator, timers } = rig();
    correlator.arm("pane.a", trace("00000000-0000-4000-8000-000000000001"));
    correlator.arm("pane.a", trace("00000000-0000-4000-8000-000000000002"));
    expect(correlator.size).toBe(1);
    expect(timers[0]!.cancelled).toBe(true);
    expect(correlator.take("pane.a")?.traceId).toBe("00000000-0000-4000-8000-000000000002");
    expect(correlator.take("pane.a")).toBeNull();
  });

  it("expires an unanswered probe and never attributes unrelated output", () => {
    const { correlator, timers } = rig();
    expect(correlator.take("pane.external")).toBeNull();
    correlator.arm("pane.a", trace("00000000-0000-4000-8000-000000000003"));
    timers[0]!.task();
    expect(correlator.size).toBe(0);
    expect(correlator.take("pane.a")).toBeNull();
  });

  it("clears one pane at an incarnation boundary without disturbing siblings", () => {
    const { correlator, timers } = rig();
    correlator.arm("pane.a", trace("00000000-0000-4000-8000-000000000004"));
    correlator.arm("pane.b", trace("00000000-0000-4000-8000-000000000005"));
    correlator.clearPane("pane.a");
    expect(timers[0]!.cancelled).toBe(true);
    expect(correlator.take("pane.a")).toBeNull();
    expect(correlator.take("pane.b")?.traceId).toBe("00000000-0000-4000-8000-000000000005");
  });
});
