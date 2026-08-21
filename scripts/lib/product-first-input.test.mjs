import assert from "node:assert/strict";
import test from "node:test";

import {
  assessProductFirstInput,
  assessProductInputDistribution,
  launchAndWaitForExactProductTui,
  productFirstInputDocument,
  productFirstInputPayload,
  productFirstInputFingerprint,
  productCoherentFrameTimeoutObservation,
  productInputOutlierEvidence,
  productInputPersistenceFenceState,
  qualifyProductFirstInput,
  qualifyProductInputDistribution,
  summarizeProductInputDistribution,
  settleProductFirstInputFixtureReset,
  waitForProductInputQualification,
  waitForProductInputPersistenceFence,
  assessFirstKeyPasteBoundaries,
} from "./product-first-input.mjs";

test("coherent timeout observation is exact-runtime fenced, bounded, and path-free", () => {
  const generation = "226826d4-5f72-4b59-be54-9f75e85640d4";
  const observation = productCoherentFrameTimeoutObservation({
    processId: "opentui:4934",
    daemonGeneration: generation,
    detailMode: "0",
    lifecycleRecords: [
      {
        phase: "generation-host-internal-snapshot-publication",
        publicationPhase: "internal-snapshot-published",
        processId: "opentui:1111",
        daemonGeneration: generation,
        rendererEpoch: 99,
        monotonicMicros: 1,
      },
      {
        phase: "generation-host-internal-snapshot-publication",
        publicationPhase: "internal-snapshot-published",
        processId: "opentui:4934",
        clockId: "opentui-performance-now",
        daemonGeneration: generation,
        rendererEpoch: 1,
        monotonicMicros: 100,
      },
      {
        phase: "resource-snapshot",
        processId: "opentui:4934",
        diagnostics: { droppedRecords: 5, failed: false, secretPath: "/tmp/private" },
      },
    ],
    traceRecords: [
      {
        type: "performance.terminal-canonical-publication",
        processId: "opentui:4934",
        clockId: "opentui-performance-now",
        generation,
        atMicros: 120,
      },
      {
        type: "performance.terminal-canonical-paint",
        processId: "opentui:4934",
        clockId: "opentui-performance-now",
        generation,
        atMicros: 140,
      },
      {
        type: "performance.terminal-canonical-paint",
        processId: "opentui:1111",
        clockId: "opentui-performance-now",
        generation,
        atMicros: 150,
      },
    ],
  });
  assert.deepEqual(observation, {
    version: 1,
    operation: "wait-for-coherent-terminal-frame",
    reason: "matching-first-terminal-frame-missing",
    processId: "opentui:4934",
    daemonGeneration: generation,
    rendererEpoch: 1,
    detailMode: "input-detail",
    internalPublicationCount: 1,
    internalPublicationAtMicros: 100,
    canonicalPublicationCount: 1,
    canonicalPaintCount: 1,
    latestCanonicalPaintAtMicros: 140,
    firstTerminalFrameCount: 0,
    canonicalHostFrameCount: 0,
    terminalFrameFenceCount: 0,
    lifecycleDroppedRecords: 5,
    lifecycleWriterFailed: false,
  });
  assert.doesNotMatch(JSON.stringify(observation), /private|\/tmp/u);
});

test("exact ProductRig TUI launch passes its fresh PID into coherent wait", async () => {
  const calls = [];
  let statusCalls = 0;
  const result = await launchAndWaitForExactProductTui({
    start: () => calls.push("start"),
    status: () => {
      statusCalls += 1;
      return { processId: 4934, launchId: "launch-a", statusCalls };
    },
    waitForCoherent: async (processId) => calls.push(`wait:${processId}`),
  });
  assert.deepEqual(calls, ["start", "wait:4934"]);
  assert.equal(result.processId, 4934);
  assert.equal(statusCalls, 2);

  const observation = productCoherentFrameTimeoutObservation({
    processId: "opentui:4934",
    daemonGeneration: "226826d4-5f72-4b59-be54-9f75e85640d4",
    detailMode: "0",
    lifecycleRecords: [],
    traceRecords: [],
  });
  await assert.rejects(
    launchAndWaitForExactProductTui({
      start: () => undefined,
      status: () => ({ processId: 4934 }),
      waitForCoherent: async (processId) => {
        assert.equal(processId, 4934);
        const error = new Error("timeout");
        error.observation = observation;
        throw error;
      },
    }),
    (error) => error.observation.processId === "opentui:4934",
  );
});

test("coherent timeout ignores an earlier renderer epoch in the same process and generation", () => {
  const generation = "226826d4-5f72-4b59-be54-9f75e85640d4";
  const observation = productCoherentFrameTimeoutObservation({
    processId: "opentui:4934",
    daemonGeneration: generation,
    detailMode: "1",
    lifecycleRecords: [
      {
        phase: "generation-host-internal-snapshot-publication",
        publicationPhase: "internal-snapshot-published",
        processId: "opentui:4934",
        clockId: "opentui-performance-now",
        daemonGeneration: generation,
        rendererEpoch: 1,
        monotonicMicros: 100,
      },
      {
        phase: "generation-host-internal-snapshot-publication",
        publicationPhase: "internal-snapshot-published",
        processId: "opentui:4934",
        clockId: "opentui-performance-now",
        daemonGeneration: generation,
        rendererEpoch: 2,
        monotonicMicros: 200,
      },
    ],
    traceRecords: [
      {
        type: "performance.terminal-canonical-paint",
        processId: "opentui:4934",
        clockId: "opentui-performance-now",
        generation,
        atMicros: 150,
      },
      {
        type: "performance.terminal-canonical-host-frame",
        processId: "opentui:4934",
        clockId: "opentui-performance-now",
        generation,
        rendererEpoch: 1,
        atMicros: 250,
      },
    ],
  });
  assert.equal(observation.rendererEpoch, 2);
  assert.equal(observation.canonicalPaintCount, 0);
  assert.equal(observation.canonicalHostFrameCount, 0);
});

test("causal failure fence returns bounded structural evidence immediately", () => {
  const processId = "opentui:1";
  const diagnostic = {
    version: 1,
    changedCellCount: 2,
    changedRowCount: 1,
    changedCoordinates: [
      { row: 0, column: 10 },
      { row: 0, column: 11 },
    ],
    coordinatesTruncated: false,
    targetMatched: true,
    cursorChanged: false,
  };
  assert.deepEqual(
    productInputPersistenceFenceState(
      [
        {
          type: "performance.stage",
          stage: "client",
          processId,
          traceId: "trace-a",
          operation: "causal-cell-failed:ambiguous-delta",
          causalDiagnostic: diagnostic,
        },
      ],
      0,
      processId,
    ),
    {
      status: "failed",
      reason: "ambiguous-delta",
      traceId: "trace-a",
      diagnostic,
    },
  );
});

test("persistence wait throws the exact structural causal failure without timing out", async () => {
  let clock = 0;
  let waits = 0;
  const diagnostic = { changedCellCount: 2, changedCoordinates: [{ row: 0, column: 1 }] };
  await assert.rejects(
    waitForProductInputPersistenceFence({
      baseline: 0,
      processId: "opentui:1",
      readRecords: () => [
        {
          type: "performance.stage",
          stage: "client",
          processId: "opentui:1",
          traceId: "trace-a",
          operation: "causal-cell-failed:ambiguous-delta",
          causalDiagnostic: diagnostic,
        },
      ],
      now: () => clock,
      wait: async (ms) => {
        waits += 1;
        clock += ms;
      },
    }),
    (error) => {
      assert.equal(error.boundary, "first-input-causal-paint");
      assert.deepEqual(error.observation, {
        reason: "ambiguous-delta",
        traceId: "trace-a",
        structuralDiff: diagnostic,
      });
      return true;
    },
  );
  assert.equal(waits, 0);
});

