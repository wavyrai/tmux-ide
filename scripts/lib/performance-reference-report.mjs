import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const REFERENCE_REPORT_VERSION = 1;
export const PERFORMANCE_STAGES = Object.freeze([
  "input",
  "tmux",
  "parse",
  "reduce",
  "transport",
  "paint",
]);

export function gitSourceIdentity(root) {
  const commit = git(root, ["rev-parse", "HEAD"]);
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  const porcelain = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return Object.freeze({ commit, tree, dirty: porcelain.length > 0 });
}

export function validateReferenceReport(report, expectedSource = null) {
  object(report, "reference report");
  exact(report.version, REFERENCE_REPORT_VERSION, "reference report version");
  iso(report.measuredAt, "reference report measuredAt");
  object(report.provenance, "reference report provenance");
  for (const field of [
    "host",
    "cpuModel",
    "arch",
    "platform",
    "osRelease",
    "nodeVersion",
    "bunVersion",
    "tmuxVersion",
    "commit",
    "tree",
  ]) {
    nonempty(report.provenance[field], `reference report provenance.${field}`);
  }
  pattern(report.provenance.commit, /^[0-9a-f]{40}$/u, "provenance.commit");
  pattern(report.provenance.tree, /^[0-9a-f]{40}$/u, "provenance.tree");
  exact(report.provenance.dirty, false, "reference report provenance.dirty");
  if (expectedSource) {
    exact(report.provenance.commit, expectedSource.commit, "reference report source commit");
    exact(report.provenance.tree, expectedSource.tree, "reference report source tree");
    exact(expectedSource.dirty, false, "current source tree cleanliness");
  }
  for (const name of ["startup", "inputToPaint", "memory"])
    validateMeasurement(report.measurements?.[name], name);
  const expectedOverall = Object.values(report.measurements).some(
    ({ status }) => status === "failed",
  )
    ? "failed"
    : Object.values(report.measurements).every(({ status }) => status === "passed")
      ? "passed"
      : "incomplete";
  exact(report.status, expectedOverall, "reference report status");
  return report;
}

export function summarize(values) {
  if (!Array.isArray(values) || values.length === 0)
    throw new TypeError("summary requires samples");
  if (values.some((value) => !Number.isFinite(value) || value < 0))
    throw new TypeError("summary samples must be finite and non-negative");
  const ordered = [...values].sort((left, right) => left - right);
  return Object.freeze({
    count: ordered.length,
    min: ordered[0],
    p50: nearestRank(ordered, 0.5),
    p95: nearestRank(ordered, 0.95),
    max: ordered[ordered.length - 1],
  });
}

/** Median pairwise slope is resistant to isolated allocator/OS RSS spikes. */
export function theilSenSlope(values) {
  if (!Array.isArray(values) || values.length < 4)
    throw new TypeError("robust slope requires at least four samples");
  const slopes = [];
  for (let left = 0; left < values.length - 1; left += 1) {
    for (let right = left + 1; right < values.length; right += 1)
      slopes.push((values[right] - values[left]) / (right - left));
  }
  slopes.sort((a, b) => a - b);
  return median(slopes);
}

export function sourceArtifactDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validateMeasurement(measurement, name) {
  object(measurement, `measurement ${name}`);
  if (!["passed", "failed", "not-measured"].includes(measurement.status))
    throw new TypeError(`measurement ${name}.status is invalid`);
  object(measurement.budgets, `measurement ${name}.budgets`);
  if (measurement.status === "not-measured") {
    nonempty(measurement.reason, `measurement ${name}.reason`);
    return;
  }
  if (!Number.isSafeInteger(measurement.sampleCount) || measurement.sampleCount < 1)
    throw new TypeError(`measurement ${name}.sampleCount must be positive`);
  if (!Array.isArray(measurement.rawSamples) || measurement.rawSamples.length < 1)
    throw new TypeError(`measurement ${name}.rawSamples must be non-empty`);
  exact(
    measurement.rawSamples.length,
    measurement.sampleCount,
    `measurement ${name} raw sample count`,
  );
  object(measurement.summary, `measurement ${name}.summary`);
  if (typeof measurement.passed !== "boolean")
    throw new TypeError(`measurement ${name}.passed must be boolean`);
  exact(measurement.status, measurement.passed ? "passed" : "failed", `${name} pass status`);
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  return result.stdout.trim();
}

function nearestRank(ordered, percentile) {
  return ordered[Math.max(0, Math.ceil(ordered.length * percentile) - 1)];
}

