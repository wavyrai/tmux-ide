import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitComparativeTrace,
  applyComparativeTraceAdmission,
  validateTraceEvidenceOption,
} from "./comparative-terminal-trace.mjs";
import { summarizeComparativeTerminalReport } from "./comparative-terminal-report.mjs";
const expected = { commit: "a".repeat(40), tree: "clean" };
const header = { version: 1, type: "performance.trace.header", ...expected };
const summary = {
  version: 1,
  type: "performance.trace.summary",
  acceptedRecords: 1,
  failed: false,
  saturated: false,
  droppedRecords: 0,
  oversizedRecords: 0,
  pendingRecords: 0,
  pendingCriticalRecords: 0,
  pendingBytes: 0,
  pendingStorageSlots: 0,
  writableLength: 0,
  pendingInputs: 0,
  droppedInputs: 0,
};
test("optional trace admission preserves unrequested options and rejects mismatched declaration", () => {
  assert.doesNotThrow(() => validateTraceEvidenceOption({}));
  const options = {
    targets: ["tmux-ide"],
    traceEvidence: expected,
    provenance: { tui: { commit: expected.commit, sourceState: "clean" } },
  };
  assert.doesNotThrow(() => validateTraceEvidenceOption(options));
  for (const traceEvidence of [
    null,
    { ...expected, commit: "b".repeat(40) },
    { ...expected, tree: "dirty" },
  ])
    assert.throws(() => validateTraceEvidenceOption({ ...options, traceEvidence }));
});
test("file admission rejects incomplete evidence, preserves oracle result and excludes timings", () => {
  const root = mkdtempSync(join(tmpdir(), "comparative-trace-"));
  const path = join(root, "trace.jsonl");
  const write = (records) =>
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  try {
    assert.equal(admitComparativeTrace(path, expected).status, "incomplete");
    write([header, summary]);
    assert.equal(admitComparativeTrace(path, expected).status, "complete");
    write([header, { ...summary, writableLength: 10 }]);
    assert.equal(admitComparativeTrace(path, expected).status, "complete"); // summary is captured before stream.end flush
    writeFileSync(path, JSON.stringify(header) + "\n" + JSON.stringify(summary));
    assert.equal(admitComparativeTrace(path, expected).status, "incomplete");
    write([header, summary]);
    const cleanupFailure = {
      status: "failed",
      originalOracleStatus: "passed",
      cleanupFailed: true,
    };
    applyComparativeTraceAdmission(cleanupFailure, path, expected);
    assert.equal(cleanupFailure.status, "failed");
    assert.equal(cleanupFailure.originalOracleStatus, "passed");
    for (const key of [
      "droppedRecords",
      "oversizedRecords",
      "pendingRecords",
      "pendingCriticalRecords",
      "pendingBytes",
      "pendingStorageSlots",
      "pendingInputs",
      "droppedInputs",
    ]) {
      write([header, { ...summary, [key]: 1 }]);
      assert.equal(admitComparativeTrace(path, expected).status, "incomplete", key);
    }
    for (const records of [
      [header],
      [header, { ...summary, failed: true }],
      [header, { ...summary, saturated: true }],
      [header, { ...summary, acceptedRecords: 2 }],
      [{ ...header, commit: "b".repeat(40) }, summary],
      [{ ...header, tree: "dirty" }, summary],
      [header, summary, summary],
      [header, summary, { type: "late" }],
    ]) {
      write(records);
      assert.equal(admitComparativeTrace(path, expected).status, "incomplete");
    }
    writeFileSync(path, Buffer.from([0xff, 10]));
    assert.equal(admitComparativeTrace(path, expected).status, "incomplete");
    writeFileSync(path, JSON.stringify(header) + "\n{");
    assert.equal(admitComparativeTrace(path, expected).status, "incomplete");
    for (const status of ["passed", "failed"]) {
      const report = { target: "tmux-ide", status, samples: [{ latencyMs: 1 }] };
      applyComparativeTraceAdmission(report, path, expected);
      assert.equal(report.status, "incomplete");
      assert.equal(report.originalOracleStatus, status);
      const [result] = summarizeComparativeTerminalReport({ runs: [report] });
      assert.equal(result.passed, 0);
      assert.equal(result.echo.count, 0);
      assert.equal(result.runs[0].originalOracleStatus, status);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