test("first-input reset rejects stale readiness and settles one exact canonical identity", async () => {
  let clock = 0;
  let reads = 0;
  const resets = [];
  const settled = await settleProductFirstInputFixtureReset({
    token: "first-key",
    expected: { paneId: "%0", semanticPaneId: "pane-a", generation: "generation-a" },
    sendReset: (token) => resets.push(token),
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    stableMs: 20,
    observe: () => {
      reads += 1;
      const current = reads >= 3;
      return {
        fixtureOption: current ? "ready-v1:first-key" : "ready-v1:old",
        currentCommand: "node",
        paneId: "%0",
        semanticPaneId: "pane-a",
        generation: "generation-a",
        incarnation: "generation-a:0",
        revision: current ? 5 : 4,
        stateHash: current ? "state-5" : "state-4",
        geometry: current ? "132x41" : "80x24",
        geometryStable: current,
        nativeCellBlank: true,
        tuiCellBlank: true,
        queueSettled: true,
        nativeHash: current ? "native-5" : "native-4",
        tuiHash: current ? "tui-5" : "tui-4",
      };
    },
  });
  assert.deepEqual(resets, ["first-key"]);
  assert.equal(settled.revision, 5);
  assert.ok(reads >= 5);
});

test("distribution timeline summary is bounded and structurally hashes the report manifest", () => {
  const evidence = {
    variant: "paste",
    passed: true,
    sampleCount: 30,
    startOrdinal: 1,
    p95Ms: 8,
    p99Ms: 9,
    samples: Array.from({ length: 30 }, (_, index) => ({
      traceId: `trace-${index}`,
      daemonReceipts: Array.from({ length: 10 }, (__, receipt) => ({
        operation: `receipt-${receipt}`,
        padding: "x".repeat(512),
      })),
    })),
  };
  const summary = summarizeProductInputDistribution(evidence);
  assert.equal(summary.sampleCount, 30);
  assert.equal(summary.sampleManifestSha256.length, 64);
  assert.ok(summary.sampleManifestBytes > 64 * 1024);
  assert.ok(JSON.stringify(summary).length < 512);
  assert.equal("samples" in summary, false);
});

test("distribution preserves a bounded top-three phase and cross-clock anchor vector", () => {
  const samples = Array.from({ length: 5 }, (_, index) => ({
    sample: {
      traceId: `trace-${index}`,
      durationMs: index + 1,
      processId: "opentui:1",
      clockId: "opentui-performance-now",
      generation: "generation-a",
      clientStages: [
        { operation: "pane-stream-frame-enqueued", offsetMs: 0.1, atMicros: 100 },
        {
          operation: "pane-stream-socket-send-return",
          offsetMs: 0.2,
          atMicros: 200,
          sharedMicros: 1_000,
          clockOffsetLowerMicros: 90,
          clockOffsetUpperMicros: 110,
        },
        { operation: "transport-ack", offsetMs: index + 0.5, atMicros: 500 },
        { operation: "canonical-apply-begin", offsetMs: 1, atMicros: 1_000 },
        { operation: "canonical-apply-end", offsetMs: 2, atMicros: 2_000 },
        { operation: "render-invalidated", offsetMs: 2.1, atMicros: 2_100 },
        { operation: "causal-cell-painted", offsetMs: 2.4, atMicros: 2_400 },
        {
          operation: "pane-stream-buffer-after-send",
          offsetMs: 0.2,
          atMicros: 200,
          bufferedAmount: 32,
          frameBytes: 384,
        },
        {
          operation: "pane-stream-buffer-drain-watermark",
          offsetMs: 0.3,
          atMicros: 300,
          bufferedAmount: 0,
          drained: true,
        },
      ],
      daemonSpans: [
        {
          operation: "pane-stream-socket-message-callback-entry",
          processId: "daemon:2",
          clockId: "daemon-performance-now",
          startedAtMicros: 7_000,
          sharedStartedAtMicros: 1_110,
        },
        { operation: "control-write", startedAtMicros: 7_100, endedAtMicros: 7_110 },
        { operation: "control-command-accepted", startedAtMicros: 8_000, endedAtMicros: 8_000 },
        { operation: "first-output-observed", startedAtMicros: 8_010, endedAtMicros: 8_010 },
        {
          operation: "terminal-replica-project-commit",
          startedAtMicros: 8_020,
          endedAtMicros: 8_030,
        },
        { operation: "pane-stream-socket-send", startedAtMicros: 8_040, endedAtMicros: 8_050 },
      ],
    },
  }));
  const outliers = productInputOutlierEvidence({
    samples,
    startOrdinal: 1,
    daemonObserverRecords: [
      {
        type: "performance.daemon-observer",
        operation: "healthcheck",
        phase: "begin",
        traceId: "10000000-0000-4000-8000-000000000001",
        generation: "generation-a",
        processId: "daemon:2",
        clockId: "daemon-performance-now",
        clockKind: "performance-now",
        atMicros: 6_900,
        activeOperations: 1,
      },
      {
        type: "performance.daemon-observer",
        operation: "healthcheck",
        phase: "end",
        traceId: "10000000-0000-4000-8000-000000000001",
        generation: "generation-a",
        processId: "daemon:2",
        clockId: "daemon-performance-now",
        clockKind: "performance-now",
        atMicros: 6_990,
        activeOperations: 1,
        succeeded: true,
      },
      {
        type: "performance.daemon-observer",
        operation: "fleet-cycle",
        phase: "begin",
        traceId: "10000000-0000-4000-8000-000000000002",
        generation: "generation-a",
        processId: "daemon:2",
        clockId: "daemon-performance-now",
        clockKind: "performance-now",
        atMicros: 7_500,
        activeOperations: 1,
      },
      {
        type: "performance.daemon-observer",
        operation: "fleet-cycle",
        phase: "event-loop-sentinel",
        traceId: "10000000-0000-4000-8000-000000000002",
        generation: "generation-a",
        processId: "daemon:2",
        clockId: "daemon-performance-now",
        clockKind: "performance-now",
        atMicros: 7_520,
      },
      {
        type: "performance.daemon-observer",
        operation: "fleet-cycle",
        phase: "end",
        traceId: "10000000-0000-4000-8000-000000000002",
        generation: "generation-a",
        processId: "daemon:2",
        clockId: "daemon-performance-now",
        clockKind: "performance-now",
        atMicros: 7_800,
        activeOperations: 1,
        succeeded: true,
      },
      {
        type: "performance.daemon-observer",
        operation: "fleet-cycle",
        phase: "begin",
        traceId: "10000000-0000-4000-8000-000000000003",
        generation: "wrong-generation",
        processId: "daemon:2",
        clockId: "daemon-performance-now",
        clockKind: "performance-now",
        atMicros: 7_000,
        activeOperations: 1,
      },
      {
        type: "performance.daemon-observer",
        operation: "fleet-cycle",
        phase: "end",
        traceId: "10000000-0000-4000-8000-000000000003",
        generation: "wrong-generation",
        processId: "daemon:2",
        clockId: "daemon-performance-now",
        clockKind: "performance-now",
        atMicros: 8_000,
        activeOperations: 1,
        succeeded: true,
      },
    ],
  });
  assert.deepEqual(
    outliers.map(({ ordinal, durationMs }) => ({ ordinal, durationMs })),
    [
      { ordinal: 5, durationMs: 5 },
      { ordinal: 4, durationMs: 4 },
      { ordinal: 3, durationMs: 3 },
    ],
  );
  assert.deepEqual(outliers[0].socketBuffer, {
    before: null,
    after: 32,
    nextTurn: null,
    drained: true,
    frameBytes: 384,
  });
  assert.deepEqual(outliers[0].clockAnchors.daemon, {
    processId: "daemon:2",
    clockId: "daemon-performance-now",
    atMicros: 7_000,
  });
  assert.deepEqual(outliers[0].daemonPhaseMicros, {
    callbackToControlWrite: 100,
    controlReplyWait: 890,
    replyToFirstOutput: 10,
    firstOutputToCommit: 20,
    commitToSocketSend: 20,
  });
  assert.deepEqual(outliers[0].observerOverlap, [
    {
      operation: "healthcheck",
      overlapMicros: 10,
      possibleOutboundOverlapMicros: 10,
      definiteDaemonOverlapMicros: 0,
      classification: "possible-outbound-overlap",
      eventLoopSentinelMicros: null,
      activeOperations: 1,
      succeeded: true,
    },
    {
      operation: "fleet-cycle",
      overlapMicros: 300,
      possibleOutboundOverlapMicros: 0,
      definiteDaemonOverlapMicros: 300,
      classification: "definite-daemon-overlap",
      eventLoopSentinelMicros: 7_520,
      activeOperations: 1,
      succeeded: true,
    },
  ]);
  assert.deepEqual(outliers[0].observerWindow, {
    source: "calibrated-send-through-output",
    startedAtMicros: 6_980,
    endedAtMicros: 8_050,
  });
  const exactGroup = [
    {
      type: "performance.daemon-observer",
      operation: "fleet-cycle",
      phase: "begin",
      traceId: "20000000-0000-4000-8000-000000000001",
      generation: "generation-a",
      processId: "daemon:2",
      clockId: "daemon-performance-now",
      clockKind: "performance-now",
      atMicros: 7_500,
      activeOperations: 1,
    },
    {
      type: "performance.daemon-observer",
      operation: "fleet-cycle",
      phase: "event-loop-sentinel",
      traceId: "20000000-0000-4000-8000-000000000001",
      generation: "generation-a",
      processId: "daemon:2",
      clockId: "daemon-performance-now",
      clockKind: "performance-now",
      atMicros: 7_520,
      activeOperations: 1,
    },
    {
      type: "performance.daemon-observer",
      operation: "fleet-cycle",
      phase: "end",
      traceId: "20000000-0000-4000-8000-000000000001",
      generation: "generation-a",
      processId: "daemon:2",
      clockId: "daemon-performance-now",
      clockKind: "performance-now",
      atMicros: 7_800,
      activeOperations: 1,
      succeeded: true,
    },
  ];
  for (const phase of ["begin", "event-loop-sentinel", "end"]) {
    const duplicate = exactGroup.find((record) => record.phase === phase);
    const malformed = productInputOutlierEvidence({
      samples,
      startOrdinal: 1,
      daemonObserverRecords: [...exactGroup, { ...duplicate }],
    });
    assert.deepEqual(malformed[0].observerOverlap, []);
  }
  assert.ok(JSON.stringify(outliers).length < 4_096);
});

