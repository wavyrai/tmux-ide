import { describe, expect, it } from "vitest";

import {
  DEFAULT_SOAK_THRESHOLDS,
  countSpawnsByCommand,
  evaluateSoak,
  formatSoakReport,
  growthPerHour,
  linearFit,
  mergePercentiles,
  parseDurationMs,
  parsePsTime,
  percentile,
  summarizeSoak,
  type SoakSample,
} from "./soak-verdict.ts";

function sample(overrides: Partial<SoakSample> & { elapsedSeconds: number }): SoakSample {
  return {
    at: 1_700_000_000_000 + overrides.elapsedSeconds * 1_000,
    rssKiB: 100 * 1024,
    cpuSeconds: overrides.elapsedSeconds * 0.01,
    cpuDeltaSeconds: 0.6,
    openFds: 40,
    tmuxSpawns: 30,
    intervalSeconds: 60,
    pingRttMs: { count: 60, p50: 1.2, max: 4 },
    receiptLatencyMs: { count: 4, p50: 900, max: 1_800 },
    observerGapWarnings: 0,
    daemonRestarts: 0,
    receiptFailures: 0,
    unexpectedDisconnects: 0,
    ...overrides,
  };
}

/** `count` samples one minute apart, RSS rising linearly by `mibPerHour`. */
function series(count: number, mibPerHour: number, extra: Partial<SoakSample> = {}): SoakSample[] {
  return Array.from({ length: count }, (_, index) => {
    const elapsedSeconds = index * 60;
    return sample({
      elapsedSeconds,
      rssKiB: Math.round((100 + (mibPerHour * elapsedSeconds) / 3_600) * 1024),
      ...extra,
    });
  });
}

describe("linearFit", () => {
  it("recovers slope and intercept of an exact line with r2 = 1", () => {
    const fit = linearFit([
      { x: 0, y: 1 },
      { x: 1, y: 3 },
      { x: 2, y: 5 },
    ]);
    expect(fit).not.toBeNull();
    expect(fit!.slope).toBeCloseTo(2);
    expect(fit!.intercept).toBeCloseTo(1);
    expect(fit!.r2).toBeCloseTo(1);
    expect(fit!.points).toBe(3);
  });

  it("returns a zero slope and r2 for a flat series", () => {
    const fit = linearFit([
      { x: 0, y: 7 },
      { x: 5, y: 7 },
      { x: 10, y: 7 },
    ]);
    expect(fit!.slope).toBe(0);
    expect(fit!.r2).toBe(0);
  });

  it("is null with fewer than two points or no x spread", () => {
    expect(linearFit([])).toBeNull();
    expect(linearFit([{ x: 1, y: 1 }])).toBeNull();
    expect(
      linearFit([
        { x: 1, y: 1 },
        { x: 1, y: 2 },
      ]),
    ).toBeNull();
  });

  it("fits noisy data close to the true slope", () => {
    const noise = [0.3, -0.2, 0.1, -0.4, 0.2, 0.0, -0.1, 0.1];
    const fit = linearFit(noise.map((n, index) => ({ x: index, y: 5 + 1.5 * index + n })));
    expect(fit!.slope).toBeCloseTo(1.5, 0);
    expect(fit!.r2).toBeGreaterThan(0.95);
  });
});

describe("percentile helpers", () => {
  it("uses nearest-rank percentiles", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5], 0.5)).toBe(5);
    expect(percentile([3, 1, 2, 4], 0.5)).toBe(2);
    expect(percentile([3, 1, 2, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
  });

  it("merges interval records into a count-weighted median and the true max", () => {
    const merged = mergePercentiles([
      { count: 3, p50: 1, max: 2 },
      { count: 1, p50: 100, max: 500 },
      { count: 0, p50: null, max: null },
    ]);
    expect(merged).toEqual({ count: 4, p50: 1, max: 500 });
    expect(mergePercentiles([])).toEqual({ count: 0, p50: null, max: null });
  });
});

