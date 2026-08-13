import { describe, expect, it, vi } from "vitest";

import { TerminalToolReadinessGate } from "./terminal-tool-readiness.ts";

describe("TerminalToolReadinessGate", () => {
  it("recovers from a rejected first fit through observed geometry without polling", () => {
    const admit = vi.fn();
    const states: string[] = [];
    const gate = new TerminalToolReadinessGate(admit, (state) => states.push(state.phase));

    gate.observeFitFailure("controller was briefly unavailable");
    expect(admit).not.toHaveBeenCalled();
    expect(gate.snapshot()).toEqual({
      phase: "degraded",
      reason: "controller was briefly unavailable",
    });

    gate.observeGeometry();
    expect(admit).not.toHaveBeenCalled();
    expect(gate.snapshot().phase).toBe("degraded");

    gate.observeTerminalFrameCommitted();
    expect(admit).toHaveBeenCalledTimes(1);
    expect(gate.snapshot().phase).toBe("degraded");

    gate.observeFitSuccess();
    expect(admit).toHaveBeenCalledTimes(1);
    expect(gate.snapshot()).toEqual({ phase: "ready" });
    expect(states).toEqual(["degraded", "ready"]);
  });

  it("requires a terminal render after geometry rather than an earlier frame", () => {
    const admit = vi.fn();
    const gate = new TerminalToolReadinessGate(admit);

    gate.observeTerminalFrameCommitted();
    gate.observeGeometry();
    expect(admit).not.toHaveBeenCalled();

    gate.observeTerminalFrameCommitted();
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it("admits configless Home through the same readiness transition", () => {
    const admit = vi.fn();
    const gate = new TerminalToolReadinessGate(admit);

    gate.observeCatalogReady();
    gate.observeCatalogReady();

    expect(admit).toHaveBeenCalledTimes(1);
    expect(gate.snapshot()).toEqual({ phase: "ready" });
  });
});
