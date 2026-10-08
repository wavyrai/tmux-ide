import assert from "node:assert/strict";
import test from "node:test";

import {
  summarize,
  theilSenSlope,
  validateReferenceReport,
  validateReferenceStageEvent,
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

test("reference traces distinguish client point diagnostics from measured spans", () => {
  const identity = {
    traceId: "trace",
    processId: "client",
    clockId: "clock",
    clockKind: "performance-now",
  };
  const point = { ...identity, stage: "client", operation: "lane-enqueue", atMicros: 100 };
  assert.equal(validateReferenceStageEvent(point), false);
  for (const stage of ["input", "paint"])
    assert.equal(
      validateReferenceStageEvent({ ...identity, stage, startedAtMicros: 100, endedAtMicros: 200 }),
      true,
    );
  assert.throws(
    () => validateReferenceStageEvent({ ...point, atMicros: -1 }),
    /client trace point/,
  );
  assert.throws(
    () => validateReferenceStageEvent({ ...point, stage: "unknown" }),
    /Unknown trace stage/,
  );
  assert.throws(
    () =>
      validateReferenceStageEvent({
        ...identity,
        stage: "paint",
        startedAtMicros: 200,
        endedAtMicros: 100,
      }),
    /ordered safe/,
  );
});

test("input admission cannot turn enough fast successful pairs into an all-input pass", async () => {
  const { admitReferenceInputTrace } = await import("./performance-reference-report.mjs");
  const header = {
    version: 1,
    type: "performance.trace.header",
    commit: source.commit,
    tree: source.tree,
    processId: "tui:1",
    clockId: "tui",
    clockKind: "performance-now",
  };
  const pairs = Array.from({ length: 36 }, (_, i) =>
    ["input", "paint"].map((stage) => ({
      version: 1,
      type: "performance.stage",
      traceId: `input-${i}`,
      stage,
      processId: "tui:1",
      clockId: "tui",
      clockKind: "performance-now",
      startedAtMicros: stage === "input" ? 0 : 100,
      endedAtMicros: stage === "input" ? 100 : 1000,
    })),
  ).flat();
  const counts = { begun: 36, completed: 36, superseded: 0, expired: 0, cancelled: 0, pending: 0 };
  const summary = {
    version: 1,
    type: "performance.trace.summary",
    acceptedRecords: 37 + 36,
    failed: false,
    saturated: false,
    writableLength: 0,
    droppedRecords: 0,
    oversizedRecords: 0,
    pendingRecords: 0,
    pendingCriticalRecords: 0,
    pendingBytes: 0,
    pendingStorageSlots: 0,
    pendingInputs: 0,
    droppedInputs: 0,
    inputAttempts: counts,
  };
  const events = [header, ...pairs, summary];
  assert.equal(
    admitReferenceInputTrace(
      [
        header,
        { ...summary, acceptedRecords: 1, inputAttempts: { ...counts, begun: 0, completed: 0 } },
      ],
      source,
    ).complete,
    false,
  );
  for (const patch of [{ processId: "foreign" }, { clockId: "foreign" }, { processId: undefined }])
    assert.equal(
      admitReferenceInputTrace([{ ...header, ...patch }, ...pairs, summary], source).complete,
      false,
    );
  assert.equal(admitReferenceInputTrace(events, source).complete, true);
  // Legacy analyzer takes these same36 1ms paints and passes its minimum/p95 gate.
  for (const kind of ["superseded", "expired", "cancelled", "pending"]) {
    const s = { ...summary, inputAttempts: { ...counts, begun: 37, [kind]: 1 } };
    assert.equal(admitReferenceInputTrace([header, ...pairs, s], source).complete, false, kind);
  }
  for (const patch of [
    { inputAttempts: undefined },
    { inputAttempts: { ...counts, begun: 37 } },
    { inputAttempts: { ...counts, completed: 35 } },
    { droppedRecords: 1 },
    { oversizedRecords: 1 },
    { failed: true },
    { pendingInputs: 1 },
    { acceptedRecords: 72 },
  ])
    assert.equal(
      admitReferenceInputTrace([header, ...pairs, { ...summary, ...patch }], source).complete,
      false,
    );
  assert.equal(admitReferenceInputTrace(events.slice(0, -1), source).complete, false);
  assert.equal(admitReferenceInputTrace([...events, summary], source).complete, false);
  assert.equal(
    admitReferenceInputTrace([{ ...header, commit: "c".repeat(40) }, ...pairs, summary], source)
      .complete,
    false,
  );
  const duplicate = [header, ...pairs, pairs[0], { ...summary, acceptedRecords: 74 }];
  assert.equal(admitReferenceInputTrace(duplicate, source).complete, false);
  const unmatched = pairs.filter((_, i) => i !== 1);
  assert.equal(
    admitReferenceInputTrace([header, ...unmatched, { ...summary, acceptedRecords: 72 }], source)
      .complete,
    false,
  );
  const wrongClock = pairs.map((p, i) => (i === 1 ? { ...p, clockId: "other" } : p));
  assert.equal(admitReferenceInputTrace([header, ...wrongClock, summary], source).complete, false);
});

test("local input/paint budget success does not imply generic six-stage or mission coverage", async () => {
  const { referenceStageCoverage } = await import("./performance-reference-report.mjs");
  const span = (stage) => ({
    type: "performance.stage",
    traceId: "a",
    stage,
    processId: "p",
    clockId: "c",
    clockKind: "performance-now",
    startedAtMicros: 1,
    endedAtMicros: 2,
  });
  const result = referenceStageCoverage([span("input"), span("paint")]);
  assert.equal(result.status, "incomplete");
  assert.equal(result.stages.parse.missing, 1);
  assert.equal(result.stages.input.domains[0].summaryMs.count, 1);
  assert.equal(result.missionBoundaryVerdict, "not-measured");
  assert.equal(validateReferenceReport(report(), source).status, "passed");
  const complete = referenceStageCoverage(
    ["input", "tmux", "parse", "reduce", "transport", "paint"].map(span),
  );
  assert.equal(complete.status, "complete");
  assert.equal(complete.missionBoundaryVerdict, "not-measured");
  assert.equal(complete.crossDomainTimeline.status, "not-measured");
});

test("duplicate and orphan stages are incomplete, and local clock domains never merge", async () => {
  const { referenceStageCoverage } = await import("./performance-reference-report.mjs");
  const span = (traceId, stage, processId = "p", clockId = "c") => ({
    type: "performance.stage",
    traceId,
    stage,
    processId,
    clockId,
    clockKind: "performance-now",
    startedAtMicros: 1,
    endedAtMicros: 2,
  });
  const events = [
    span("a", "input"),
    span("a", "paint"),
    span("a", "parse"),
    span("a", "parse"),
    span("b", "input", "q", "d"),
    span("b", "paint", "q", "d"),
    span("unknown", "transport"),
    { type: "performance.clock-calibration", outcome: { status: "accepted" } },
  ];
  const result = referenceStageCoverage(events);
  assert.equal(result.status, "incomplete");
  assert.equal(result.stages.parse.duplicate, 1);
  assert.equal(result.stages.parse.domains.length, 0);
  assert.equal(result.stages.input.domains.length, 2);
  assert.equal(result.orphanSpans, 1);
  assert.equal(result.crossDomainTimeline.calibrationRecords, 1);
  assert.equal(result.crossDomainTimeline.status, "not-measured");
  assert.equal(referenceStageCoverage([]).status, "incomplete");
});
