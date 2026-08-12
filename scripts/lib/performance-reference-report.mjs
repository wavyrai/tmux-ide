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
