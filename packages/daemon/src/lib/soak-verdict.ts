import {
  MEMORY_KEYS,
  RESOURCE_KEYS,
  type DiagnosticsResult,
  type DiagnosticsDelta,
} from "./soak-diagnostics.ts";

/**
 * Pure analysis for the daemon soak harness (`packages/daemon/scripts/soak-daemon.mjs`).
 *
 * The harness records one JSONL sample per interval; this module turns the
 * sample series into a summary and a verdict against explicit thresholds. It
 * has no io and no dependencies so the harness can import it directly and the
 * numbers it prints are the numbers the colocated tests pin down.
 */

export interface SoakSample {
  readonly diagnostics?: DiagnosticsResult;
  readonly diagnosticDelta?: DiagnosticsDelta | null;
  /** Milliseconds since the epoch when the sample was taken. */
  readonly at: number;
  /** Seconds since the soak started (the linear-fit abscissa). */
  readonly elapsedSeconds: number;
  /** Daemon resident set size in KiB (`ps -o rss`). */
  readonly rssKiB: number | null;
  /** Daemon cumulative CPU seconds (`ps -o time`) at sample time. */
  readonly cpuSeconds: number | null;
  /** CPU seconds consumed during the interval that ended with this sample. */
  readonly cpuDeltaSeconds: number | null;
  /** Open file descriptors / handles of the daemon process. */
  readonly openFds: number | null;
  /** tmux children the daemon spawned during the interval. */
  readonly tmuxSpawns: number;
  /** Interval length in seconds (spawn-rate denominator). */
  readonly intervalSeconds: number;
  readonly pingRttMs: Percentiles;
  readonly receiptLatencyMs: Percentiles;
  /** Interaction-observer gap warnings logged during the interval. */
  readonly observerGapWarnings: number;
  /** Daemon pid/instance changes observed so far (cumulative). */
  readonly daemonRestarts: number;
  /** Receipt waiters that failed or timed out during the interval. */
  readonly receiptFailures: number;
  /** Events-client disconnects that were not scheduled reconnects (interval). */
  readonly unexpectedDisconnects: number;
}

export interface Percentiles {
  readonly count: number;
  readonly p50: number | null;
  readonly max: number | null;
  /** Logarithmic bucket index → count; p50 is an upper bound; ≤5% or 1ms error below overflow (which uses max). */
  readonly buckets?: Readonly<Record<string, number>>;
}

export interface SoakThresholds {
  /** Fitted RSS slope bound, MiB per hour. */
  readonly maxRssGrowthMiBPerHour: number;
  /** |last fd count − first fd count| bound. */
  readonly maxFdDrift: number;
  /** Fitted fd slope bound, descriptors per hour. */
  readonly maxFdGrowthPerHour: number;
  readonly maxPingRttP50Ms: number;
  readonly maxReceiptLatencyP50Ms: number;
  readonly maxObserverGapWarnings: number;
  readonly maxDaemonRestarts: number;
  readonly maxReceiptFailures: number;
  readonly maxUnexpectedDisconnects: number;
  /** Fewer samples than this cannot support a growth verdict. */
  readonly minSamplesForFit: number;
}

export const DEFAULT_SOAK_THRESHOLDS: SoakThresholds = {
  maxRssGrowthMiBPerHour: 8,
  maxFdDrift: 16,
  maxFdGrowthPerHour: 32,
  maxPingRttP50Ms: 50,
  maxReceiptLatencyP50Ms: 3_000,
  maxObserverGapWarnings: 0,
  maxDaemonRestarts: 0,
  maxReceiptFailures: 0,
  maxUnexpectedDisconnects: 0,
  minSamplesForFit: 3,
};

export interface LinearFit {
  readonly slope: number;
  readonly intercept: number;
  /** Coefficient of determination; 0 when y is constant. */
  readonly r2: number;
  readonly points: number;
}

/** Ordinary least squares over `(x, y)` pairs; `null` with fewer than two distinct x. */
export function linearFit(points: readonly { x: number; y: number }[]): LinearFit | null {
  const n = points.length;
  if (n < 2) return null;
  let sumX = 0;
  let sumY = 0;
  for (const { x, y } of points) {
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const { x, y } of points) {
    const dx = x - meanX;
    const dy = y - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2, points: n };
}

