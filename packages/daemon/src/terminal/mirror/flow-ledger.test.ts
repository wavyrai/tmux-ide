/**
 * Unit tests for the pure flow-control ledger.
 */
import { describe, expect, it } from "vitest";
import { FlowLedger } from "./flow-ledger.ts";

describe("FlowLedger", () => {
  it("tracks backpressure pauses and continues", () => {
    const ledger = new FlowLedger();
    ledger.notePause("%1");
    ledger.notePause("%2");
    expect(ledger.isBackpressured("%1")).toBe(true);
    ledger.noteContinued("%1");
    expect(ledger.isBackpressured("%1")).toBe(false);
    expect(ledger.isBackpressured("%2")).toBe(true);
  });

  it("keeps requested freezes out of the sticky recovery set", () => {
    const ledger = new FlowLedger();
    ledger.notePause("%1");
    ledger.notePause("%2");
    ledger.requestPause("%2");
    expect(ledger.stickyRecoverySet()).toEqual(["%1"]);
    ledger.clearRequest("%2");
    expect(ledger.stickyRecoverySet().sort()).toEqual(["%1", "%2"]);
  });

  it("a requested pause alone never enters the recovery set", () => {
    const ledger = new FlowLedger();
    ledger.requestPause("%9");
    expect(ledger.stickyRecoverySet()).toEqual([]);
    expect(ledger.isRequested("%9")).toBe(true);
  });

  it("forget clears both ledgers for a closed pane", () => {
    const ledger = new FlowLedger();
    ledger.notePause("%3");
    ledger.requestPause("%3");
    ledger.forget("%3");
    expect(ledger.snapshot()).toEqual({ backpressured: [], requested: [] });
  });
});
