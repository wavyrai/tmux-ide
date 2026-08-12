import { describe, expect, it } from "vitest";

import { LocalPerformanceAggregator } from "./performance-metrics.ts";

const authority = {
  daemonInstanceId: "00000000-0000-4000-8000-000000000001",
  workspaceName: "workspace",
  generation: "00000000-0000-4000-8000-000000000001",
  incarnation: "pane-a:1",
} as const;

function aggregator(capacity = 4): LocalPerformanceAggregator {
  return new LocalPerformanceAggregator({ source: "opentui", authority, sampleCapacity: capacity });
}

describe("LocalPerformanceAggregator", () => {
  it("is explicitly opt-in and disabled record paths are allocation-free no-ops", () => {
    const metrics = aggregator();
    metrics.recordFrame(Number.NaN);
    metrics.recordDirtyRows(-1);
    metrics.recordParse(Number.NaN);
    metrics.recordPaint(-1);
    metrics.recordQueueDepth(-1, -1);
    metrics.recordRevisionLag(-1);
    metrics.recordReseed();
    expect(metrics.enabled).toBe(false);
    expect(metrics.snapshot()).toBeNull();
    expect(metrics.disable()).toBe(false);
  });

  it("retains a fixed-capacity nearest-rank window and exact local summaries", () => {
    const metrics = aggregator(4);
    expect(metrics.enable()).toBe(true);
    expect(metrics.enable()).toBe(false);
    for (const value of [100, 2, 4, 8, 16]) metrics.recordParse(value);
    for (const value of [1, 3, 5]) metrics.recordDirtyRows(value);
    metrics.recordPaint(2.5);
    metrics.recordFrame(20);
    metrics.recordQueueDepth(3, 8);
    metrics.recordQueueDepth(5, 12);
    metrics.recordQueueDepth(2, 6);
    metrics.recordRevisionLag(4);
    metrics.recordRevisionLag(1);
    metrics.recordReseed();

    expect(metrics.snapshot()).toMatchObject({
      source: "opentui",
      activeFps: 50,
      dirtyRows: { count: 3, latest: 5, p50: 3, p95: 5, max: 5 },
      parseMs: { count: 4, latest: 16, p50: 4, p95: 16, max: 16 },
      paintMs: { count: 1, latest: 2.5, p50: 2.5, p95: 2.5, max: 2.5 },
      queueDepth: {
        current: 2,
        peak: 5,
        capacity: { current: 6, peak: 12 },
      },
      revisionLag: { current: 1, peak: 4 },
      reseeds: 1,
    });
  });

  it("resets measurements on a new activation without reusing the sequence", () => {
    const metrics = aggregator();
    metrics.enable();
    metrics.recordParse(3);
    const before = metrics.snapshot()!;
    expect(before.sampleSequence).toBe(1);
    expect(metrics.disable()).toBe(true);
    expect(metrics.snapshot()).toBeNull();
    expect(metrics.enable()).toBe(true);
    const reset = metrics.snapshot()!;
    expect(reset.sampleSequence).toBe(before.sampleSequence);
    expect(reset.parseMs.count).toBe(0);
    expect(reset.activeFps).toBeNull();
    expect(reset.reseeds).toBe(0);
    metrics.recordReseed();
    expect(metrics.snapshot()!.sampleSequence).toBeGreaterThan(before.sampleSequence);
  });

  it("advances sequence only for admitted events, never for snapshot reads", () => {
    const metrics = aggregator();
    metrics.enable();
    expect(metrics.snapshot()!.sampleSequence).toBe(0);
    expect(metrics.snapshot()!.sampleSequence).toBe(0);
    metrics.recordFrame(10);
    metrics.recordDirtyRows(1);
    metrics.recordParse(1);
    metrics.recordPaint(1);
    metrics.recordQueueDepth(0, 4);
    metrics.recordRevisionLag(0);
    metrics.recordReseed();
    expect(metrics.snapshot()!.sampleSequence).toBe(7);
    expect(metrics.snapshot()!.sampleSequence).toBe(7);
  });

  it("preserves unavailable capacities and revision lag instead of inventing zero", () => {
    const metrics = aggregator();
    metrics.enable();
    expect(metrics.snapshot()).toMatchObject({
      queueDepth: { capacity: { current: null, peak: null } },
      revisionLag: { current: null, peak: null },
    });
    metrics.recordQueueDepth(4);
    metrics.recordQueueDepth(1, 8);
    expect(metrics.snapshot()).toMatchObject({
      queueDepth: { current: 1, peak: 4, capacity: { current: 8, peak: null } },
    });
  });

  it("validates enabled observations without timing or I/O of its own", () => {
    const metrics = aggregator();
    metrics.enable();
    expect(() => metrics.recordFrame(0)).toThrow(/positive/u);
    expect(() => metrics.recordDirtyRows(1.5)).toThrow(/integer/u);
    expect(() => metrics.recordParse(Number.NaN)).toThrow(/finite/u);
    expect(() => metrics.recordPaint(-1)).toThrow(/non-negative/u);
    expect(() => metrics.recordQueueDepth(2, 1)).toThrow(/capacity/u);
    expect(() => metrics.recordRevisionLag(-1)).toThrow(/non-negative/u);
  });
});