/** Nearest-rank percentile of a numeric series; `null` for an empty series. */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank]!;
}

/** At most 228 buckets for probes capped at 60 seconds, plus an overflow bucket. */
export function percentiles(values: readonly number[]): Percentiles {
  const buckets: Record<string, number> = {};
  let max: number | null = null;
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) continue;
    max = Math.max(max ?? 0, value);
    const index = value <= 1 ? 0 : Math.min(227, Math.ceil(Math.log(value) / Math.log(1.05)));
    buckets[index] = (buckets[index] ?? 0) + 1;
  }
  return mergePercentiles([
    {
      count: Object.values(buckets).reduce((a, b) => a + b, 0),
      p50: null,
      max,
      buckets,
    },
  ]);
}

/**
 * Fit a per-sample metric against elapsed time and report the slope per hour.
 * Samples without the metric are skipped.
 */
export function growthPerHour(
  samples: readonly SoakSample[],
  pick: (sample: SoakSample) => number | null,
): LinearFit | null {
  const points: { x: number; y: number }[] = [];
  for (const sample of samples) {
    const value = pick(sample);
    if (value === null || !Number.isFinite(value)) continue;
    points.push({ x: sample.elapsedSeconds / 3_600, y: value });
  }
  return linearFit(points);
}

export interface SoakCheck {
  readonly id: string;
  readonly ok: boolean | null;
  readonly observed: number | null;
  readonly bound: number;
  readonly detail: string;
}

export interface SoakSummary {
  readonly diagnostics: ReturnType<typeof summarizeDiagnostics>;
  readonly samples: number;
  readonly durationSeconds: number;
  readonly rssStartMiB: number | null;
  readonly rssEndMiB: number | null;
  readonly rssMaxMiB: number | null;
  readonly rssGrowthMiBPerHour: number | null;
  readonly rssFitR2: number | null;
  readonly fdStart: number | null;
  readonly fdEnd: number | null;
  readonly fdMax: number | null;
  readonly fdGrowthPerHour: number | null;
  readonly cpuSecondsTotal: number | null;
  readonly cpuPercentMean: number | null;
  readonly tmuxSpawnsTotal: number;
  readonly tmuxSpawnsPerMinute: number | null;
  readonly pingRttMs: Percentiles;
  readonly receiptLatencyMs: Percentiles;
  readonly observerGapWarnings: number;
  readonly daemonRestarts: number;
  readonly receiptFailures: number;
  readonly unexpectedDisconnects: number;
}

export interface SoakVerdict {
  readonly verdict: "pass" | "fail" | "inconclusive";
  readonly summary: SoakSummary;
  readonly checks: readonly SoakCheck[];
}

const KIB_PER_MIB = 1024;

function firstValue(
  samples: readonly SoakSample[],
  pick: (sample: SoakSample) => number | null,
): number | null {
  for (const sample of samples) {
    const value = pick(sample);
    if (value !== null) return value;
  }
  return null;
}

function lastValue(
  samples: readonly SoakSample[],
  pick: (sample: SoakSample) => number | null,
): number | null {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const value = pick(samples[index]!);
    if (value !== null) return value;
  }
  return null;
}

function maxValue(
  samples: readonly SoakSample[],
  pick: (sample: SoakSample) => number | null,
): number | null {
  let max: number | null = null;
  for (const sample of samples) {
    const value = pick(sample);
    if (value === null) continue;
    if (max === null || value > max) max = value;
  }
  return max;
}

/** Merge bounded histograms, never a median of medians. Legacy p50 is unmeasured. */
export function mergePercentiles(records: readonly Percentiles[]): Percentiles {
  const buckets: Record<string, number> = {};
  let count = 0;
  let max: number | null = null;
  let missing = false;
  for (const record of records) {
    count += record.count;
    if (record.count && !record.buckets) missing = true;
    if (record.max !== null) max = Math.max(max ?? 0, record.max);
    for (const [key, value] of Object.entries(record.buckets ?? {}))
      buckets[key] = (buckets[key] ?? 0) + value;
  }
  let cumulative = 0;
  let p50: number | null = null;
  if (!missing && count) {
    for (const key of Object.keys(buckets)
      .map(Number)
      .sort((a, b) => a - b)) {
      cumulative += buckets[key]!;
      if (cumulative >= Math.ceil(count / 2)) {
        p50 = key === 227 ? max : Math.min(max ?? Infinity, 1.05 ** key);
        break;
      }
    }
  }
  return { count, p50, max, buckets };
}

