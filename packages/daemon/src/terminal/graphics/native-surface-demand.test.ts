import { describe, expect, it, vi } from "vitest";
import { NativeSurfaceDemand } from "./native-surface-demand.ts";

describe("native image fallback demand", () => {
  it("preserves Kitty until native readiness and ordinary-client absence are both proven", () => {
    const demand = new NativeSurfaceDemand();
    const gui = demand.viewer("session", ["pane"]);
    expect(demand.required("pane")).toBe(true);
    gui.native(true);
    expect(demand.required("pane")).toBe(true);
    demand.presence("session", false);
    expect(demand.required("pane")).toBe(false);
    demand.presence("session", null);
    expect(demand.required("pane")).toBe(true);
    demand.presence("session", true);
    expect(demand.required("pane")).toBe(true);
    demand.presence("session", false);
    expect(demand.required("pane")).toBe(false);
    gui.native(false);
    expect(demand.required("pane")).toBe(true);
  });
  it("keeps simultaneous terminal viewers supplied without affecting other panes", () => {
    const demand = new NativeSurfaceDemand();
    demand.presence("session", false);
    const gui = demand.viewer("session", ["one", "two"]);
    gui.native(true);
    const tui = demand.viewer("session", ["one"]);
    expect(demand.required("one")).toBe(true);
    expect(demand.required("two")).toBe(false);
    tui.close();
    tui.close();
    expect(demand.required("one")).toBe(false);
    gui.close();
    expect(demand.required("one")).toBe(true);
  });
  it("coalesces notifications and removes cancelled or failed observers", async () => {
    const demand = new NativeSurfaceDemand();
    const notified = vi.fn();
    const cancelled = vi.fn();
    demand.watch(notified);
    demand.watch(cancelled)();
    const broken = vi.fn(() => {
      throw new Error("closed sink");
    });
    demand.watch(broken);
    for (let i = 0; i < 20; i++) demand.presence("session", false);
    await Promise.resolve();
    expect(notified).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
    demand.close();
    await Promise.resolve();
    expect(notified).toHaveBeenCalledTimes(2);
    expect(broken).toHaveBeenCalledTimes(1);
    expect(demand.required("anything")).toBe(true);
  });
  it("falls back conservatively at capacity and releases overflow leases", () => {
    const demand = new NativeSurfaceDemand();
    demand.presence("s", false);
    const viewers = Array.from({ length: 256 }, () => demand.viewer("s", ["p"]));
    for (const viewer of viewers) viewer.native(true);
    expect(demand.required("p")).toBe(false);
    const overflow = demand.viewer("s", ["q"]);
    expect(demand.required("p")).toBe(true);
    overflow.close();
    expect(demand.required("p")).toBe(false);
    for (let i = 0; i < 256; i++) demand.presence(`other-${i}`, false);
    expect(demand.required("p")).toBe(true);
  });
});