const EXPECTED = Object.freeze({
  variant: "key",
  processId: "opentui:1",
  clockId: "opentui-performance-now",
  semanticPaneId: "pane-a",
  generation: "generation-a",
  incarnation: "incarnation-a",
  revision: 0,
  stateHash: "hash-0",
  inputFingerprintKey: "f".repeat(64),
});

test("combined qualification waits for a delayed final daemon receipt", async () => {
  let now = 0;
  let reads = 0;
  const result = await waitForProductInputQualification({
    baseline: 0,
    processId: EXPECTED.processId,
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
    readTuiRecords: () => trace("key", 0),
    readDaemonRecords: () => daemonTrace().slice(0, ++reads < 3 ? -1 : undefined),
    assess: (tui, daemon) =>
      assessProductFirstInput(tui, {
        ...EXPECTED,
        document: productFirstInputDocument("key"),
        requireDaemonEvidence: true,
        daemonTraceRecords: daemon,
      }),
    qualify: (tui, daemon) =>
      qualifyProductFirstInput(tui, {
        ...EXPECTED,
        document: productFirstInputDocument("key"),
        requireDaemonEvidence: true,
        daemonTraceRecords: daemon,
      }),
  });
  assert.equal(result.origin.traceId, "00000000-0000-4000-8000-000000000001");
  assert.ok(reads >= 3);
});

test("production-shaped domain stages and concurrent daemon settlements qualify", () => {
  for (const acceptedBeforeEventLoop of [false, true]) {
    const assessment = assessProductFirstInput(trace("key", 0), {
      ...EXPECTED,
      document: productFirstInputDocument("key"),
      requireDaemonEvidence: true,
      daemonTraceRecords: daemonTrace(0, acceptedBeforeEventLoop),
    });
    assert.ok(assessment.qualified);
    assert.equal(assessment.firstFailedPredicate, null);
    assert.equal(assessment.terminal, true);
    assert.equal(
      assessment.predicates.find(({ id }) => id === "daemon-stage-identity").passed,
      true,
    );
    assert.equal(
      assessment.predicates.find(({ id }) => id === "client-causal-order")
        .deliveryMinusInvalidationMicros,
      -1,
    );
  }
});

test("replays the sealed production timestamp and persistence shape", () => {
  const { tui, daemon } = sealedProductionTraceShape();
  const assessment = assessProductFirstInput(tui, {
    ...EXPECTED,
    document: productFirstInputDocument("key"),
    requireDaemonEvidence: true,
    daemonTraceRecords: daemon,
  });
  assert.ok(assessment.qualified);
  assert.equal(assessment.firstFailedPredicate, null);
  assert.deepEqual(
    assessment.predicates.find(({ id }) => id === "daemon-causal-order"),
    {
      id: "daemon-causal-order",
      passed: true,
      eventLoopMinusAcceptedMicros: -142,
    },
  );
  assert.deepEqual(
    assessment.predicates.find(({ id }) => id === "client-causal-order"),
    {
      id: "client-causal-order",
      passed: true,
      deliveryMinusInvalidationMicros: -30,
      paintMinusInputMicros: 33_002,
    },
  );
});

test("healthy persisted evidence rejects an exact deterministic predicate without waiting", async () => {
  const tui = trace("key", 0);
  const daemon = daemonTrace();
  daemon.find(({ operation }) => operation === "raw-input-command").stage = "daemon";
  let waits = 0;
  await assert.rejects(
    waitForProductInputQualification({
      baseline: 0,
      processId: EXPECTED.processId,
      readTuiRecords: () => tui,
      readDaemonRecords: () => daemon,
      qualify: (tuiRecords, daemonRecords) =>
        qualifyProductFirstInput(tuiRecords, {
          ...EXPECTED,
          document: productFirstInputDocument("key"),
          requireDaemonEvidence: true,
          daemonTraceRecords: daemonRecords,
        }),
      assess: (tuiRecords, daemonRecords) =>
        assessProductFirstInput(tuiRecords, {
          ...EXPECTED,
          document: productFirstInputDocument("key"),
          requireDaemonEvidence: true,
          daemonTraceRecords: daemonRecords,
        }),
      wait: async () => {
        waits += 1;
      },
    }),
    (error) => {
      assert.equal(error.boundary, "first-input-causal-paint");
      assert.equal(error.observation.reason, "deterministic-qualification-mismatch");
      assert.equal(error.observation.firstFailedPredicate, "daemon-stage-identity");
      assert.equal(error.observation.terminal, true);
      assert.deepEqual(
        error.observation.predicates.find(({ passed }) => !passed),
        {
          id: "daemon-stage-identity",
          passed: false,
          operation: "raw-input-command",
          expectedStage: "tmux",
          actualStage: "invalid",
          matchCount: 1,
        },
      );
      return true;
    },
  );
  assert.equal(waits, 0);
});

