import { describe, expect, it } from "vitest";
import { PaneStreamWireLedger } from "./wire-ledger.ts";

const budgets = {
  "ws-send-buffer": { maxOutstanding: 100, resumeAt: 25 },
  "renderer-backlog": { maxOutstanding: 4, resumeAt: 1 },
} as const;

describe("PaneStreamWireLedger", () => {
  it("accounts tickets per (client x pane x owner)", () => {
    const ledger = new PaneStreamWireLedger(budgets);
    ledger.take("c1", "pane.a", "ws-send-buffer", 60);
    ledger.take("c1", "pane.b", "ws-send-buffer", 10);
    ledger.take("c2", "pane.a", "renderer-backlog", 2);
    expect(ledger.outstanding("c1", "pane.a", "ws-send-buffer")).toBe(60);
    expect(ledger.outstanding("c1", "pane.b", "ws-send-buffer")).toBe(10);
    expect(ledger.outstanding("c2", "pane.a", "renderer-backlog")).toBe(2);
    expect(ledger.outstanding("c2", "pane.a", "ws-send-buffer")).toBe(0);
  });

  it("stalls only the exhausted (client x pane), with per-owner budgets", () => {
    const ledger = new PaneStreamWireLedger(budgets);
    ledger.take("c1", "pane.a", "ws-send-buffer", 101);
    ledger.take("c1", "pane.b", "ws-send-buffer", 100);
    ledger.take("c2", "pane.a", "ws-send-buffer", 5);
    expect(ledger.isStalled("c1", "pane.a")).toBe(true);
    expect(ledger.isStalled("c1", "pane.b")).toBe(false);
    expect(ledger.isStalled("c2", "pane.a")).toBe(false);
    ledger.take("c2", "pane.a", "renderer-backlog", 5);
    expect(ledger.isStalled("c2", "pane.a")).toBe(true);
  });

  it("resumes only after hysteresis clears every owner", () => {
    const ledger = new PaneStreamWireLedger(budgets);
    ledger.take("c1", "pane.a", "ws-send-buffer", 101);
    ledger.take("c1", "pane.a", "renderer-backlog", 3);
    expect(ledger.shouldResume("c1", "pane.a")).toBe(false);
    ledger.give("c1", "pane.a", "ws-send-buffer", 76);
    // 25 outstanding bytes is at resumeAt, but backlog is still above its own.
    expect(ledger.shouldResume("c1", "pane.a")).toBe(false);
    ledger.give("c1", "pane.a", "renderer-backlog", 2);
    expect(ledger.shouldResume("c1", "pane.a")).toBe(true);
  });

  it("clamps over-returns at zero — a give can never mint tickets", () => {
    const ledger = new PaneStreamWireLedger(budgets);
    ledger.take("c1", "pane.a", "renderer-backlog", 2);
    ledger.give("c1", "pane.a", "renderer-backlog", 10);
    expect(ledger.outstanding("c1", "pane.a", "renderer-backlog")).toBe(0);
    ledger.give("c1", "pane.zzz", "ws-send-buffer", 10);
    expect(ledger.snapshot()).toEqual({});
  });

  it("force-returns every ticket on departure and reports them", () => {
    const ledger = new PaneStreamWireLedger(budgets);
    ledger.take("c1", "pane.a", "ws-send-buffer", 40);
    ledger.take("c1", "pane.a", "renderer-backlog", 2);
    ledger.take("c1", "pane.b", "ws-send-buffer", 7);
    ledger.take("c2", "pane.a", "ws-send-buffer", 9);
    const returned = ledger.forceReturnClient("c1");
    expect(returned).toHaveLength(3);
    expect(returned).toContainEqual({ pane: "pane.a", owner: "ws-send-buffer", returned: 40 });
    expect(returned).toContainEqual({ pane: "pane.a", owner: "renderer-backlog", returned: 2 });
    expect(returned).toContainEqual({ pane: "pane.b", owner: "ws-send-buffer", returned: 7 });
    expect(ledger.snapshot()).toEqual({ c2: { "pane.a": { "ws-send-buffer": 9 } } });
    expect(ledger.forceReturnClient("c1")).toEqual([]);
  });

  it("forgets a closed pane's tickets for one client only", () => {
    const ledger = new PaneStreamWireLedger(budgets);
    ledger.take("c1", "pane.a", "ws-send-buffer", 40);
    ledger.take("c2", "pane.a", "ws-send-buffer", 4);
    ledger.forgetPane("c1", "pane.a");
    expect(ledger.outstanding("c1", "pane.a", "ws-send-buffer")).toBe(0);
    expect(ledger.outstanding("c2", "pane.a", "ws-send-buffer")).toBe(4);
  });

  it("ignores non-positive and unsafe amounts", () => {
    const ledger = new PaneStreamWireLedger(budgets);
    ledger.take("c1", "pane.a", "ws-send-buffer", 0);
    ledger.take("c1", "pane.a", "ws-send-buffer", -5);
    ledger.take("c1", "pane.a", "ws-send-buffer", Number.NaN);
    ledger.take("c1", "pane.a", "ws-send-buffer", 2.5);
    expect(ledger.snapshot()).toEqual({});
  });

  it("rejects invalid budgets", () => {
    expect(
      () =>
        new PaneStreamWireLedger({
          "ws-send-buffer": { maxOutstanding: 10, resumeAt: 11 },
          "renderer-backlog": { maxOutstanding: 4, resumeAt: 1 },
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new PaneStreamWireLedger({
          "ws-send-buffer": { maxOutstanding: 0, resumeAt: 0 },
          "renderer-backlog": { maxOutstanding: 4, resumeAt: 1 },
        }),
    ).toThrow(TypeError);
  });
});
