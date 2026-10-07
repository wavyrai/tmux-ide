import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

export function validateTraceEvidenceOption(options) {
  const trace = options.traceEvidence;
  if (trace === undefined) return;
  if (
    !trace ||
    !options.targets?.includes("tmux-ide") ||
    !/^[0-9a-f]{40}$/.test(trace.commit ?? "") ||
    trace.tree !== "clean" ||
    options.provenance?.tui?.commit !== trace.commit ||
    options.provenance?.tui?.sourceState !== "clean"
  )
    throw new Error(
      "traceEvidence requires tmux-ide, a matching provenance.tui commit and clean declared tree/sourceState",
    );
}

/** File completeness only: not causal stage coverage, physical paint or a clock calibration. */
export function admitComparativeTrace(path, expected) {
  try {
    if (statSync(path).size > 64 * 1024 * 1024)
      throw new Error("Trace exceeds64MiB admission limit");
    const bytes = readFileSync(path);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.endsWith("\n")) throw new Error("Trace truncated: missing final newline");
    const records = text.slice(0, -1).split("\n").map(JSON.parse);
    const headers = records.filter((r) => r?.type === "performance.trace.header");
    const summaries = records.filter((r) => r?.type === "performance.trace.summary");
    if (
      headers.length !== 1 ||
      records[0] !== headers[0] ||
      headers[0].version !== 1 ||
      headers[0].commit !== expected.commit ||
      headers[0].tree !== expected.tree ||
      headers[0].tree !== "clean"
    )
      throw new Error("Trace header/provenance mismatch");
    if (summaries.length !== 1 || records.at(-1) !== summaries[0])
      throw new Error("Trace needs exactly one final summary");
    const summary = summaries[0];
    if (
      summary.version !== 1 ||
      summary.failed !== false ||
      summary.saturated !== false ||
      !Number.isSafeInteger(summary.writableLength) ||
      summary.writableLength < 0 ||
      summary.acceptedRecords !== records.length - 1 ||
      [
        "droppedRecords",
        "oversizedRecords",
        "pendingRecords",
        "pendingCriticalRecords",
        "pendingBytes",
        "pendingStorageSlots",
        "pendingInputs",
        "droppedInputs",
      ].some((k) => summary[k] !== 0)
    )
      throw new Error("Trace incomplete: loss, pending work or record count mismatch");
    return {
      status: "complete",
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      records: records.length,
      summary,
      declaredProvenance: expected,
      limitation:
        "Writer completeness only; construction exceptions, deliberate event coalescing and causal/clock coverage are not certified",
    };
  } catch (error) {
    return { status: "incomplete", path, error: String(error.message) };
  }
}

export function applyComparativeTraceAdmission(report, path, expected) {
  report.originalOracleStatus ??= report.status;
  report.traceEvidence = admitComparativeTrace(path, expected);
  if (report.traceEvidence.status !== "complete") report.status = "incomplete";
}