/** Run-level evidence must be supplied explicitly; absent evidence cannot qualify. */
export interface SoakEvidence {
  readonly requestedSeconds: number;
  readonly observedSeconds: number;
  readonly completed: boolean;
  readonly failures: Readonly<Record<string, number>>;
  readonly loadCompleted: boolean;
  readonly telemetryComplete: boolean;
  readonly logCoverageComplete: boolean;
  readonly reconnectAttempts: number;
  readonly reconnectAcknowledged: number;
  readonly shutdownClean: boolean;
  readonly recordRetired: boolean;
  readonly cleanupComplete: boolean;
  readonly resourceTrendPolicyComplete: boolean;
  readonly warmupSeconds: number;
  readonly trailingSeconds: number;
}

export function soakTrends(
  samples: readonly SoakSample[],
  warmupSeconds: number,
  trailingSeconds: number,
) {
  const end = samples.at(-1)?.elapsedSeconds ?? 0;
  const fit = (window: readonly SoakSample[]) => ({
    memoryMiBPerHour: Object.fromEntries(
      MEMORY_KEYS.map((key) => [
        key,
        growthPerHour(window, (s) => {
          const value = s.diagnostics?.sample?.memory[key];
          return value === undefined ? null : value / 1024 ** 2;
        }),
      ]),
    ),
    activeResourcesPerHour: Object.fromEntries(
      RESOURCE_KEYS.map((key) => [
        key,
        growthPerHour(window, (s) => s.diagnostics?.sample?.activeResources?.[key] ?? null),
      ]),
    ),
    diagnosticCpuPercentPerHour: growthPerHour(window, (s) =>
      s.diagnosticDelta?.status === "ok" ? s.diagnosticDelta.cpuPercent : null,
    ),
    eventLoopUtilizationPerHour: growthPerHour(window, (s) =>
      s.diagnosticDelta?.status === "ok" ? s.diagnosticDelta.eventLoopUtilization : null,
    ),
    rssMiBPerHour: growthPerHour(window, (s) => (s.rssKiB === null ? null : s.rssKiB / 1024)),
    cpuPercentPerHour: growthPerHour(window, (s) =>
      s.cpuDeltaSeconds === null || s.intervalSeconds <= 0
        ? null
        : (100 * s.cpuDeltaSeconds) / s.intervalSeconds,
    ),
    spawnsPerMinutePerHour: growthPerHour(window, (s) =>
      s.intervalSeconds <= 0 ? null : (60 * s.tmuxSpawns) / s.intervalSeconds,
    ),
  });
  return {
    whole: fit(samples),
    afterWarmup: fit(samples.filter((s) => s.elapsedSeconds >= warmupSeconds)),
    trailing: fit(
      samples.filter((s) => s.elapsedSeconds >= Math.max(warmupSeconds, end - trailingSeconds)),
    ),
  };
}

/** Descriptive only: heap changes can reflect GC and do not prove retention. */
export function summarizeDiagnostics(samples: readonly SoakSample[]) {
  const describe = (pick: (s: SoakSample) => number | null) => ({
    start: firstValue(samples, pick),
    end: lastValue(samples, pick),
    max: maxValue(samples, pick),
    measuredSamples: samples.filter((s) => pick(s) !== null).length,
  });
  return {
    validSamples: samples.filter((s) => s.diagnostics?.status === "ok").length,
    unsupportedResourceSamples: samples.filter(
      (s) => s.diagnostics?.status === "ok" && s.diagnostics.sample.activeResources === null,
    ).length,
    memoryBytes: Object.fromEntries(
      MEMORY_KEYS.map((key) => [key, describe((s) => s.diagnostics?.sample?.memory[key] ?? null)]),
    ),
    activeResources: Object.fromEntries(
      RESOURCE_KEYS.map((key) => [
        key,
        describe((s) => s.diagnostics?.sample?.activeResources?.[key] ?? null),
      ]),
    ),
    cpuPercent: describe((s) =>
      s.diagnosticDelta?.status === "ok" ? s.diagnosticDelta.cpuPercent : null,
    ),
    eventLoopUtilization: describe((s) =>
      s.diagnosticDelta?.status === "ok" ? s.diagnosticDelta.eventLoopUtilization : null,
    ),
  };
}