test("thirty terminal distribution samples reject a named mismatch without waiting", async () => {
  const tui = Array.from({ length: 30 }, (_, ordinal) => trace("paste", ordinal)).flat();
  const daemon = Array.from({ length: 30 }, (_, ordinal) => daemonTrace(ordinal)).flat();
  daemon.find(
    (record) =>
      record.traceId === "00000000-0000-4000-8000-000000000011" &&
      record.operation === "terminal-replica-write",
  ).stage = "daemon";
  const expected = {
    variant: "paste",
    processId: EXPECTED.processId,
    clockId: EXPECTED.clockId,
    semanticPaneId: EXPECTED.semanticPaneId,
    generation: EXPECTED.generation,
    incarnation: EXPECTED.incarnation,
    inputFingerprintKey: EXPECTED.inputFingerprintKey,
    revision: undefined,
    stateHash: undefined,
    requireDaemonEvidence: true,
    startOrdinal: 0,
  };
  let waits = 0;
  await assert.rejects(
    waitForProductInputQualification({
      boundary: "distribution-samples",
      readTuiRecords: () => tui,
      readDaemonRecords: () => daemon,
      qualify: (tuiRecords, daemonRecords) =>
        qualifyProductInputDistribution(tuiRecords, {
          ...expected,
          daemonTraceRecords: daemonRecords,
        }),
      assess: (tuiRecords, daemonRecords) =>
        assessProductInputDistribution(tuiRecords, {
          ...expected,
          daemonTraceRecords: daemonRecords,
        }),
      wait: async () => {
        waits += 1;
      },
    }),
    (error) => {
      assert.equal(error.boundary, "distribution-samples");
      assert.equal(error.observation.reason, "deterministic-qualification-mismatch");
      assert.equal(error.observation.firstFailedPredicate, "daemon-stage-identity");
      assert.equal(error.observation.terminal, true);
      assert.equal(error.observation.predicates.find(({ passed }) => !passed).sampleOrdinal, 10);
      return true;
    },
  );
  assert.equal(waits, 0);
});

test("persistence fence waits behind delayed paint/fence records and rejects unhealthy writers", () => {
  const records = trace("key", 0);
  const paintIndex = records.findIndex(
    ({ type, stage }) => type === "performance.stage" && stage === "paint",
  );
  const fenceIndex = records.findIndex(({ type }) => type === "performance.input-fence");
  const delayed = records.filter((_, index) => index !== paintIndex && index !== fenceIndex);
  assert.equal(productInputPersistenceFenceState(delayed, 0, EXPECTED.processId).status, "pending");
  delayed.push(records[paintIndex]);
  assert.deepEqual(productInputPersistenceFenceState(delayed, 0, EXPECTED.processId), {
    status: "pending",
    reason: "fence",
  });
  delayed.push(records[fenceIndex]);
  assert.equal(productInputPersistenceFenceState(delayed, 0, EXPECTED.processId).status, "proved");
  delayed.at(-1).writerHealth.failed = true;
  assert.deepEqual(productInputPersistenceFenceState(delayed, 0, EXPECTED.processId), {
    status: "failed",
    reason: "writer-health",
  });
});

test("journey assessment is ordered, exact-once, and fails incomplete direct evidence", () => {
  const phases = [
    "first-input-namespace-ready",
    "first-input-daemon-ready",
    "first-input-no-prior-hosted-input",
    "first-input-causal-paint",
    "distribution-lane-fresh",
    "distribution-samples",
    "first-input-web-correlation",
  ];
  const evidence = {
    firstInput: { noPriorHostedInput: true, traceId: "trace" },
    distribution: { sampleCount: 30, passed: true },
  };
  assert.equal(
    assessFirstKeyPasteBoundaries({
      timeline: phases.map((phase) => ({ phase })),
      evidence,
      correlationComplete: true,
    }).status,
    "passed",
  );
  assert.equal(
    assessFirstKeyPasteBoundaries({
      timeline: phases.toReversed().map((phase) => ({ phase })),
      evidence,
      correlationComplete: true,
    }).firstBrokenBoundary,
    "first-input-daemon-ready",
  );
  assert.equal(
    assessFirstKeyPasteBoundaries({
      timeline: phases.concat("first-input-causal-paint").map((phase) => ({ phase })),
      evidence,
      correlationComplete: true,
    }).firstBrokenBoundary,
    "first-input-causal-paint",
  );
  assert.equal(
    assessFirstKeyPasteBoundaries({
      timeline: phases.map((phase) => ({ phase })),
      evidence: { ...evidence, distribution: { sampleCount: 29, passed: false } },
      correlationComplete: true,
    }).firstBrokenBoundary,
    "distribution-samples",
  );
});

