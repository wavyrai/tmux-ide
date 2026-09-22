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
  percentiles,
  soakTrends,
  validSoakAck,
  correlatedPongRtt,
  type SoakEvidence,
  summarizeSoak,
  type SoakSample,
} from "./soak-verdict.ts";

import { RESOURCE_KEYS, type DiagnosticsSample } from "./soak-diagnostics.ts";

function sample(overrides: Partial<SoakSample> & { elapsedSeconds: number }): SoakSample {
  return {
    diagnostics: {
      status: "ok",
      sample: {
        daemon: {
          protocolVersion: 1,
          productVersion: "test",
          instanceId: "test",
          startedAt: "2026-09-22T00:00:00Z",
        },
        pid: 1,
        uptimeMs: overrides.elapsedSeconds * 1000,
        sampledAtMs: 1000,
        memory: { rss: 100, heapTotal: 80, heapUsed: 50, external: 10, arrayBuffers: 5 },
        cpu: { user: 100, system: 20 },
        eventLoop: { idle: 900, active: 100, utilization: 0.1 },
        activeResources: Object.fromEntries(
          RESOURCE_KEYS.map((k) => [k, 1]),
        ) as DiagnosticsSample["activeResources"],
      },
    },
    diagnosticDelta:
      overrides.elapsedSeconds === 0
        ? { status: "missing-baseline" }
        : {
            status: "ok",
            intervalMs: 60000,
            cpuUserMicros: 100,
            cpuSystemMicros: 20,
            cpuPercent: 1,
            eventLoopIdleMs: 900,
            eventLoopActiveMs: 100,
            eventLoopUtilization: 0.1,
          },
    at: 1_700_000_000_000 + overrides.elapsedSeconds * 1_000,
    rssKiB: 100 * 1024,
    cpuSeconds: overrides.elapsedSeconds * 0.01,
    cpuDeltaSeconds: 0.6,
    openFds: 40,
    tmuxSpawns: 30,
    intervalSeconds: 60,
    pingRttMs: percentiles([...Array(59).fill(1.2), 4]),
    receiptLatencyMs: percentiles([900, 900, 900, 1800]),
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

  it("merges distributions instead of interval medians, with a bounded upper p50", () => {
    const merged = mergePercentiles([percentiles([1, 1, 100]), percentiles([2, 2, 2, 2])]);
    expect(merged.count).toBe(7);
    expect(merged.p50).toBeGreaterThanOrEqual(2);
    expect(merged.p50).toBeLessThanOrEqual(2.1);
    expect(merged.max).toBe(100);
    expect(mergePercentiles([{ count: 3, p50: 1, max: 100 }]).p50).toBeNull();
    expect(mergePercentiles([]).p50).toBeNull();
  });
  it("bounds histogram storage and uses actual max for overflow", () => {
    const result = percentiles(Array.from({ length: 10000 }, (_, i) => 1.1 ** i));
    expect(Object.keys(result.buckets!).length).toBeLessThanOrEqual(228);
    expect(percentiles([1000000]).p50).toBe(1000000);
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
    expect(summary.pingRttMs).toMatchObject({ count: 180, max: 4 });
    expect(summary.pingRttMs.p50).toBeGreaterThanOrEqual(1.2);
    expect(summary.pingRttMs.p50).toBeLessThanOrEqual(1.26);
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
    const result = evaluateSoak(series(10, 0), DEFAULT_SOAK_THRESHOLDS, evidence());
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
      pingRttMs: percentiles([...Array(59).fill(80), 400]),
      receiptLatencyMs: percentiles([4500, 4500, 4500, 9000]),
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
    expect(text).toContain("verdict: INCONCLUSIVE");
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
      ["-S", "/tmp/x.sock", "show-hooks", "-g"].join("\u0001"),
      ["-S", "/tmp/x.sock", "-u", "list-panes", "-a"].join("\u0001"),
      ["-L", "name", "-f", "/dev/null", "list-panes"].join("\u0001"),
      ["-C", "-S", "/tmp/x.sock", "wait-for", "x"].join("\u0001"),
      "",
      "-S\u0001/tmp/x.sock",
    ];
    expect(countSpawnsByCommand(records)).toEqual({
      "show-hooks": 1,
      "list-panes": 2,
      "wait-for": 1,
      "(none)": 1,
    });
  });
});