export function summarizeSoak(samples: readonly SoakSample[]): SoakSummary {
  const rss = (sample: SoakSample): number | null =>
    sample.rssKiB === null ? null : sample.rssKiB / KIB_PER_MIB;
  const fds = (sample: SoakSample): number | null => sample.openFds;
  const rssFit = growthPerHour(samples, rss);
  const fdFit = growthPerHour(samples, fds);
  const durationSeconds =
    samples.length === 0
      ? 0
      : samples[samples.length - 1]!.elapsedSeconds - samples[0]!.elapsedSeconds;
  let cpuTotal: number | null = null;
  let intervalTotal = 0;
  let spawnsTotal = 0;
  let gaps = 0;
  let receiptFailures = 0;
  let disconnects = 0;
  for (const sample of samples) {
    if (sample.cpuDeltaSeconds !== null) cpuTotal = (cpuTotal ?? 0) + sample.cpuDeltaSeconds;
    intervalTotal += sample.intervalSeconds;
    spawnsTotal += sample.tmuxSpawns;
    gaps += sample.observerGapWarnings;
    receiptFailures += sample.receiptFailures;
    disconnects += sample.unexpectedDisconnects;
  }
  return {
    diagnostics: summarizeDiagnostics(samples),
    samples: samples.length,
    durationSeconds,
    rssStartMiB: firstValue(samples, rss),
    rssEndMiB: lastValue(samples, rss),
    rssMaxMiB: maxValue(samples, rss),
    rssGrowthMiBPerHour: rssFit?.slope ?? null,
    rssFitR2: rssFit?.r2 ?? null,
    fdStart: firstValue(samples, fds),
    fdEnd: lastValue(samples, fds),
    fdMax: maxValue(samples, fds),
    fdGrowthPerHour: fdFit?.slope ?? null,
    cpuSecondsTotal: cpuTotal,
    cpuPercentMean:
      cpuTotal === null || intervalTotal === 0 ? null : (cpuTotal / intervalTotal) * 100,
    tmuxSpawnsTotal: spawnsTotal,
    tmuxSpawnsPerMinute: intervalTotal === 0 ? null : spawnsTotal / (intervalTotal / 60),
    pingRttMs: mergePercentiles(samples.map((sample) => sample.pingRttMs)),
    receiptLatencyMs: mergePercentiles(samples.map((sample) => sample.receiptLatencyMs)),
    observerGapWarnings: gaps,
    daemonRestarts: lastValue(samples, (sample) => sample.daemonRestarts) ?? 0,
    receiptFailures,
    unexpectedDisconnects: disconnects,
  };
}

function boundCheck(
  id: string,
  observed: number | null,
  bound: number,
  detail: string,
  options: { absolute?: boolean } = {},
): SoakCheck {
  if (observed === null)
    return { id, ok: null, observed, bound, detail: `${detail}: not measured` };
  const value = options.absolute ? Math.abs(observed) : observed;
  return { id, ok: value <= bound, observed, bound, detail };
}

/**
 * Evaluate a sample series. A check is `ok: null` when the run could not
 * measure it (too few samples for a fit, a metric never collected); the
 * overall verdict is then `inconclusive` unless some other check failed.
 */