function trace(variant, ordinal, durationMs = 4) {
  const document = productFirstInputDocument(variant, ordinal);
  const payload = productFirstInputPayload(document);
  const traceId = `00000000-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
  const start = 1_000 + ordinal * 20_000;
  const identity = {
    processId: EXPECTED.processId,
    clockId: EXPECTED.clockId,
    clockKind: "performance-now",
    generation: EXPECTED.generation,
    incarnation: EXPECTED.incarnation,
    semanticPaneId: EXPECTED.semanticPaneId,
    revision: ordinal + 1,
    stateHash: `hash-${ordinal + 1}`,
  };
  const baselineIdentity = {
    ...identity,
    revision: ordinal,
    stateHash: `hash-${ordinal}`,
  };
  const operations = [
    "lane-enqueue",
    "transport-send-start",
    "pane-stream-frame-enqueued",
    "pane-stream-socket-send-return",
    "pane-stream-next-event-loop-turn",
    "pane-stream-buffer-before-send",
    "pane-stream-buffer-after-send",
    "pane-stream-buffer-next-turn",
    "pane-stream-buffer-drain-watermark",
    "pane-stream-observer-returned",
    "transport-ack",
    "socket-frame-arrival",
    "delivery-received",
    "delivery-observer-returned",
    "canonical-apply-begin",
    "canonical-apply-end",
    "lane-published",
    "render-invalidated",
    "causal-cell-delivered",
    "causal-cell-painted",
  ];
  return [
    {
      type: "performance.input-queue-state",
      operation: "initialized",
      atMicros: start - 1,
      inputPending: 0,
      inputInFlight: 0,
      inputPendingBytes: 0,
      ...baselineIdentity,
    },
    {
      version: 1,
      type: "performance.input-origin",
      traceId,
      atMicros: start,
      origin: variant === "key" ? "keyboard" : "bracketed-paste",
      parserConsumption: variant === "key" ? "keyboard-event" : "paste-event",
      payloadByteCount: payload.byteLength,
      payloadFingerprint: productFirstInputFingerprint(
        EXPECTED.inputFingerprintKey,
        traceId,
        payload,
      ),
      ...baselineIdentity,
    },
    {
      type: "performance.stage",
      traceId,
      stage: "input",
      startedAtMicros: start,
      endedAtMicros: start + 10,
      authority: { generation: identity.generation, incarnation: identity.incarnation },
      ...identity,
    },
    ...operations.map((operation, index) => ({
      type: "performance.stage",
      traceId,
      stage: "client",
      operation,
      atMicros:
        operation === "causal-cell-delivered"
          ? start + 28
          : operation === "causal-cell-painted"
            ? start + 31
            : operation === "pane-stream-buffer-before-send"
              ? start + 4
              : operation === "pane-stream-buffer-after-send"
                ? start + 5
                : operation === "pane-stream-buffer-next-turn" ||
                    operation === "pane-stream-buffer-drain-watermark"
                  ? start + 16
                  : start + (index < 4 ? 2 + index : 12 + index),
      causalAttribution: operation === "causal-cell-painted" ? true : undefined,
      dirtyRowProved: operation === "causal-cell-painted" ? true : undefined,
      inputPending: operation === "transport-ack" ? 0 : undefined,
      inputInFlight: operation === "transport-ack" ? 0 : undefined,
      inputPendingBytes: operation === "transport-ack" ? 0 : undefined,
      bufferedAmount: operation.startsWith("pane-stream-buffer") ? 0 : undefined,
      frameBytes: operation.startsWith("pane-stream-buffer") ? 384 : undefined,
      drained: operation === "pane-stream-buffer-drain-watermark" ? true : undefined,
      row: operation === "causal-cell-painted" ? 0 : undefined,
      column: operation === "causal-cell-painted" ? 10 : undefined,
      beforeGrapheme: operation === "causal-cell-painted" ? " " : undefined,
      afterGrapheme:
        operation === "causal-cell-painted"
          ? String.fromCharCode(payload[payload.length - 1])
          : undefined,
      ...identity,
    })),
    {
      type: "performance.stage",
      traceId,
      stage: "paint",
      startedAtMicros: start + 30,
      endedAtMicros: start + durationMs * 1_000,
      paintStateIdentity: "latest-canonical-state-blitted",
      ...identity,
    },
    {
      type: "performance.input-fence",
      traceId,
      atMicros: start + durationMs * 1_000 + 1,
      writerHealth: { droppedRecords: 0, oversizedRecords: 0, failed: false },
      ...identity,
    },
  ];
}

function daemonTrace(ordinal = 0, acceptedBeforeEventLoop = false) {
  const traceId = `00000000-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
  const records = [
    ["pane-stream-socket-message-callback-entry", "transport", 98, 98],
    ["pane-stream-input-frame-ingress", "transport", 98, 98],
    ["raw-input-command", "tmux", 100, 104],
    ["control-write", "tmux", 101, 102],
    ["daemon-event-loop-turn", "transport", acceptedBeforeEventLoop ? 106 : 105, 106],
    [
      "control-command-accepted",
      "tmux",
      acceptedBeforeEventLoop ? 105 : 107,
      acceptedBeforeEventLoop ? 105 : 107,
    ],
    ["first-output-observed", "tmux", 108, 108],
    ["terminal-replica-write", "parse", 109, 110],
    ["terminal-replica-project-commit", "reduce", 111, 112],
    ["terminal-delivery-encode-enqueue", "transport", 113, 114],
    ["pane-stream-socket-send", "transport", 115, 116],
  ];
  return records.map(([operation, stage, startedAtMicros, endedAtMicros]) => ({
    type: "performance.stage",
    stage,
    operation,
    traceId,
    processId: "daemon:1",
    clockId: "daemon-performance-now",
    clockKind: "performance-now",
    startedAtMicros,
    endedAtMicros,
  }));
}

function withSharedClockEvidence(tui, daemon) {
  const calibration = {
    clockOffsetLowerMicros: 90,
    clockOffsetUpperMicros: 110,
    clockUncertaintyMicros: 20,
    clockCalibratedAtMicros: 900,
    clockCalibrationRequestId: "00000000-0000-4000-8000-000000000077",
  };
  const sendReturn = tui.find(({ operation }) => operation === "pane-stream-socket-send-return");
  const frameArrival = tui.find(({ operation }) => operation === "socket-frame-arrival");
  Object.assign(sendReturn, calibration, { sharedMicros: 1_000 });
  Object.assign(frameArrival, calibration, { sharedMicros: 1_220 });
  tui.unshift({
    version: 1,
    type: "performance.clock-calibration",
    processId: EXPECTED.processId,
    clockId: EXPECTED.clockId,
    clockKind: "performance-now",
    atMicros: 950,
    requestId: calibration.clockCalibrationRequestId,
    daemonInstanceId: EXPECTED.generation,
    reason: "calibrated",
    attemptedProbes: 5,
    receivedProbes: 5,
    validProbes: 5,
    selectedProbes: 1,
    selectedProbe: 3,
  });
  tui.push({
    ...sendReturn,
    operation: "pane-stream-input-ack-callback",
    atMicros: sendReturn.atMicros + 1,
    sharedMicros: 1_120,
  });
  const callback = daemon.find(
    ({ operation }) => operation === "pane-stream-socket-message-callback-entry",
  );
  const output = daemon.find(({ operation }) => operation === "pane-stream-socket-send");
  Object.assign(callback, { sharedStartedAtMicros: 1_110, sharedEndedAtMicros: 1_110 });
  Object.assign(output, { sharedStartedAtMicros: 1_290, sharedEndedAtMicros: 1_300 });
  daemon.push({
    ...callback,
    operation: "pane-stream-input-ack-socket-send",
    startedAtMicros: callback.startedAtMicros + 1,
    endedAtMicros: callback.endedAtMicros + 2,
    sharedStartedAtMicros: 1_190,
    sharedEndedAtMicros: 1_200,
  });
  return { tui, daemon };
}