describe("growthPerHour", () => {
  it("reports the slope in units per hour and skips missing metrics", () => {
    const samples = [
      ...series(4, 12),
      sample({ elapsedSeconds: 240, rssKiB: null }),
      sample({ elapsedSeconds: 300, rssKiB: Math.round((100 + 1) * 1024) }),
    ];
    const fit = growthPerHour(samples, (s) => (s.rssKiB === null ? null : s.rssKiB / 1024));
    expect(fit!.points).toBe(5);
    expect(fit!.slope).toBeCloseTo(12, 0);
  });
});

describe("summarizeSoak", () => {
  it("aggregates totals, ends, maxima and rates", () => {
    const samples = series(3, 6, { tmuxSpawns: 30, cpuDeltaSeconds: 1.2 });
    const summary = summarizeSoak(samples);
    expect(summary.samples).toBe(3);
    expect(summary.durationSeconds).toBe(120);
    expect(summary.rssStartMiB).toBeCloseTo(100, 1);
    expect(summary.rssEndMiB).toBeCloseTo(100.2, 1);
    expect(summary.rssGrowthMiBPerHour).toBeCloseTo(6, 0);
    expect(summary.tmuxSpawnsTotal).toBe(90);
    expect(summary.tmuxSpawnsPerMinute).toBeCloseTo(30);
    expect(summary.cpuSecondsTotal).toBeCloseTo(3.6);
    expect(summary.cpuPercentMean).toBeCloseTo(2);
    expect(summary.fdStart).toBe(40);
    expect(summary.fdEnd).toBe(40);
    expect(summary.pingRttMs).toEqual({ count: 180, p50: 1.2, max: 4 });
  });

  it("handles an empty run without throwing", () => {
    const summary = summarizeSoak([]);
    expect(summary.samples).toBe(0);
    expect(summary.rssStartMiB).toBeNull();
    expect(summary.tmuxSpawnsPerMinute).toBeNull();
    expect(summary.cpuPercentMean).toBeNull();
    expect(summary.daemonRestarts).toBe(0);
  });
});

describe("evaluateSoak", () => {
  it("passes a flat, healthy run", () => {
    const result = evaluateSoak(series(10, 0));
    expect(result.verdict).toBe("pass");
    expect(result.checks.every((check) => check.ok === true)).toBe(true);
  });

  it("fails on monotonic RSS growth above the hourly bound", () => {
    const result = evaluateSoak(series(10, DEFAULT_SOAK_THRESHOLDS.maxRssGrowthMiBPerHour * 3));
    expect(result.verdict).toBe("fail");
    const rss = result.checks.find((check) => check.id === "rss-growth")!;
    expect(rss.ok).toBe(false);
    expect(rss.observed).toBeGreaterThan(DEFAULT_SOAK_THRESHOLDS.maxRssGrowthMiBPerHour);
  });

  it("tolerates a one-off RSS spike that does not trend", () => {
    const samples = series(20, 0);
    const spiked = samples.map((s, index) =>
      index === 5 ? { ...s, rssKiB: s.rssKiB! + 200 * 1024 } : s,
    );
    const result = evaluateSoak(spiked);
    expect(result.checks.find((check) => check.id === "rss-growth")!.ok).toBe(true);
  });

  it("fails on fd drift and fd growth", () => {
    const samples = series(10, 0).map((s, index) => ({ ...s, openFds: 40 + index * 5 }));
    const result = evaluateSoak(samples);
    expect(result.verdict).toBe("fail");
    expect(result.checks.find((check) => check.id === "fd-drift")!.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "fd-growth")!.ok).toBe(false);
  });

  it("treats a downward fd drift beyond the bound as instability too", () => {
    const samples = series(4, 0).map((s, index) => ({ ...s, openFds: index === 0 ? 100 : 40 }));
    expect(evaluateSoak(samples).checks.find((check) => check.id === "fd-drift")!.ok).toBe(false);
  });

  it("fails on latency, gaps, restarts, waiter failures and disconnects", () => {
    const base = series(5, 0);
    const bad = base.map((s, index) => ({
      ...s,
      pingRttMs: { count: 60, p50: 80, max: 400 },
      receiptLatencyMs: { count: 4, p50: 4_500, max: 9_000 },
      observerGapWarnings: index === 2 ? 1 : 0,
      daemonRestarts: index >= 3 ? 1 : 0,
      receiptFailures: index === 4 ? 2 : 0,
      unexpectedDisconnects: index === 1 ? 1 : 0,
    }));
    const result = evaluateSoak(bad);
    expect(result.verdict).toBe("fail");
    const failed = result.checks.filter((check) => check.ok === false).map((check) => check.id);
    expect(failed).toEqual([
      "ping-rtt-p50",
      "receipt-latency-p50",
      "observer-gaps",
      "daemon-restarts",
      "receipt-failures",
      "unexpected-disconnects",
    ]);
    expect(result.summary.daemonRestarts).toBe(1);
    expect(result.summary.receiptFailures).toBe(2);
  });

  it("is inconclusive with too few samples for a fit or unmeasured metrics", () => {
    const short = evaluateSoak(series(2, 0));
    expect(short.verdict).toBe("inconclusive");
    expect(short.checks.find((check) => check.id === "rss-growth")!.ok).toBeNull();

    const noPings = series(5, 0).map((s) => ({
      ...s,
      pingRttMs: { count: 0, p50: null, max: null },
    }));
    const result = evaluateSoak(noPings);
    expect(result.verdict).toBe("inconclusive");
    expect(result.checks.find((check) => check.id === "ping-rtt-p50")!.ok).toBeNull();
  });

  it("lets a failure outrank an unmeasured check", () => {
    const samples = series(2, 0).map((s) => ({ ...s, daemonRestarts: 1 }));
    expect(evaluateSoak(samples).verdict).toBe("fail");
  });

  it("honours custom thresholds", () => {
    const result = evaluateSoak(series(10, 4), {
      ...DEFAULT_SOAK_THRESHOLDS,
      maxRssGrowthMiBPerHour: 2,
    });
    expect(result.checks.find((check) => check.id === "rss-growth")!.ok).toBe(false);
  });

  it("renders a report with every check and the verdict", () => {
    const text = formatSoakReport(evaluateSoak(series(5, 0)));
    expect(text).toContain("rss MiB");
    expect(text).toContain("ok   rss-growth");
    expect(text).toContain("verdict: PASS");
  });
});