export function evaluateSoak(
  samples: readonly SoakSample[],
  thresholds: SoakThresholds = DEFAULT_SOAK_THRESHOLDS,
  evidence?: SoakEvidence,
): SoakVerdict {
  const summary = summarizeSoak(samples);
  const enoughForFit =
    samples.length >= thresholds.minSamplesForFit &&
    (!evidence ||
      samples.filter((sample) => sample.elapsedSeconds >= evidence.warmupSeconds).length >=
        thresholds.minSamplesForFit);
  const checks: SoakCheck[] = [
    enoughForFit
      ? boundCheck(
          "rss-growth",
          summary.rssGrowthMiBPerHour,
          thresholds.maxRssGrowthMiBPerHour,
          `fitted RSS slope MiB/h over ${samples.length} samples (r2 ${summary.rssFitR2?.toFixed(2) ?? "n/a"})`,
        )
      : {
          id: "rss-growth",
          ok: null,
          observed: summary.rssGrowthMiBPerHour,
          bound: thresholds.maxRssGrowthMiBPerHour,
          detail: `needs ${thresholds.minSamplesForFit} samples and, when declared, post-warmup coverage; have ${samples.length} total`,
        },
    boundCheck(
      "fd-drift",
      summary.fdStart === null || summary.fdEnd === null ? null : summary.fdEnd - summary.fdStart,
      thresholds.maxFdDrift,
      "open fd count end minus start",
      { absolute: true },
    ),
    enoughForFit
      ? boundCheck(
          "fd-growth",
          summary.fdGrowthPerHour,
          thresholds.maxFdGrowthPerHour,
          "fitted fd slope per hour",
        )
      : {
          id: "fd-growth",
          ok: null,
          observed: summary.fdGrowthPerHour,
          bound: thresholds.maxFdGrowthPerHour,
          detail: `needs ${thresholds.minSamplesForFit} samples and, when declared, post-warmup coverage; have ${samples.length} total`,
        },
    boundCheck(
      "ping-rtt-p50",
      summary.pingRttMs.p50,
      thresholds.maxPingRttP50Ms,
      "WebSocket transport control RTT p50 upper bound ms (not semantic handler latency)",
    ),
    boundCheck(
      "receipt-latency-p50",
      summary.receiptLatencyMs.p50,
      thresholds.maxReceiptLatencyP50Ms,
      "wait agent-status receipt latency p50 upper bound ms after the flip",
    ),
    boundCheck(
      "observer-gaps",
      summary.observerGapWarnings,
      thresholds.maxObserverGapWarnings,
      "interaction observer gap warnings",
    ),
    boundCheck(
      "daemon-restarts",
      summary.daemonRestarts,
      thresholds.maxDaemonRestarts,
      "daemon pid or instance changes",
    ),
    boundCheck(
      "receipt-failures",
      summary.receiptFailures,
      thresholds.maxReceiptFailures,
      "receipt waiters that failed or timed out",
    ),
    boundCheck(
      "unexpected-disconnects",
      summary.unexpectedDisconnects,
      thresholds.maxUnexpectedDisconnects,
      "events-client drops outside scheduled reconnects",
    ),
  ];
  const coverage = (id: string, complete: boolean | undefined, detail: string) =>
    checks.push({
      id,
      ok: complete === true ? true : null,
      observed: complete === true ? 1 : null,
      bound: 1,
      detail,
    });
  coverage(
    "duration-complete",
    evidence?.completed && evidence.observedSeconds >= evidence.requestedSeconds,
    "requested duration reached without interruption",
  );
  coverage(
    "telemetry-complete",
    evidence?.telemetryComplete &&
      samples.every((s) =>
        [s.rssKiB, s.cpuSeconds, s.openFds].every(
          (value) => value !== null && Number.isFinite(value),
        ),
      ),
    "all required samples and metrics present",
  );
  coverage(
    "diagnostics-coverage",
    samples.length > 0 &&
      samples.every(
        (s) => s.diagnostics?.status === "ok" && s.diagnostics.sample.activeResources !== null,
      ),
    "owner diagnostics and supported resource counts required at every sample; missing/malformed/404 remain inconclusive",
  );
  coverage(
    "diagnostics-deltas",
    samples.length > 1 &&
      samples.every((s, i) =>
        i === 0
          ? s.diagnosticDelta?.status === "missing-baseline"
          : s.diagnosticDelta?.status === "ok" && s.diagnosticDelta.eventLoopUtilization !== null,
      ),
    "adjacent monotonic cumulative counters required after first baseline",
  );
  checks.push(
    boundCheck(
      "diagnostics-identity",
      samples.filter(
        (s) =>
          s.diagnostics?.status === "identity-mismatch" ||
          s.diagnosticDelta?.status === "identity-mismatch",
      ).length,
      0,
      "diagnostics must match original daemon identity and PID",
    ),
  );
  coverage(
    "load-complete",
    evidence?.loadCompleted,
    "each declared workload completed at least once",
  );
  coverage(
    "log-coverage",
    evidence?.logCoverageComplete,
    "continuous log stream, bookmark, no gap or replay ambiguity",
  );
  coverage("run-evidence", evidence !== undefined, "explicit run and teardown evidence supplied");
  coverage(
    "resource-trend-policy",
    evidence?.resourceTrendPolicyComplete,
    "heap/resources and CPU/spawn trend acceptance policy awaiting calibration and review",
  );
  if (evidence) {
    const requiredFailures = [
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
    ];
    for (const name of new Set([...requiredFailures, ...Object.keys(evidence.failures)])) {
      const count = evidence.failures[name];
      checks.push(
        boundCheck(
          name,
          typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : null,
          0,
          "explicit run failure count",
        ),
      );
    }
    coverage(
      "reconnect-coverage",
      evidence.reconnectAttempts > 1 &&
        evidence.reconnectAttempts === evidence.reconnectAcknowledged,
      "initial subscription and at least one reconnect acknowledged",
    );
    for (const [id, ok] of [
      ["shutdown-clean", evidence.shutdownClean],
      ["record-retired", evidence.recordRetired],
      ["cleanup-complete", evidence.cleanupComplete],
    ] as const)
      checks.push({ id, ok, observed: ok ? 0 : 1, bound: 0, detail: "observed teardown outcome" });
    const trends = soakTrends(samples, evidence.warmupSeconds, evidence.trailingSeconds);
    for (const [window, metrics] of Object.entries(trends)) {
      if (window === "whole") continue;
      const fit = metrics.rssMiBPerHour;
      checks.push(
        boundCheck(
          `rss-${window}`,
          fit && fit.points >= thresholds.minSamplesForFit ? fit.slope : null,
          thresholds.maxRssGrowthMiBPerHour,
          "predeclared window RSS slope MiB/h",
        ),
      );
    }
  }
  const failed = checks.some((check) => check.ok === false);
  const unmeasured = checks.some((check) => check.ok === null);
  return {
    verdict: failed ? "fail" : unmeasured ? "inconclusive" : "pass",
    summary,
    checks,
  };
}