test("shared clock evidence yields bounded one-way intervals and fails missing correlation", () => {
  const evidence = withSharedClockEvidence(trace("key", 0), daemonTrace());
  const expected = {
    ...EXPECTED,
    variant: "key",
    document: productFirstInputDocument("key", 0),
    daemonTraceRecords: evidence.daemon,
    requireDaemonEvidence: true,
    requireSharedClockEvidence: true,
  };
  const assessment = assessProductFirstInput(evidence.tui, expected);
  assert.ok(assessment.qualified);
  assert.deepEqual(
    assessment.predicates.find(({ id }) => id === "cross-process-clock-bounds"),
    {
      id: "cross-process-clock-bounds",
      passed: true,
      uncertaintyMicros: 20,
      outbound: { lowerMicros: 0, upperMicros: 20 },
      acknowledgement: { lowerMicros: 10, upperMicros: 30 },
      delivery: { lowerMicros: 10, upperMicros: 30 },
    },
  );
  const calibrationOutcome = evidence.tui.find(
    ({ type }) => type === "performance.clock-calibration",
  );
  calibrationOutcome.clockKind = "date-now";
  assert.equal(
    assessProductFirstInput(evidence.tui, expected).firstFailedPredicate,
    "clock-calibration",
  );
  calibrationOutcome.clockKind = "performance-now";

  const reconnectEvidence = withSharedClockEvidence(trace("key", 0), daemonTrace());
  reconnectEvidence.tui.unshift({
    ...reconnectEvidence.tui.find(({ type }) => type === "performance.clock-calibration"),
    requestId: "00000000-0000-4000-8000-000000000066",
    reason: "timeout-no-sample",
    attemptedProbes: 1,
    receivedProbes: 0,
    validProbes: 0,
    selectedProbes: 0,
    selectedProbe: null,
  });
  const reconnectExpected = {
    ...expected,
    daemonTraceRecords: reconnectEvidence.daemon,
  };
  assert.ok(assessProductFirstInput(reconnectEvidence.tui, reconnectExpected).qualified);
  reconnectEvidence.tui.unshift({
    ...reconnectEvidence.tui.find(
      ({ type, requestId }) =>
        type === "performance.clock-calibration" &&
        requestId === "00000000-0000-4000-8000-000000000077",
    ),
  });
  assert.equal(
    assessProductFirstInput(reconnectEvidence.tui, reconnectExpected).firstFailedPredicate,
    "clock-calibration",
  );
  delete evidence.tui.find(({ operation }) => operation === "pane-stream-input-ack-callback")
    .sharedMicros;
  assert.equal(
    assessProductFirstInput(evidence.tui, expected).firstFailedPredicate,
    "cross-process-clock-bounds",
  );
  for (const mutate of [
    ({ tui }) => {
      tui.find(({ operation }) => operation === "socket-frame-arrival").generation = "wrong";
    },
    ({ tui }) => {
      for (const record of tui.filter(({ stage }) => stage === "client"))
        if (record.clockUncertaintyMicros !== undefined) record.clockUncertaintyMicros = 5_001;
    },
    ({ tui }) => {
      tui.find(({ operation }) => operation === "socket-frame-arrival").sharedMicros = 60_001_000;
    },
    ({ tui }) => {
      for (const record of tui.filter(({ stage }) => stage === "client")) {
        if (record.clockOffsetLowerMicros === undefined) continue;
        record.clockOffsetLowerMicros = 120;
        record.clockOffsetUpperMicros = 110;
        record.clockUncertaintyMicros = -10;
      }
    },
    ({ daemon }) => {
      daemon.find(
        ({ operation }) => operation === "pane-stream-socket-message-callback-entry",
      ).sharedStartedAtMicros = Number.MAX_SAFE_INTEGER + 1;
    },
  ]) {
    const malformed = withSharedClockEvidence(trace("key", 0), daemonTrace());
    mutate(malformed);
    assert.equal(
      assessProductFirstInput(malformed.tui, {
        ...expected,
        daemonTraceRecords: malformed.daemon,
      }).firstFailedPredicate,
      "cross-process-clock-bounds",
    );
  }
});

test("failed calibration reports a bounded clock boundary instead of causal paint", async () => {
  const evidence = withSharedClockEvidence(trace("key", 0), daemonTrace());
  const outcome = evidence.tui.find(({ type }) => type === "performance.clock-calibration");
  Object.assign(outcome, {
    reason: "timeout-no-sample",
    attemptedProbes: 1,
    receivedProbes: 0,
    validProbes: 0,
    selectedProbes: 0,
    selectedProbe: null,
  });
  const expected = {
    ...EXPECTED,
    variant: "key",
    document: productFirstInputDocument("key", 0),
    daemonTraceRecords: evidence.daemon,
    requireDaemonEvidence: true,
    requireSharedClockEvidence: true,
  };
  let waits = 0;
  await assert.rejects(
    waitForProductInputQualification({
      readTuiRecords: () => evidence.tui,
      readDaemonRecords: () => evidence.daemon,
      assess: (records) => assessProductFirstInput(records, expected),
      qualify: (records) => qualifyProductFirstInput(records, expected),
      wait: async () => {
        waits += 1;
      },
    }),
    (error) => {
      assert.equal(error.boundary, "input-clock-calibration");
      assert.equal(error.observation.firstFailedPredicate, "clock-calibration");
      assert.deepEqual(
        error.observation.predicates.find(({ passed }) => !passed),
        {
          id: "clock-calibration",
          passed: false,
          outcomeCount: 1,
          reason: "timeout-no-sample",
          attemptedProbes: 1,
          receivedProbes: 0,
          validProbes: 0,
          selectedProbes: 0,
          selectedProbe: null,
        },
      );
      assert.ok(JSON.stringify(error.observation).length < 4_096);
      assert.doesNotMatch(JSON.stringify(error.observation), /[/\\]/u);
      return true;
    },
  );
  assert.equal(waits, 0);

  Object.assign(outcome, {
    reason: "x".repeat(1_000_000),
    attemptedProbes: "9".repeat(1_000_000),
  });
  const malformed = assessProductFirstInput(evidence.tui, expected);
  assert.equal(malformed.firstFailedPredicate, "clock-calibration");
  assert.deepEqual(
    malformed.predicates.find(({ passed }) => !passed),
    {
      id: "clock-calibration",
      passed: false,
      outcomeCount: 1,
      reason: "invalid",
      attemptedProbes: null,
      receivedProbes: 0,
      validProbes: 0,
      selectedProbes: 0,
      selectedProbe: null,
    },
  );
  assert.ok(JSON.stringify(malformed.predicates).length < 4_096);
});

function sealedProductionTraceShape() {
  const tui = trace("key", 0);
  const origin = tui.find(({ type }) => type === "performance.input-origin");
  origin.atMicros = 3_628_327;
  const input = tui.find(({ stage }) => stage === "input");
  input.startedAtMicros = 3_628_327;
  input.endedAtMicros = 3_629_549;
  const clientTimes = {
    "lane-enqueue": 3_628_680,
    "transport-send-start": 3_628_776,
    "pane-stream-frame-enqueued": 3_628_939,
    "pane-stream-socket-send-return": 3_629_510,
    "pane-stream-next-event-loop-turn": 3_629_671,
    "pane-stream-buffer-before-send": 3_628_939,
    "pane-stream-buffer-after-send": 3_629_510,
    "pane-stream-buffer-next-turn": 3_629_671,
    "pane-stream-buffer-drain-watermark": 3_629_671,
    "pane-stream-observer-returned": 3_629_700,
    "transport-ack": 3_631_428,
    "socket-frame-arrival": 3_635_833,
    "delivery-received": 3_636_378,
    "delivery-observer-returned": 3_636_400,
    "canonical-apply-begin": 3_636_401,
    "canonical-apply-end": 3_660_700,
    "lane-published": 3_660_741,
    "render-invalidated": 3_660_876,
    "causal-cell-delivered": 3_660_846,
    "causal-cell-painted": 3_661_168,
  };
  for (const record of tui)
    if (record.stage === "client") record.atMicros = clientTimes[record.operation];
  const paint = tui.find(({ stage }) => stage === "paint");
  paint.startedAtMicros = 3_661_131;
  paint.endedAtMicros = 3_661_329;
  tui.find(({ type }) => type === "performance.input-fence").atMicros = 3_661_385;
  const daemon = [
    ["pane-stream-socket-message-callback-entry", "transport", 5_899_390, 5_899_390],
    ["pane-stream-input-frame-ingress", "transport", 5_899_390, 5_899_390],
    ["control-write", "tmux", 5_899_747, 5_899_793],
    ["raw-input-command", "tmux", 5_899_430, 5_899_849],
    ["daemon-event-loop-turn", "transport", 5_899_852, 5_899_938],
    ["control-command-accepted", "tmux", 5_899_994, 5_899_994],
    ["first-output-observed", "tmux", 5_900_553, 5_900_553],
    ["terminal-replica-write", "parse", 5_900_622, 5_901_026],
    ["terminal-replica-project-commit", "reduce", 5_901_046, 5_902_216],
    ["terminal-delivery-encode-enqueue", "transport", 5_903_699, 5_904_392],
    ["pane-stream-socket-send", "transport", 5_904_437, 5_904_476],
  ].map(([operation, stage, startedAtMicros, endedAtMicros]) => ({
    type: "performance.stage",
    traceId: origin.traceId,
    operation,
    stage,
    processId: "daemon:93833",
    clockId: "node-performance-now",
    clockKind: "performance-now",
    startedAtMicros,
    endedAtMicros,
  }));
  return { tui, daemon };
}

