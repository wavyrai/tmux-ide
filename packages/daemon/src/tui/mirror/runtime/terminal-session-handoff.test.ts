import { describe, expect, it, vi } from "vitest";

import { TerminalSessionHandoff } from "./terminal-session-handoff.ts";

describe("TerminalSessionHandoff", () => {
  it("proves inventory, current layout, and a committed frame before initial readiness", () => {
    const ready = vi.fn();
    const handoff = new TerminalSessionHandoff({ onReady: ready });
    const generation = handoff.begin("alpha");

    handoff.observeFrameCommitted(generation);
    handoff.observeInventory(generation, 2);
    expect(handoff.snapshot().phase).toBe("preparing");
    handoff.observeCurrentLayout(generation, 2);
    expect(handoff.snapshot().phase).toBe("awaiting-frame");
    expect(ready).not.toHaveBeenCalled();

    handoff.observeFrameCommitted(generation);
    expect(handoff.snapshot()).toMatchObject({
      phase: "ready",
      target: "alpha",
      presentedTarget: "alpha",
    });
    expect(ready).toHaveBeenCalledOnce();
  });

  it("retains the last good target throughout switch and fault recovery", () => {
    const handoff = new TerminalSessionHandoff();
    const alpha = handoff.begin("alpha");
    handoff.observeInventory(alpha, 1);
    handoff.observeCurrentLayout(alpha, 1);
    handoff.observeFrameCommitted(alpha);

    const beta = handoff.begin("beta");
    expect(handoff.snapshot()).toMatchObject({ phase: "preparing", presentedTarget: "alpha" });
    handoff.observeInventory(beta, 1);
    handoff.fault(beta, "socket reset");
    expect(handoff.snapshot()).toMatchObject({
      phase: "faulted",
      target: "beta",
      presentedTarget: "alpha",
    });
  });

  it("ignores a stale explicit target after fallback begins", () => {
    const ready = vi.fn();
    const handoff = new TerminalSessionHandoff({ onReady: ready });
    const stale = handoff.begin("missing");
    const live = handoff.begin("live");

    expect(handoff.observeInventory(stale, 1)).toBe(false);
    expect(handoff.observeCurrentLayout(stale, 1)).toBe(false);
    handoff.observeInventory(live, 1);
    handoff.observeCurrentLayout(live, 1);
    expect(handoff.observeFrameCommitted(stale)).toBe(false);
    expect(handoff.observeFrameCommitted(live)).toBe(true);
    expect(ready).toHaveBeenCalledOnce();
    expect(handoff.snapshot()).toMatchObject({ target: "live", presentedTarget: "live" });
  });

  it("never exposes an empty intermediate presentation", () => {
    const drawable = vi.fn();
    const handoff = new TerminalSessionHandoff({ onDrawable: drawable });
    const generation = handoff.begin("alpha");

    handoff.observeInventory(generation, 0);
    handoff.observeCurrentLayout(generation, 3);
    expect(drawable).not.toHaveBeenCalled();
    handoff.observeInventory(generation, 3);
    expect(drawable).toHaveBeenCalledOnce();
  });
});