function evidence(overrides: Partial<SoakEvidence> = {}): SoakEvidence {
  return {
    requestedSeconds: 540,
    observedSeconds: 540,
    completed: true,
    failures: {
      health: 0,
      flip: 0,
      promotion: 0,
      send: 0,
      receipt: 0,
      daemonMissing: 0,
      daemonExit: 0,
      ack: 0,
      pingDeadline: 0,
      loop: 0,
      sample: 0,
    },
    loadCompleted: true,
    telemetryComplete: true,
    logCoverageComplete: true,
    reconnectAttempts: 2,
    reconnectAcknowledged: 2,
    shutdownClean: true,
    recordRetired: true,
    cleanupComplete: true,
    resourceTrendPolicyComplete: true,
    warmupSeconds: 120,
    trailingSeconds: 180,
    ...overrides,
  };
}

describe("qualification evidence", () => {
  const healthy = () => series(10, 0);
  it.each([
    { resourceTrendPolicyComplete: false },
    { completed: false },
    { observedSeconds: 120 },
    { telemetryComplete: false },
    { logCoverageComplete: false },
    { loadCompleted: false },
    { reconnectAttempts: 1, reconnectAcknowledged: 1 },
    { reconnectAcknowledged: 1 },
    { warmupSeconds: 1000 },
    { failures: {} },
  ])("cannot pass incomplete evidence %j", (partial) => {
    expect(evaluateSoak(healthy(), DEFAULT_SOAK_THRESHOLDS, evidence(partial)).verdict).toBe(
      "inconclusive",
    );
  });
  it("cannot pass absent run evidence or missing individual resource samples", () => {
    expect(evaluateSoak(healthy()).verdict).toBe("inconclusive");
    const samples = healthy();
    samples[4] = { ...samples[4]!, rssKiB: null };
    expect(evaluateSoak(samples, DEFAULT_SOAK_THRESHOLDS, evidence()).verdict).toBe("inconclusive");
  });
  it.each([
    "health",
    "flip",
    "promotion",
    "send",
    "receipt",
    "daemonMissing",
    "daemonExit",
    "ack",
    "pingDeadline",
    "loop",
    "sample",
  ])("fails explicit %s even when interrupted", (key) => {
    const run = evidence({ completed: false });
    expect(
      evaluateSoak(healthy(), DEFAULT_SOAK_THRESHOLDS, {
        ...run,
        failures: { ...run.failures, [key]: 1 },
      }).verdict,
    ).toBe("fail");
  });
  it.each(["shutdownClean", "recordRetired", "cleanupComplete"])("fails bad teardown %s", (key) => {
    expect(
      evaluateSoak(healthy(), DEFAULT_SOAK_THRESHOLDS, evidence({ [key]: false })).verdict,
    ).toBe("fail");
  });
  it("reports declared windows and catches a rise masked by startup decline", () => {
    const samples = series(20, 0).map((sample, index) => ({
      ...sample,
      rssKiB: 1024 * (index < 5 ? 1000 - index * 180 : 100 + index * 2),
    }));
    const windows = soakTrends(samples, 300, 300);
    expect(windows.whole.rssMiBPerHour!.slope).toBeLessThan(0);
    expect(windows.trailing.rssMiBPerHour!.points).toBe(6);
    expect(
      evaluateSoak(
        samples,
        DEFAULT_SOAK_THRESHOLDS,
        evidence({ warmupSeconds: 300, trailingSeconds: 300 }),
      ).checks.find((c) => c.id === "rss-trailing")!.ok,
    ).toBe(false);
  });
});