test("strict documents distinguish one raw key from a multi-byte paste", () => {
  assert.deepEqual(productFirstInputDocument("key"), { version: 1, kind: "key", key: "x" });
  assert.deepEqual(productFirstInputDocument("paste"), {
    version: 1,
    kind: "paste",
    text: "PASTE0Q",
  });
  assert.throws(() => productFirstInputDocument("text"), /unsupported/u);
  assert.equal(productFirstInputDocument("paste", 0).text.at(-1), "Q");
  assert.equal(productFirstInputDocument("paste", 1).text.at(-1), "R");
});

test("distribution sample zero differs from the persistent first-input fixture cell", () => {
  for (const variant of ["key", "paste"]) {
    const first = productFirstInputPayload(productFirstInputDocument(variant, 0));
    const distributionFirst = productFirstInputPayload(productFirstInputDocument(variant, 1));
    assert.notEqual(first.at(-1), distributionFirst.at(-1));
  }
});

test("first input requires one exact parser origin and full ordered causal chain", () => {
  const records = trace("key", 0);
  assert.ok(
    qualifyProductFirstInput(records, {
      ...EXPECTED,
      document: productFirstInputDocument("key"),
    }),
  );
  const equalTimestampPostOrigin = structuredClone(records);
  const originIndex = equalTimestampPostOrigin.findIndex(
    ({ type }) => type === "performance.input-origin",
  );
  equalTimestampPostOrigin.splice(originIndex + 1, 0, {
    type: "performance.input-queue-state",
    operation: "post-origin-admission",
    atMicros: equalTimestampPostOrigin[originIndex].atMicros,
    inputPending: 0,
    inputInFlight: 1,
    inputPendingBytes: 1,
    processId: EXPECTED.processId,
  });
  assert.ok(
    qualifyProductFirstInput(equalTimestampPostOrigin, {
      ...EXPECTED,
      document: productFirstInputDocument("key"),
    }),
  );
  for (const mutate of [
    (copy) => copy.unshift(...trace("key", 8)),
    (copy) =>
      (copy.find(({ type }) => type === "performance.input-origin").origin = "bracketed-paste"),
    (copy) => (copy.find(({ type }) => type === "performance.input-origin").payloadByteCount = 2),
    (copy) =>
      (copy.find(({ type }) => type === "performance.input-origin").payloadFingerprint =
        productFirstInputFingerprint(
          EXPECTED.inputFingerprintKey,
          copy.find(({ type }) => type === "performance.input-origin").traceId,
          Buffer.from("XXXXXXQ"),
        )),
    (copy) =>
      (copy.find(({ operation }) => operation === "pane-stream-next-event-loop-turn").operation =
        "missing"),
    (copy) =>
      (copy.find(({ operation }) => operation === "pane-stream-observer-returned").operation =
        "missing"),
    (copy) =>
      (copy.find(({ operation }) => operation === "pane-stream-observer-returned").semanticPaneId =
        "wrong"),
    (copy) =>
      (copy.find(({ operation }) => operation === "pane-stream-buffer-drain-watermark").drained =
        false),
    (copy) =>
      (copy.find(({ operation }) => operation === "pane-stream-buffer-after-send").frameBytes =
        undefined),
    (copy) =>
      (copy.find(({ operation }) => operation === "pane-stream-buffer-after-send").atMicros =
        copy.find(({ operation }) => operation === "pane-stream-socket-send-return").atMicros - 1),
    (copy) =>
      (copy.find(({ operation }) => operation === "canonical-apply-begin").generation = "wrong"),
    (copy) =>
      (copy.find(({ operation }) => operation === "canonical-apply-end").atMicros =
        copy.find(({ operation }) => operation === "canonical-apply-begin").atMicros - 1),
    (copy) => (copy.find(({ operation }) => operation === "delivery-received").stage = "daemon"),
    (copy) =>
      (copy.find(({ operation }) => operation === "delivery-received").processId = "opentui:2"),
    (copy) =>
      (copy.find(({ operation }) => operation === "delivery-received").clockId = "other-clock"),
    (copy) =>
      (copy.find(({ operation }) => operation === "delivery-received").clockKind = "date-now"),
    (copy) =>
      (copy.find(({ operation }) => operation === "causal-cell-painted").stateHash = "wrong"),
    (copy) =>
      (copy.find(({ operation }) => operation === "causal-cell-painted").dirtyRowProved = false),
    (copy) => (copy.find(({ operation }) => operation === "transport-ack").inputInFlight = 1),
    (copy) => {
      const originIndex = copy.findIndex(({ type }) => type === "performance.input-origin");
      copy.splice(originIndex, 0, {
        type: "performance.input-queue-state",
        operation: "stale-nonzero",
        atMicros: copy[originIndex].atMicros - 0.5,
        inputPending: 1,
        inputInFlight: 0,
        inputPendingBytes: 1,
        processId: EXPECTED.processId,
      });
    },
    (copy) =>
      (copy.find(({ type }) => type === "performance.input-fence").writerHealth.failed = true),
    (copy) => (copy.find(({ stage }) => stage === "input").clockKind = "date-now"),
    (copy) => (copy.find(({ stage }) => stage === "paint").clockKind = undefined),
    (copy) => (copy.find(({ type }) => type === "performance.input-fence").clockKind = "date-now"),
    (copy) => (copy.find(({ type }) => type === "performance.input-fence").atMicros = undefined),
    (copy) => (copy.find(({ type }) => type === "performance.input-fence").atMicros = Number.NaN),
    (copy) =>
      (copy.find(({ type }) => type === "performance.input-queue-state").atMicros = undefined),
    (copy) =>
      (copy.find(({ type }) => type === "performance.input-queue-state").atMicros =
        copy.find(({ type }) => type === "performance.input-origin").atMicros + 1),
    (copy) =>
      (copy.find(({ operation }) => operation === "transport-ack").atMicros =
        copy.find(({ operation }) => operation === "lane-enqueue").atMicros - 1),
    (copy) => {
      const input = copy.find(({ stage }) => stage === "input");
      copy.find(({ stage }) => stage === "paint").endedAtMicros = input.startedAtMicros - 1;
    },
  ]) {
    const copy = structuredClone(records);
    mutate(copy);
    assert.equal(
      qualifyProductFirstInput(copy, {
        ...EXPECTED,
        document: productFirstInputDocument("key"),
      }),
      null,
    );
  }
});