/** Parse `ps -o time` output (`mm:ss.cc`, `hh:mm:ss`, `dd-hh:mm:ss`) into seconds. */
export function parsePsTime(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  let days = 0;
  let rest = text;
  const dayMatch = /^(\d+)-(.+)$/u.exec(rest);
  if (dayMatch) {
    days = Number(dayMatch[1]);
    rest = dayMatch[2]!;
  }
  const parts = rest.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/u.test(part)))
    return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + Number(part);
  return days * 86_400 + seconds;
}

/** Parse a duration flag: `30m`, `24h`, `90s`, `1500ms`, or a bare millisecond count. */
export function parseDurationMs(raw: string | number): number {
  if (typeof raw === "number") return raw;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/u.exec(raw);
  if (!match) throw new Error(`Invalid duration: ${raw}`);
  const value = Number(match[1]);
  const unit = match[2] ?? "ms";
  const factor =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
  return Math.round(value * factor);
}

/**
 * Attribute counting-shim records (one per spawn, arguments joined by 0x01) to
 * their first tmux command word, skipping socket/option prefixes.
 */
export function countSpawnsByCommand(records: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of records) {
    if (!line) continue;
    const words = line.split("\u0001");
    let index = 0;
    while (index < words.length && words[index]!.startsWith("-")) {
      index += words[index] === "-u" || words[index] === "-C" || words[index] === "-v" ? 1 : 2;
    }
    const command = words[index] || "(none)";
    counts[command] = (counts[command] ?? 0) + 1;
  }
  return counts;
}

