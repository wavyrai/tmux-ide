import { describe, expect, it } from "vitest";
import { InputTap, percentile, summarize } from "./perf-tap.ts";

describe("InputTap", () => {
  it("emits a sample only after echo, on the next tick", () => {
    const tap = new InputTap();
    tap.sent("%1", 100);
    // A tick before the echo lands emits nothing and keeps the pane in flight.
    expect(tap.tick(105)).toEqual([]);
    expect(tap.size()).toBe(1);
    tap.output("%1", 110); // t1
    const out = tap.tick(120); // t2
    expect(out).toEqual([{ paneId: "%1", echoMs: 10, paintMs: 20 }]);
    expect(tap.size()).toBe(0);
  });

  it("records only the FIRST output after a sent", () => {
    const tap = new InputTap();
    tap.sent("%1", 0);
    tap.output("%1", 5); // first echo → t1
    tap.output("%1", 9); // later bytes ignored
    expect(tap.tick(12)).toEqual([{ paneId: "%1", echoMs: 5, paintMs: 12 }]);
  });

  it("ignores output with no keystroke in flight", () => {
    const tap = new InputTap();
    tap.output("%1", 5); // flood byte, no sent
    expect(tap.tick(10)).toEqual([]);
  });

  it("tracks panes independently", () => {
    const tap = new InputTap();
    tap.sent("%1", 0);
    tap.sent("%2", 0);
    tap.output("%1", 3);
    const out = tap.tick(10);
    expect(out).toEqual([{ paneId: "%1", echoMs: 3, paintMs: 10 }]);
    // %2 never echoed — still in flight.
    expect(tap.size()).toBe(1);
  });

  it("a later sent for the same pane overwrites an unfinished one", () => {
    const tap = new InputTap();
    tap.sent("%1", 0);
    tap.sent("%1", 100); // superseded (no echo arrived for the first)
    tap.output("%1", 105);
    expect(tap.tick(110)).toEqual([{ paneId: "%1", echoMs: 5, paintMs: 10 }]);
  });

  it("ignores an empty pane id", () => {
    const tap = new InputTap();
    tap.sent("", 0);
    expect(tap.size()).toBe(0);
  });
});

describe("percentile", () => {
  it("returns 0 for an empty array", () => {
    expect(percentile([], 50)).toBe(0);
  });
  it("returns the sole value for a singleton", () => {
    expect(percentile([7], 95)).toBe(7);
  });
  it("interpolates between ranks", () => {
    const sorted = [0, 10, 20, 30, 40];
    expect(percentile(sorted, 0)).toBe(0);
    expect(percentile(sorted, 50)).toBe(20);
    expect(percentile(sorted, 100)).toBe(40);
    expect(percentile(sorted, 25)).toBe(10);
  });
  it("clamps out-of-range p", () => {
    expect(percentile([1, 2, 3], -5)).toBe(1);
    expect(percentile([1, 2, 3], 500)).toBe(3);
  });
});

describe("summarize", () => {
  it("summarizes a distribution regardless of input order", () => {
    const s = summarize([30, 10, 20, 40, 0]);
    expect(s).toEqual({ count: 5, p50: 20, p95: 38, min: 0, max: 40, mean: 20 });
  });
  it("handles an empty input", () => {
    expect(summarize([])).toEqual({ count: 0, p50: 0, p95: 0, min: 0, max: 0, mean: 0 });
  });
});