test("first input fail-closes missing, reordered, or cross-clock daemon receipts", () => {
  const records = trace("key", 0);
  const base = {
    ...EXPECTED,
    document: productFirstInputDocument("key"),
    requireDaemonEvidence: true,
  };
  assert.ok(qualifyProductFirstInput(records, { ...base, daemonTraceRecords: daemonTrace() }));
  assert.equal(qualifyProductFirstInput(records, { ...base, daemonTraceRecords: [] }), null);
  const reordered = daemonTrace();
  reordered[4].startedAtMicros = 1;
  assert.equal(qualifyProductFirstInput(records, { ...base, daemonTraceRecords: reordered }), null);
  const crossClock = daemonTrace();
  crossClock[3].clockId = "other-clock";
  assert.equal(
    qualifyProductFirstInput(records, { ...base, daemonTraceRecords: crossClock }),
    null,
  );
  const wrongStage = daemonTrace();
  wrongStage[2].stage = "client";
  assert.equal(
    qualifyProductFirstInput(records, { ...base, daemonTraceRecords: wrongStage }),
    null,
  );
  const wrongClockKind = daemonTrace();
  wrongClockKind[2].clockKind = "date-now";
  assert.equal(
    qualifyProductFirstInput(records, { ...base, daemonTraceRecords: wrongClockKind }),
    null,
  );
  const negativeDuration = daemonTrace();
  negativeDuration[3].endedAtMicros = negativeDuration[3].startedAtMicros - 1;
  assert.equal(
    qualifyProductFirstInput(records, { ...base, daemonTraceRecords: negativeDuration }),
    null,
  );
});

test("assessor names production-shaped stage, persistence, and causal-order failures", () => {
  const cases = [
    {
      expected: "daemon-stage-identity",
      mutate(_tui, daemon) {
        daemon.find(({ operation }) => operation === "terminal-replica-write").stage = "daemon";
      },
    },
    {
      expected: "daemon-causal-order",
      mutate(_tui, daemon) {
        const output = daemon.find(({ operation }) => operation === "first-output-observed");
        output.startedAtMicros = 103;
        output.endedAtMicros = 103;
      },
    },
    {
      expected: "client-persistence-order",
      mutate(tui) {
        const invalidated = tui.findIndex(({ operation }) => operation === "render-invalidated");
        const delivered = tui.findIndex(({ operation }) => operation === "causal-cell-delivered");
        [tui[invalidated], tui[delivered]] = [tui[delivered], tui[invalidated]];
      },
    },
    {
      expected: "client-causal-order",
      mutate(tui) {
        const invalidated = tui.find(({ operation }) => operation === "render-invalidated");
        tui.find(({ operation }) => operation === "causal-cell-delivered").atMicros =
          invalidated.atMicros + 1;
      },
    },
  ];
  for (const { expected, mutate } of cases) {
    const tui = trace("key", 0);
    const daemon = daemonTrace();
    mutate(tui, daemon);
    const assessment = assessProductFirstInput(tui, {
      ...EXPECTED,
      document: productFirstInputDocument("key"),
      requireDaemonEvidence: true,
      daemonTraceRecords: daemon,
    });
    assert.equal(assessment.qualified, null);
    assert.equal(assessment.firstFailedPredicate, expected);
    assert.equal(assessment.terminal, true);
    assert.ok(assessment.predicates.length <= 24);
    assert.equal(JSON.stringify(assessment.predicates).includes(process.cwd()), false);
  }
});

test("distribution requires thirty same-variant distinct traces and enforces p95/p99", () => {
  const records = Array.from({ length: 30 }, (_, ordinal) => trace("paste", ordinal)).flat();
  const expected = {
    variant: "paste",
    processId: EXPECTED.processId,
    clockId: EXPECTED.clockId,
    semanticPaneId: EXPECTED.semanticPaneId,
    generation: EXPECTED.generation,
    incarnation: EXPECTED.incarnation,
    inputFingerprintKey: EXPECTED.inputFingerprintKey,
    startOrdinal: 0,
  };
  assert.deepEqual(qualifyProductInputDistribution(records, expected)?.sampleCount, 30);
  assert.equal(
    qualifyProductInputDistribution(records.slice(0, -trace("paste", 29).length), expected),
    null,
  );
  const mixed = structuredClone(records);
  mixed.find(({ type }) => type === "performance.input-origin").origin = "keyboard";
  assert.equal(qualifyProductInputDistribution(mixed, expected), null);
  const discontinuous = structuredClone(records);
  const secondOrigin = discontinuous.filter(({ type }) => type === "performance.input-origin")[1];
  secondOrigin.stateHash = "unrelated-baseline";
  assert.equal(qualifyProductInputDistribution(discontinuous, expected), null);
  const slow = Array.from({ length: 30 }, (_, ordinal) =>
    trace("paste", ordinal, ordinal === 29 ? 40 : 20),
  ).flat();
  const slowAssessment = assessProductInputDistribution(slow, expected);
  assert.equal(slowAssessment.qualified, null);
  assert.equal(slowAssessment.firstFailedPredicate, "distribution-samples");
  assert.equal(slowAssessment.terminal, true);
  assert.equal(slowAssessment.predicates.find(({ id }) => id === "distribution-samples").p99Ms, 40);
  assert.equal(qualifyProductInputDistribution(slow, expected), null);
});

test("slow terminal distribution fails immediately with bounded percentile evidence", async () => {
  const tui = Array.from({ length: 30 }, (_, ordinal) =>
    trace("paste", ordinal, ordinal === 29 ? 40 : 20),
  ).flat();
  const expected = {
    variant: "paste",
    processId: EXPECTED.processId,
    clockId: EXPECTED.clockId,
    semanticPaneId: EXPECTED.semanticPaneId,
    generation: EXPECTED.generation,
    incarnation: EXPECTED.incarnation,
    inputFingerprintKey: EXPECTED.inputFingerprintKey,
    startOrdinal: 0,
  };
  let waits = 0;
  await assert.rejects(
    waitForProductInputQualification({
      boundary: "distribution-samples",
      readTuiRecords: () => tui,
      readDaemonRecords: () => [],
      qualify: (records) => qualifyProductInputDistribution(records, expected),
      assess: (records) => assessProductInputDistribution(records, expected),
      wait: async () => {
        waits += 1;
      },
    }),
    (error) => {
      assert.equal(error.observation.firstFailedPredicate, "distribution-samples");
      const failed = error.observation.predicates.find(({ passed }) => !passed);
      assert.deepEqual(
        {
          id: failed.id,
          passed: failed.passed,
          sampleCount: failed.sampleCount,
          p95Ms: failed.p95Ms,
          p99Ms: failed.p99Ms,
        },
        {
          id: "distribution-samples",
          passed: false,
          sampleCount: 30,
          p95Ms: 20,
          p99Ms: 40,
        },
      );
      assert.equal(failed.topOutliers.length, 3);
      assert.equal(failed.topOutliers[0].ordinal, 29);
      return true;
    },
  );
  assert.equal(waits, 0);
});

test("malformed daemon stage evidence is enum-normalized before observation", () => {
  const tui = trace("key", 0);
  const daemon = daemonTrace();
  daemon.find(({ operation }) => operation === "raw-input-command").stage = "x".repeat(1_000_000);
  const assessment = assessProductFirstInput(tui, {
    ...EXPECTED,
    document: productFirstInputDocument("key"),
    requireDaemonEvidence: true,
    daemonTraceRecords: daemon,
  });
  assert.deepEqual(
    assessment.predicates.find(({ passed }) => !passed),
    {
      id: "daemon-stage-identity",
      passed: false,
      operation: "raw-input-command",
      expectedStage: "tmux",
      actualStage: "invalid",
      matchCount: 1,
    },
  );
  assert.ok(JSON.stringify(assessment.predicates).length < 4_096);
});
