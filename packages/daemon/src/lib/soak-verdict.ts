/**
 * Pure analysis for the daemon soak harness (`packages/daemon/scripts/soak-daemon.mjs`).
 *
 * The harness records one JSONL sample per interval; this module turns the
 * sample series into a summary and a verdict against explicit thresholds. It
 * has no io and no dependencies so the harness can import it directly and the
 * numbers it prints are the numbers the colocated tests pin down.
 */

export interface SoakSample {
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

export function percentiles(values: readonly number[]): Percentiles {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    max: values.length === 0 ? null : Math.max(...values),
  };
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

/**
 * Merge per-interval percentile records into a whole-run estimate. Exact
 * per-sample series are not retained across intervals, so the p50 here is the
 * count-weighted median of interval medians and the max is the true max.
 */
export function mergePercentiles(records: readonly Percentiles[]): Percentiles {
  const weighted: number[] = [];
  let max: number | null = null;
  let count = 0;
  for (const record of records) {
    if (record.p50 === null || record.count === 0) continue;
    count += record.count;
    for (let index = 0; index < record.count; index += 1) weighted.push(record.p50);
    if (record.max !== null && (max === null || record.max > max)) max = record.max;
  }
  return { count, p50: percentile(weighted, 0.5), max };
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
): SoakVerdict {
  const summary = summarizeSoak(samples);
  const enoughForFit = samples.length >= thresholds.minSamplesForFit;
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
          detail: `needs ${thresholds.minSamplesForFit} samples, have ${samples.length}`,
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
          detail: `needs ${thresholds.minSamplesForFit} samples, have ${samples.length}`,
        },
    boundCheck(
      "ping-rtt-p50",
      summary.pingRttMs.p50,
      thresholds.maxPingRttP50Ms,
      "events-client ping round-trip p50 ms",
    ),
    boundCheck(
      "receipt-latency-p50",
      summary.receiptLatencyMs.p50,
      thresholds.maxReceiptLatencyP50Ms,
      "wait agent-status receipt latency p50 ms after the flip",
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
      `p50 ${num(summary.pingRttMs.p50, 2)}  max ${num(summary.pingRttMs.max, 2)}  n ${summary.pingRttMs.count}`,
    ],
    [
      "receipt ms",
      `p50 ${num(summary.receiptLatencyMs.p50, 0)}  max ${num(summary.receiptLatencyMs.max, 0)}  n ${summary.receiptLatencyMs.count}`,
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
