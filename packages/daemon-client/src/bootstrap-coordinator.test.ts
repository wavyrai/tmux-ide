import { describe, expect, it } from "bun:test";

import { DaemonBootstrapCoordinator, type DaemonBootstrapPhase } from "./bootstrap-coordinator.ts";

interface Candidate {
  readonly generation: string;
}

describe("DaemonBootstrapCoordinator", () => {
  it("returns an already compatible generation without spawning", async () => {
    const candidate = { generation: "existing" };
    let starts = 0;
    const phases: DaemonBootstrapPhase[] = [];
    const coordinator = new DaemonBootstrapCoordinator<Candidate>({
      probe: () => ({ status: "compatible", candidate }),
      spawn: () => {
        starts += 1;
      },
      onPhaseChanged: ({ phase }) => phases.push(phase),
    });
    const result = await coordinator.ensure();
    expect(result).toMatchObject({ candidate, source: "existing" });
    expect(result.timings.controlReadyAt).not.toBeNull();
    expect(starts).toBe(0);
    expect(phases).toEqual(["probing", "control-ready", "ready"]);
  });

  it("single-flights concurrent starters through control and empty inventory", async () => {
    let candidate: Candidate | null = null;
    let starts = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const phases: DaemonBootstrapPhase[] = [];
    const coordinator = new DaemonBootstrapCoordinator<Candidate, string[]>({
      probe: () =>
        candidate ? { status: "compatible", candidate } : { status: "absent-or-stale" },
      spawn: async () => {
        starts += 1;
        await barrier;
        candidate = { generation: "winner" };
      },
      reconcileInventory: () => ({ status: "empty", inventory: [] }),
      onPhaseChanged: ({ phase }) => phases.push(phase),
    });
    const first = coordinator.ensure();
    const second = coordinator.ensure();
    expect(first).toBe(second);
    release();
    await expect(first).resolves.toMatchObject({ source: "started", inventory: [] });
    expect(starts).toBe(1);
    expect(phases).toEqual([
      "probing",
      "spawning",
      "control-ready",
      "inventory-reconciling",
      "ready",
    ]);
  });

  it("preserves an incompatible probe reason without spawning", async () => {
    let starts = 0;
    const coordinator = new DaemonBootstrapCoordinator<Candidate, never, "protocol-mismatch">({
      probe: () => ({ status: "incompatible", reason: "protocol-mismatch" }),
      spawn: () => {
        starts += 1;
      },
    });
    await expect(coordinator.ensure()).rejects.toMatchObject({
      code: "incompatible",
      reason: "protocol-mismatch",
    });
    expect(starts).toBe(0);
    expect(coordinator.snapshot()).toMatchObject({
      phase: "incompatible",
      reason: "protocol-mismatch",
    });
  });

  it("times out deterministically and permits a later retry", async () => {
    let clock = 0;
    let starts = 0;
    const coordinator = new DaemonBootstrapCoordinator<Candidate>({
      probe: () => ({ status: "absent-or-stale" }),
      spawn: () => {
        starts += 1;
      },
      timeoutMs: 3,
      pollMs: () => 1,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    });
    await expect(coordinator.ensure()).rejects.toMatchObject({ code: "control-timeout" });
    await expect(coordinator.ensure()).rejects.toMatchObject({ code: "control-timeout" });
    expect(starts).toBe(2);
    expect(coordinator.snapshot()).toMatchObject({ phase: "failed", attempt: 2 });
  });
});