describe("parsePsTime", () => {
  it("parses macOS mm:ss.cc, Linux hh:mm:ss and dd-hh:mm:ss", () => {
    expect(parsePsTime("0:01.23")).toBeCloseTo(1.23);
    expect(parsePsTime("12:34.56")).toBeCloseTo(754.56);
    expect(parsePsTime("01:02:03")).toBe(3_723);
    expect(parsePsTime("1-01:02:03")).toBe(90_123);
    expect(parsePsTime("  0:00.00\n")).toBe(0);
  });

  it("rejects garbage", () => {
    expect(parsePsTime("")).toBeNull();
    expect(parsePsTime("abc")).toBeNull();
    expect(parsePsTime("1:2:3:4")).toBeNull();
  });
});

describe("parseDurationMs", () => {
  it("accepts unit suffixes and bare milliseconds", () => {
    expect(parseDurationMs("30m")).toBe(1_800_000);
    expect(parseDurationMs("24h")).toBe(86_400_000);
    expect(parseDurationMs("90s")).toBe(90_000);
    expect(parseDurationMs("1500ms")).toBe(1_500);
    expect(parseDurationMs("2500")).toBe(2_500);
    expect(parseDurationMs("1.5h")).toBe(5_400_000);
    expect(parseDurationMs(42)).toBe(42);
  });

  it("rejects malformed durations", () => {
    expect(() => parseDurationMs("soon")).toThrow(/Invalid duration/u);
    expect(() => parseDurationMs("5 weeks")).toThrow();
  });
});

describe("countSpawnsByCommand", () => {
  it("skips socket and option prefixes and attributes the command word", () => {
    const records = [
      ["-S", "/tmp/x.sock", "show-hooks", "-g"].join(""),
      ["-S", "/tmp/x.sock", "-u", "list-panes", "-a"].join(""),
      ["-L", "name", "-f", "/dev/null", "list-panes"].join(""),
      ["-C", "-S", "/tmp/x.sock", "wait-for", "x"].join(""),
      "",
      "-S/tmp/x.sock",
    ];
    expect(countSpawnsByCommand(records)).toEqual({
      "show-hooks": 1,
      "list-panes": 2,
      "wait-for": 1,
      "(none)": 1,
    });
  });
});
