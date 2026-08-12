import assert from "node:assert/strict";
import test from "node:test";

import {
  summarize,
  theilSenSlope,
  validateReferenceReport,
} from "./performance-reference-report.mjs";

const source = { commit: "a".repeat(40), tree: "b".repeat(40), dirty: false };

function report() {
  const measured = {
    status: "passed",
    passed: true,
    sampleCount: 4,
    rawSamples: [1, 2, 3, 4],
    summary: { p95: 4 },
    budgets: { p95: 5 },
  };
  return {
    version: 1,
    measuredAt: "2026-08-12T00:00:00.000Z",
    status: "passed",
    provenance: {
      host: "reference-host",
      cpuModel: "Apple M4 Pro",
      arch: "arm64",
      platform: "darwin",
      osRelease: "25.0.0",
      nodeVersion: "v24.0.0",
      bunVersion: "1.3.5",
      tmuxVersion: "tmux 3.6",
      commit: source.commit,
      tree: source.tree,
      dirty: false,
    },
    measurements: { startup: measured, inputToPaint: measured, memory: measured },
  };
}

test("validates exact source provenance and derived status", () => {
  assert.equal(validateReferenceReport(report(), source).status, "passed");
  assert.throws(
    () =>
      validateReferenceReport(
        { ...report(), provenance: { ...report().provenance, tree: "c".repeat(40) } },
        source,
      ),
    /source tree/u,
  );
  assert.throws(
    () => validateReferenceReport({ ...report(), status: "incomplete" }, source),
    /report status/u,
  );
});

test("uses nearest-rank percentiles and robust median pairwise slope", () => {
  assert.deepEqual(summarize([4, 1, 3, 2]), { count: 4, min: 1, p50: 2, p95: 4, max: 4 });
  assert.equal(theilSenSlope([0, 10, 20, 1_000]), 171.66666666666666);
  assert.equal(theilSenSlope([10, 20, 30, 40, 100_000]), 10);
});
