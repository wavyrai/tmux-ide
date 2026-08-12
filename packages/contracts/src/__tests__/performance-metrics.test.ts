import { describe, expect, it } from "vitest";

import { LocalPerformanceSnapshotV1SchemaZ } from "../performance-metrics.ts";

const emptyDistribution = {
  count: 0,
  latest: null,
  p50: null,
  p95: null,
  max: null,
} as const;

function snapshot() {
  return {
    version: 1,
    source: "opentui",
    sampleSequence: 0,
    authority: {
      daemonInstanceId: null,
      workspaceName: null,
      generation: null,
      incarnation: null,
    },
    activeFps: null,
    dirtyRows: emptyDistribution,
    parseMs: emptyDistribution,
    paintMs: emptyDistribution,
    queueDepth: { current: 0, peak: 0, capacity: { current: null, peak: null } },
    revisionLag: { current: null, peak: null },
    reseeds: 0,
  } as const;
}

describe("local performance snapshot contract", () => {
  it("accepts and freezes the idle snapshot without inventing unavailable values", () => {
    const parsed = LocalPerformanceSnapshotV1SchemaZ.parse(snapshot());
    expect(parsed.activeFps).toBeNull();
    expect(parsed.revisionLag.current).toBeNull();
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.authority)).toBe(true);
    expect(Object.isFrozen(parsed.queueDepth.capacity)).toBe(true);
  });

  it("rejects malformed, unsafe, and internally inconsistent measurements", () => {
    expect(() =>
      LocalPerformanceSnapshotV1SchemaZ.parse({ ...snapshot(), activeFps: Number.NaN }),
    ).toThrow();
    expect(() =>
      LocalPerformanceSnapshotV1SchemaZ.parse({
        ...snapshot(),
        parseMs: { count: 1, latest: 2, p50: 3, p95: 2, max: 3 },
      }),
    ).toThrow(/ordered/u);
    expect(() =>
      LocalPerformanceSnapshotV1SchemaZ.parse({
        ...snapshot(),
        queueDepth: { current: 3, peak: 3, capacity: { current: 2, peak: 2 } },
      }),
    ).toThrow(/capacity/u);
    expect(() =>
      LocalPerformanceSnapshotV1SchemaZ.parse({
        ...snapshot(),
        revisionLag: { current: 1, peak: null },
      }),
    ).toThrow(/requires peak/u);
    expect(() =>
      LocalPerformanceSnapshotV1SchemaZ.parse({
        ...snapshot(),
        sampleSequence: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
  });
});