describe("wire evidence validation", () => {
  it("bounds histogram quantiles by the observed maximum and excludes invalid observations", () => {
    const result = percentiles([0.5, NaN, Infinity, -1]);
    expect(result).toMatchObject({ count: 1, p50: 0.5, max: 0.5 });
    expect(percentiles([975, 975, 975]).p50).toBe(975);
    expect(percentiles([NaN, Infinity, -1])).toMatchObject({ count: 0, p50: null, max: null });
  });
  it("requires matching acknowledgement revision and no unavailable interests", () => {
    const ack = { type: "resource.interests-ack", interestRevision: 2, unavailableInterests: [] };
    expect(validSoakAck(ack, 2)).toBe(true);
    expect(validSoakAck(ack, 3)).toBe(false);
    expect(validSoakAck({ ...ack, unavailableInterests: [{ resource: "fleet-catalog" }] }, 2)).toBe(
      false,
    );
    expect(validSoakAck({ type: "resource.interests-ack", interestRevision: 2 }, 2)).toBe(false);
    expect(validSoakAck(null, 2)).toBe(false);
  });
  it("ignores unsolicited and stale pong payloads without completing the probe", () => {
    const probe = { id: "new-unique-probe", at: 100 };
    expect(correlatedPongRtt(probe, "old-probe", 120)).toBeNull();
    expect(correlatedPongRtt(probe, "", 125)).toBeNull();
    expect(correlatedPongRtt(probe, probe.id, 130)).toBe(30);
    expect(correlatedPongRtt(probe, probe.id, 99)).toBeNull();
  });
});

it("does not turn a short startup transient into an hourly-growth failure", () => {
  const samples = series(5, 3000).map((sample, index) => ({
    ...sample,
    elapsedSeconds: 5 * (index + 1),
  }));
  const result = evaluateSoak(
    samples,
    DEFAULT_SOAK_THRESHOLDS,
    evidence({ requestedSeconds: 25, observedSeconds: 25, warmupSeconds: 300 }),
  );
  expect(result.verdict).toBe("inconclusive");
  expect(result.checks.find((check) => check.id === "rss-growth")!.ok).toBeNull();
  expect(
    evaluateSoak(
      samples,
      DEFAULT_SOAK_THRESHOLDS,
      evidence({
        requestedSeconds: 25,
        observedSeconds: 25,
        warmupSeconds: 300,
        failures: { ...evidence().failures, health: 1 },
      }),
    ).verdict,
  ).toBe("fail");
});

describe("diagnostic evidence", () => {
  const healthy = () => series(10, 0);
  it.each([
    "missing",
    "malformed",
    "unsupported-endpoint",
    "transport-error",
    "http-error",
  ] as const)("keeps %s inconclusive even with a hypothetical complete policy", (status) => {
    const samples = healthy();
    samples[2] = { ...samples[2]!, diagnostics: { status, sample: null }, diagnosticDelta: null };
    expect(evaluateSoak(samples, DEFAULT_SOAK_THRESHOLDS, evidence()).verdict).toBe("inconclusive");
  });
  it("fails a mismatched original identity independently of policy", () => {
    const samples = healthy();
    samples[2] = { ...samples[2]!, diagnostics: { status: "identity-mismatch", sample: null } };
    expect(
      evaluateSoak(
        samples,
        DEFAULT_SOAK_THRESHOLDS,
        evidence({ resourceTrendPolicyComplete: false }),
      ).verdict,
    ).toBe("fail");
  });
  it("reports resource/heap trends descriptively and leaves unsupported resources unmeasured", () => {
    const samples = healthy();
    const trends = soakTrends(samples, 0, 300);
    expect(trends.whole.memoryMiBPerHour.heapUsed?.slope).toBe(0);
    expect(trends.whole.activeResourcesPerHour.Timeout?.slope).toBe(0);
    expect(summarizeSoak(samples).diagnostics.memoryBytes.heapUsed).toEqual({
      start: 50,
      end: 50,
      max: 50,
      measuredSamples: samples.length,
    });
    for (const s of samples) if (s.diagnostics?.sample) s.diagnostics.sample.activeResources = null;
    expect(soakTrends(samples, 0, 300).whole.activeResourcesPerHour.Timeout).toBeNull();
    expect(summarizeSoak(samples).diagnostics.activeResources.Timeout.start).toBeNull();
    expect(evaluateSoak(samples, DEFAULT_SOAK_THRESHOLDS, evidence()).verdict).toBe("inconclusive");
  });
});