function median(ordered) {
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function object(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
}

function nonempty(value, label) {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${label} must be a non-empty string`);
}

function pattern(value, expression, label) {
  if (typeof value !== "string" || !expression.test(value))
    throw new TypeError(`${label} has an invalid value`);
}

function iso(value, label) {
  nonempty(value, label);
  if (Number.isNaN(Date.parse(value))) throw new TypeError(`${label} must be ISO-8601`);
}

function exact(actual, expected, label) {
  if (actual !== expected)
    throw new TypeError(`${label} mismatch: expected ${String(expected)}, got ${String(actual)}`);
}

export function validateReferenceStageEvent(event) {
  for (const field of ["traceId", "stage", "processId", "clockId", "clockKind"])
    if (typeof event[field] !== "string" || event[field].length === 0)
      throw new TypeError(`Trace event ${field} must be a non-empty string`);
  // Client diagnostics are point events, not duration spans. Retain them in
  // the raw trace, but never use them as input/paint endpoints or stage timings.
  if (event.stage === "client") {
    if (
      typeof event.operation !== "string" ||
      !event.operation ||
      !Number.isSafeInteger(event.atMicros) ||
      event.atMicros < 0
    )
      throw new TypeError("Invalid client trace point");
    return false;
  }
  if (!PERFORMANCE_STAGES.includes(event.stage)) throw new TypeError("Unknown trace stage");
  if (
    !Number.isSafeInteger(event.startedAtMicros) ||
    !Number.isSafeInteger(event.endedAtMicros) ||
    event.startedAtMicros < 0 ||
    event.endedAtMicros < event.startedAtMicros
  )
    throw new TypeError("Trace event endpoints must be ordered safe monotonic microseconds");
  return true;
}

/** All captured sink inputs, not merely successful paints; no controller-attempt claim. */
export function admitReferenceInputTrace(events, source) {
  try {
    const headers = events.filter((event) => event?.type === "performance.trace.header");
    const summaries = events.filter((event) => event?.type === "performance.trace.summary");
    if (
      headers.length !== 1 ||
      events[0] !== headers[0] ||
      headers[0].version !== 1 ||
      headers[0].commit !== source.commit ||
      headers[0].tree !== source.tree ||
      typeof headers[0].processId !== "string" ||
      !headers[0].processId ||
      typeof headers[0].clockId !== "string" ||
      !headers[0].clockId ||
      headers[0].clockKind !== "performance-now"
    )
      throw new Error("Input trace source/header mismatch");
    if (summaries.length !== 1 || events.at(-1) !== summaries[0])
      throw new Error("Input trace needs one final writer summary");
    const summary = summaries[0];
    if (
      summary.version !== 1 ||
      summary.failed !== false ||
      summary.saturated !== false ||
      summary.acceptedRecords !== events.length - 1 ||
      !Number.isSafeInteger(summary.writableLength) ||
      summary.writableLength < 0 ||
      [
        "droppedRecords",
        "oversizedRecords",
        "pendingRecords",
        "pendingCriticalRecords",
        "pendingBytes",
        "pendingStorageSlots",
        "pendingInputs",
        "droppedInputs",
      ].some((key) => summary[key] !== 0)
    )
      throw new Error("Input trace writer evidence is incomplete");
    const counts = summary.inputAttempts;
    const fields = ["begun", "completed", "superseded", "expired", "cancelled", "pending"];
    if (!counts || fields.some((key) => !Number.isSafeInteger(counts[key]) || counts[key] < 0))
      throw new Error("Input attempt denominator unavailable or invalid");
    if (counts.begun !== fields.slice(1).reduce((sum, key) => sum + counts[key], 0))
      throw new Error("Input attempt counters do not conserve attempts");
    if (counts.completed === 0) throw new Error("No completed captured inputs");
    if (counts.begun !== counts.completed || counts.pending !== 0)
      throw new Error(
        "Captured inputs include unmatched, expired, superseded or cancelled attempts",
      );
    const pairs = new Map();
    for (const event of events) {
      if (event?.type !== "performance.stage") continue;
      validateReferenceStageEvent(event);
      if (event.stage !== "input" && event.stage !== "paint") continue;
      const pair = pairs.get(event.traceId) ?? {};
      if (pair[event.stage]) throw new Error("Duplicate input/paint endpoint");
      pair[event.stage] = event;
      pairs.set(event.traceId, pair);
    }
    if (pairs.size !== counts.completed) throw new Error("Input pair count differs from attempts");
    for (const { input, paint } of pairs.values()) {
      if (!input || !paint) throw new Error("Unmatched input/paint endpoint");
      if (
        input.processId !== headers[0].processId ||
        input.clockId !== headers[0].clockId ||
        input.processId !== paint.processId ||
        input.clockId !== paint.clockId ||
        input.clockKind !== paint.clockKind ||
        input.clockKind !== "performance-now" ||
        input.endedAtMicros > paint.startedAtMicros
      )
        throw new Error("Input/paint clock or causal ordering mismatch");
    }
    return {
      complete: true,
      inputAttempts: counts,
      scope: "All captured sink inputs; not controller-offered attempts or full six-stage coverage",
    };
  } catch (error) {
    return { complete: false, reason: error.message };
  }
}