/** Fixed-width text table for the terminal summary. */
export function formatSoakReport(result: SoakVerdict): string {
  const { summary, checks } = result;
  const num = (value: number | null, digits = 1): string =>
    value === null ? "n/a" : value.toFixed(digits);
  const rows: [string, string][] = [
    ["samples", `${summary.samples} over ${num(summary.durationSeconds / 60)} min`],
    [
      "rss MiB",
      `start ${num(summary.rssStartMiB)}  end ${num(summary.rssEndMiB)}  max ${num(summary.rssMaxMiB)}  slope ${num(summary.rssGrowthMiBPerHour, 2)}/h`,
    ],
    [
      "open fds",
      `start ${num(summary.fdStart, 0)}  end ${num(summary.fdEnd, 0)}  max ${num(summary.fdMax, 0)}  slope ${num(summary.fdGrowthPerHour, 2)}/h`,
    ],
    ["cpu", `${num(summary.cpuSecondsTotal)} s total  ${num(summary.cpuPercentMean, 2)} % mean`],
    ["tmux spawns", `${summary.tmuxSpawnsTotal} total  ${num(summary.tmuxSpawnsPerMinute, 2)}/min`],
    [
      "ping rtt ms",
      `p50 <= ${num(summary.pingRttMs.p50, 2)}  max ${num(summary.pingRttMs.max, 2)}  n ${summary.pingRttMs.count}`,
    ],
    [
      "receipt ms",
      `p50 <= ${num(summary.receiptLatencyMs.p50, 0)}  max ${num(summary.receiptLatencyMs.max, 0)}  n ${summary.receiptLatencyMs.count}`,
    ],
    [
      "owner diagnostics",
      `${summary.diagnostics.validSamples}/${summary.samples} valid; resources unsupported ${summary.diagnostics.unsupportedResourceSamples}`,
    ],
    [
      "heap used MiB",
      `start ${num(summary.diagnostics.memoryBytes.heapUsed?.start === null || summary.diagnostics.memoryBytes.heapUsed?.start === undefined ? null : summary.diagnostics.memoryBytes.heapUsed.start / 1024 ** 2)}  end ${num(summary.diagnostics.memoryBytes.heapUsed?.end === null || summary.diagnostics.memoryBytes.heapUsed?.end === undefined ? null : summary.diagnostics.memoryBytes.heapUsed.end / 1024 ** 2)} (descriptive; GC-sensitive)`,
    ],
    [
      "diagnostic CPU",
      `${num(summary.diagnostics.cpuPercent.start)} → ${num(summary.diagnostics.cpuPercent.end)} % interval; policy pending`,
    ],
    ["observer gaps", String(summary.observerGapWarnings)],
    ["daemon restarts", String(summary.daemonRestarts)],
    ["receipt failures", String(summary.receiptFailures)],
    ["unexpected disconnects", String(summary.unexpectedDisconnects)],
  ];
  const width = Math.max(...rows.map(([label]) => label.length), ...checks.map((c) => c.id.length));
  const lines = rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
  lines.push("");
  for (const check of checks) {
    const mark = check.ok === null ? "----" : check.ok ? "ok  " : "FAIL";
    lines.push(
      `${mark} ${check.id.padEnd(width)}  observed ${num(check.observed, 2)}  bound ${check.bound}  ${check.detail}`,
    );
  }
  lines.push("");
  lines.push(`verdict: ${result.verdict.toUpperCase()}`);
  return lines.join("\n");
}

/** A revision acknowledges exactly the interest set sent in that subscribe. */
export function validSoakAck(frame: unknown, revision: number): boolean {
  if (!frame || typeof frame !== "object") return false;
  const ack = frame as Record<string, unknown>;
  return (
    ack.type === "resource.interests-ack" &&
    ack.interestRevision === revision &&
    Array.isArray(ack.unavailableInterests) &&
    ack.unavailableInterests.length === 0
  );
}

/** Unsolicited/stale control payloads cannot discharge the current probe. */
export function correlatedPongRtt(
  probe: { readonly id: string; readonly at: number },
  payload: string,
  now: number,
): number | null {
  return payload === probe.id && Number.isFinite(now) && now >= probe.at ? now - probe.at : null;
}
