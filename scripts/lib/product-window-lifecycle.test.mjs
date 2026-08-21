import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assessProductWindowLifecycle,
  assessWindowPresentationFrames,
  assessWindowSwitchPhaseTimingRecords,
  assessWindowLifecycleJourneyBoundaries,
  classifyWindowTmuxPostFailureSnapshot,
  joinWindowResourcesToTmuxLabels,
  ownedWindowActionFailureObservation,
  qualifyWindowWorkspaceState,
  summarizeWindowPartialRuntimeEvidence,
  summarizeWindowSwitchPhaseOutliers,
  windowApplicationShellTimeoutObservation,
  windowLifecycleWriterFailureObservation,
  windowSwitchSelectionFailureObservation,
  windowSwitchInputFailureObservation,
} from "./product-window-lifecycle.mjs";

test("classifies only one exact changed settled frame and rejects identical idle churn", () => {
  const expectedFrame = {
    kind: "window-switch",
    traceId: "11111111-1111-4111-8111-111111111111",
    target: "window.one",
    paneId: "pane.one",
    daemonGeneration: "daemon.one",
    clientGeneration: 2,
    rendererEpoch: 3,
    sourceEpoch: 4,
    generation: "terminal.one",
    incarnation: "incarnation.one",
    revision: 5,
    stateHash: "0123456789abcdef",
    cols: 132,
    rows: 41,
  };
  const window = {
    ...expectedFrame,
    target: undefined,
    paneId: undefined,
    targetIdentityDigest: createHash("sha256").update(expectedFrame.target).digest("hex"),
    paneIdentityDigest: createHash("sha256").update(expectedFrame.paneId).digest("hex"),
    presentationDigest: "a".repeat(64),
    presentationChanged: true,
    identityExact: true,
    targetVisible: true,
    settledTargetFrame: true,
  };
  const exact = assessWindowPresentationFrames([{ window }], expectedFrame);
  assert.equal(exact.classifiedFrameCount, 1);
  assert.equal(exact.settledTargetFrameCount, 1);
  assert.equal(exact.targetVisibleChangedFrameCount, 1);
  assert.equal(exact.identicalPostSettleFrameCount, 0);

  const receiptAfterPresentation = assessWindowPresentationFrames(
    [
      { window: { ...window, settledTargetFrame: false } },
      { window: { ...window, presentationChanged: false } },
    ],
    expectedFrame,
  );
  assert.equal(receiptAfterPresentation.targetVisibleChangedFrameCount, 1);
  assert.equal(receiptAfterPresentation.settledTargetFrameCount, 1);
  assert.equal(receiptAfterPresentation.identicalPostSettleFrameCount, 0);
  assert.equal(receiptAfterPresentation.identicalPreSettleFrameCount, 0);
  const duplicateBeforeReceipt = assessWindowPresentationFrames(
    [
      { window: { ...window, settledTargetFrame: false } },
      {
        window: { ...window, presentationChanged: false, settledTargetFrame: false },
      },
      { window: { ...window, presentationChanged: false } },
    ],
    expectedFrame,
  );
  assert.equal(duplicateBeforeReceipt.identicalPreSettleFrameCount, 1);
  const duplicateBeforePresentation = assessWindowPresentationFrames(
    [
      {
        window: {
          ...window,
          presentationChanged: false,
          targetVisible: false,
          settledTargetFrame: false,
        },
      },
      { window: { ...window, settledTargetFrame: false } },
      { window: { ...window, presentationChanged: false } },
    ],
    expectedFrame,
  );
  assert.equal(duplicateBeforePresentation.targetVisibleChangedFrameCount, 1);
  assert.equal(duplicateBeforePresentation.settledTargetFrameCount, 1);
  assert.equal(duplicateBeforePresentation.identicalPreSettleFrameCount, 1);

  const duplicate = assessWindowPresentationFrames(
    [{ window }, { window: { ...window, presentationChanged: false, settledTargetFrame: false } }],
    expectedFrame,
  );
  assert.equal(duplicate.identicalPostSettleFrameCount, 1);
  const stale = assessWindowPresentationFrames(
    [{ window: { ...window, rendererEpoch: expectedFrame.rendererEpoch + 1 } }],
    expectedFrame,
  );
  assert.equal(stale.unclassifiedFrameCount, 1);
  assert.equal(stale.settledTargetFrameCount, 0);
  assert.equal(
    assessWindowPresentationFrames(
      [{ window: { ...window, identityExact: false, settledTargetFrame: false } }],
      expectedFrame,
    ).invalidIdentityFrameCount,
    1,
  );
  assert.equal(
    assessWindowPresentationFrames([{ window: null }], expectedFrame).unclassifiedFrameCount,
    1,
  );
});

test("joins exact switch phases and rejects missing, nonmonotonic, wrong-op, or stale generation", () => {
  const identity = {
    traceId: "11111111-1111-4111-8111-111111111111",
    target: "window.one",
    paneId: "pane.one",
    daemonGeneration: "daemon.one",
    clientGeneration: 2,
    rendererEpoch: 3,
    sourceEpoch: 4,
    generation: "terminal.one",
    incarnation: "incarnation.one",
    revision: 5,
    stateHash: "0123456789abcdef",
    cols: 132,
    rows: 41,
    processId: "opentui:42",
    clockId: "opentui-performance-now",
  };
  const started = { ...identity, phase: "window-switch-start", startedAtMicros: 100 };
  const records = [
    {
      ...identity,
      phase: "window-switch-receipt",
      phaseAtMicros: 120,
      operationId: identity.traceId,
      selected: true,
      applied: true,
    },
    { ...identity, phase: "window-switch-layout", phaseAtMicros: 150 },
    { ...identity, phase: "window-switch-presentation", phaseAtMicros: 180 },
  ];
  const settled = { ...identity, phase: "window-switch-settled", phaseAtMicros: 210 };
  assert.deepEqual(assessWindowSwitchPhaseTimingRecords({ records, started, settled }), {
    qualified: true,
    firstFailedPredicate: null,
    timing: {
      startToSemanticReceiptMs: 0.02,
      startToCanonicalLayoutMs: 0.05,
      startToPresentationMs: 0.08,
      canonicalLayoutToPresentationMs: 0.03,
      presentationToActualFrameMs: 0.03,
      receiptLayoutOrder: "receipt-before-layout",
      totalMs: 0.11,
    },
  });
  assert.equal(
    assessWindowSwitchPhaseTimingRecords({ records: records.slice(1), started, settled })
      .firstFailedPredicate,
    "phase-cardinality",
  );
  const layoutBeforeReceipt = assessWindowSwitchPhaseTimingRecords({
    records: records.map((record, index) =>
      index === 0
        ? { ...record, phaseAtMicros: 170 }
        : index === 1
          ? { ...record, phaseAtMicros: 130 }
          : record,
    ),
    started,
    settled,
  });
  assert.equal(layoutBeforeReceipt.qualified, true);
  assert.equal(layoutBeforeReceipt.timing.receiptLayoutOrder, "layout-before-receipt");
  assert.equal(
    assessWindowSwitchPhaseTimingRecords({
      records: records.map((record, index) =>
        index === 1 ? { ...record, phaseAtMicros: 190 } : record,
      ),
      started,
      settled,
    }).firstFailedPredicate,
    "phase-monotonic",
  );
  assert.equal(
    assessWindowSwitchPhaseTimingRecords({
      records: records.map((record, index) =>
        index === 1 ? { ...record, traceId: "trace.other" } : record,
      ),
      started,
      settled,
    }).firstFailedPredicate,
    "phase-cardinality",
  );
  assert.equal(
    assessWindowSwitchPhaseTimingRecords({
      records: records.map((record, index) =>
        index === 0 ? { ...record, operationId: "22222222-2222-4222-8222-222222222222" } : record,
      ),
      started,
      settled,
    }).firstFailedPredicate,
    "phase-identity",
  );
  assert.equal(
    assessWindowSwitchPhaseTimingRecords({
      records: records.map((record, index) =>
        index === 2 ? { ...record, daemonGeneration: "daemon.stale" } : record,
      ),
      started,
      settled,
    }).firstFailedPredicate,
    "phase-identity",
  );
});

test("bounds owned action failures to a path-free typed predicate", () => {
  const operationId = "12345678-1234-4234-8234-123456789abc";
  assert.deepEqual(
    ownedWindowActionFailureObservation({
      action: "workspace.rename",
      operationId,
      status: 200,
      payload: {
        ok: false,
        error: {
          code: "operation_conflict",
          message: "/private/runtime/socket and secret content",
          details: { reason: "controller_conflict", path: "/private/runtime/socket" },
        },
      },
    }),
    {
      version: 1,
      operation: "window-owned-action",
      predicate: "action-result",
      action: "workspace.rename",
      operationId,
      status: 200,
      ok: false,
      resultPresent: false,
      code: "operation_conflict",
      reason: "controller_conflict",
      issueCount: 0,
    },
  );
  const malformed = ownedWindowActionFailureObservation({
    action: "x".repeat(1_000_000),
    operationId: "x".repeat(1_000_000),
    status: Number.MAX_SAFE_INTEGER,
    payload: {
      error: { code: "x".repeat(1_000_000), details: { reason: "x".repeat(1_000_000) } },
    },
  });
  assert.equal(JSON.stringify(malformed).length < 512, true);
  assert.equal(malformed.code, "invalid");
  assert.equal(malformed.reason, null);
  assert.equal(
    ownedWindowActionFailureObservation({
      action: "workspace.rename",
      operationId,
      status: 200,
      payload: { ok: false, result: {}, error: { code: "result_invalid" } },
    }).code,
    "result_invalid",
  );
});

test("distinguishes a readable changed tmux snapshot from an unavailable read", () => {
  const changedLabel = classifyWindowTmuxPostFailureSnapshot({
    status: "rejected",
    reason: {
      observation: {
        operation: "window-tmux-snapshot",
        expectedCount: 2,
        actualCount: 2,
        activeCount: 1,
      },
    },
  });
  assert.deepEqual(changedLabel, {
    tmuxAvailable: true,
    tmuxWindowCount: 2,
    tmuxPreActionStateExact: false,
  });
  assert.deepEqual(
    classifyWindowTmuxPostFailureSnapshot({
      status: "rejected",
      reason: new Error("tmux socket unavailable"),
    }),
    { tmuxAvailable: false, tmuxWindowCount: 0, tmuxPreActionStateExact: false },
  );
  assert.deepEqual(
    classifyWindowTmuxPostFailureSnapshot({ status: "fulfilled", value: [{}, {}] }),
    {
      tmuxAvailable: true,
      tmuxWindowCount: 2,
      tmuxPreActionStateExact: true,
    },
  );
});

const expected = {
  processId: "opentui:42",
  daemonGeneration: "daemon.one",
  clientGeneration: 1,
  workspaceName: "workspace.one",
  sessionName: "session.one",
  initial: {
    resourceId: "window.one",
    semanticWindowId: "raw.window.1",
    semanticPaneId: "pane.one",
    name: "one",
  },
  created: {
    resourceId: "window.two",
    semanticWindowId: "raw.window.2",
    semanticPaneId: "pane.two",
    name: "two",
  },
  renamedName: "renamed-two",
};
const identity = {
  processId: expected.processId,
  daemonGeneration: expected.daemonGeneration,
  clientGeneration: expected.clientGeneration,
  workspaceName: expected.workspaceName,
  sessionName: expected.sessionName,
};
const windowState = (window, active, name = window.name) => ({
  resourceId: window.resourceId,
  semanticPaneId: window.semanticPaneId,
  name,
  active,
});
const tmuxRows = (windows) =>
  windows.map((window, index) => ({
    nativeWindowId: `@${index + 1}`,
    resourceId: `raw.window.${index + 1}`,
    name: window.name,
    active: window.active,
    paneId: `%${index + 1}`,
    semanticPaneId: window.semanticPaneId,
    geometry: {
      windowCols: 132,
      windowRows: 41,
      left: 0,
      top: 0,
      cols: 132,
      rows: 41,
    },
  }));
function exactEvidence() {
  const baselineWindows = [windowState(expected.initial, true)];
  const createdWindows = [
    windowState(expected.initial, true),
    windowState(expected.created, false),
  ];
  const renamedWindows = [
    windowState(expected.initial, false),
    windowState(expected.created, true, expected.renamedName),
  ];
  const presentationWork = (digest) => ({
    version: 1,
    expectedTargetDigest: "c".repeat(64),
    expectedPaneDigest: "d".repeat(64),
    classifiedFrameCount: 1,
    unclassifiedFrameCount: 0,
    settledTargetFrameCount: 1,
    invalidIdentityFrameCount: 0,
    targetVisibleChangedFrameCount: 1,
    identicalPreSettleFrameCount: 0,
    identicalPostSettleFrameCount: 0,
    meaningfulPostSettleFrameCount: 0,
    settledPresentationDigest: digest,
  });
  return {
    baseline: {
      ...identity,
      terminalResourceRevision: 1,
      selected: windowState(expected.initial, true),
      windows: baselineWindows,
      tmux: tmuxRows(baselineWindows),
    },
    created: {
      ...identity,
      terminalResourceRevision: 2,
      operationId: "create.one",
      actionResult: {
        operationId: "create.one",
        daemonInstanceId: expected.daemonGeneration,
        outcome: "created",
        resource: {
          resourceVersion: 1,
          workspaceName: expected.workspaceName,
          semanticPaneId: expected.created.semanticPaneId,
          displayTitle: expected.created.name,
          kind: "terminal",
        },
      },
      selected: windowState(expected.created, false),
      windows: createdWindows,
      tmux: tmuxRows(createdWindows),
    },
    primed: {
      ...identity,
      traceId: "switch.prime",
      operationId: "switch.prime",
      selectionApplied: true,
      canonicalIdentity: {
        sourceEpoch: 1,
        generation: "daemon.one",
        incarnation: "incarnation.one",
        revision: 7,
        stateHash: "0123456789abcdef",
        cols: 132,
        rows: 41,
      },
      targetResourceId: expected.created.resourceId,
      visibleFrame: {
        resourceId: expected.created.resourceId,
        semanticPaneId: expected.created.semanticPaneId,
      },
      fence: {
        traceId: "switch.prime",
        writerHealth: { droppedRecords: 0, failed: false, pendingCriticalRecords: 0 },
      },
      delivery: { kind: "control-key", requestedKey: "t", bytesInjected: 1 },
      tmux: tmuxRows(
        createdWindows.map((window) => ({
          ...window,
          active: window.resourceId === expected.created.resourceId,
        })),
      ),
    },
    switches: Array.from({ length: 30 }, (_, ordinal) => {
      const target = ordinal % 2 === 0 ? expected.initial : expected.created;
      return {
        ...identity,
        ordinal,
        traceId: `switch.${ordinal}`,
        operationId: `switch.${ordinal}`,
        selectionApplied: true,
        followUpRequested: false,
        targetResourceId: target.resourceId,
        durationMs: ordinal + 1,
        phaseTiming: {
          startToSemanticReceiptMs: ordinal + 0.25,
          startToCanonicalLayoutMs: ordinal + 0.5,
          startToPresentationMs: ordinal + 0.75,
          canonicalLayoutToPresentationMs: 0.25,
          presentationToActualFrameMs: 0.25,
          receiptLayoutOrder: "receipt-before-layout",
          totalMs: ordinal + 1,
          daemon: {
            semantic_pane_inventory_lookupMs: 0.2,
            semantic_pane_resolutionMs: 0.1,
            tmux_selection_effect_proofMs: 0.4,
            semantic_mutation_effectMs: 0.8,
          },
        },
        visibleFrame: {
          resourceId: target.resourceId,
          semanticPaneId: target.semanticPaneId,
        },
        fence: {
          traceId: `switch.${ordinal}`,
          writerHealth: { droppedRecords: 0, failed: false, pendingCriticalRecords: 0 },
        },
        delivery: {
          kind: "control-key",
          requestedKey: "t",
          delivery: "exact-bytes-to-immutable-host-pane-pty",
          bytesInjected: 1,
          phases: 1,
        },
        renderWork: {
          terminalPaintCount: 0,
          canonicalPublicationCount: 0,
          canonicalPaintCount: 0,
          canonicalUpdateCount: 0,
          frameCount: 1,
          presentation: presentationWork("e".repeat(64)),
          eventCount: 1,
          traceDigest: "a".repeat(64),
          stableSamples: 2,
          quietDurationMs: 300,
          quiet: true,
        },
        tmux: tmuxRows(
          renamedWindows.map((window) => ({
            ...window,
            active: window.resourceId === target.resourceId,
          })),
        ),
      };
    }),
    renamed: {
      ...identity,
      terminalResourceRevision: 2,
      acknowledgementWatermark: 11,
      operationId: "rename.one",
      actionResult: {
        operationId: "rename.one",
        daemonInstanceId: expected.daemonGeneration,
        outcome: "applied",
        verb: "workspace.rename",
        scope: "window",
        name: expected.renamedName,
        workspaceName: expected.workspaceName,
      },
      selected: windowState(expected.created, true, expected.renamedName),
      windows: renamedWindows,
      tmux: tmuxRows(renamedWindows),
      workspaceClient: {
        committed: {
          lastResourceChangeAcknowledgement: {
            daemonInstanceId: expected.daemonGeneration,
            operationId: "rename.one",
            sequence: 12,
            revision: 9,
          },
        },
        pending: [],
        derived: {
          terminalInventory: {
            activeResourceId: expected.created.resourceId,
            resources: [
              { id: expected.initial.resourceId, title: expected.initial.name, active: false },
              { id: expected.created.resourceId, title: expected.renamedName, active: true },
            ],
          },
        },
      },
      presentation: {
        traceId: "rename.one",
        started: {
          traceId: "rename.one",
          target: expected.created.semanticWindowId,
          paneId: expected.created.semanticPaneId,
          windowName: expected.renamedName,
          sourceEpoch: 1,
          generation: "daemon.one",
          incarnation: "incarnation.one",
          revision: 7,
          stateHash: "0123456789abcdef",
          cols: 132,
          rows: 41,
        },
        presented: { traceId: "rename.one" },
        fence: {
          traceId: "rename.one",
          writerHealth: { droppedRecords: 0, failed: false, pendingCriticalRecords: 0 },
        },
        renderWork: {
          terminalPaintCount: 0,
          canonicalPublicationCount: 0,
          canonicalPaintCount: 0,
          canonicalUpdateCount: 0,
          frameCount: 1,
          presentation: presentationWork("f".repeat(64)),
          traceDigest: "b".repeat(64),
          stableSamples: 2,
          quietDurationMs: 300,
          quiet: true,
        },
      },
    },
    correlation: { daemon: true, workspaceClient: true, tui: true, web: true, tmux: true },
    web: {
      semantic: {
        windows: [
          { windowResourceId: "window.one", label: "one", active: "false" },
          { windowResourceId: "window.two", label: "renamed-two", active: "true" },
        ],
      },
    },
  };
}

test("qualifies an exact create switch visible-frame rename lifecycle", () => {
  const assessment = assessProductWindowLifecycle({ evidence: exactEvidence(), expected });
  assert.equal(assessment.qualified, true);
  assert.equal(assessment.metrics.sampleCount, 30);
  assert.equal(assessment.metrics.p95Ms, 29);
});

test("seals bounded phase outliers and rejects missing or inconsistent switch timing", () => {
  const evidence = exactEvidence();
  evidence.switches[3].durationMs = 151.458;
  evidence.switches[3].phaseTiming = {
    startToSemanticReceiptMs: 25,
    startToCanonicalLayoutMs: 125,
    startToPresentationMs: 145,
    canonicalLayoutToPresentationMs: 20,
    presentationToActualFrameMs: 6.458,
    receiptLayoutOrder: "receipt-before-layout",
    totalMs: 151.458,
    daemon: {
      semantic_pane_inventory_lookupMs: 1,
      semantic_pane_resolutionMs: 0.2,
      tmux_selection_effect_proofMs: 4,
      semantic_mutation_effectMs: 5.5,
    },
  };
  const outliers = summarizeWindowSwitchPhaseOutliers(evidence.switches, 1);
  assert.deepEqual(outliers, [
    {
      ordinal: 3,
      totalMs: 151.458,
      startToSemanticReceiptMs: 25,
      startToCanonicalLayoutMs: 125,
      startToPresentationMs: 145,
      canonicalLayoutToPresentationMs: 20,
      presentationToActualFrameMs: 6.458,
      receiptLayoutOrder: "receipt-before-layout",
      daemonSemanticMutationMs: 5.5,
      daemonInventoryLookupMs: 1,
      daemonPaneResolutionMs: 0.2,
      daemonTmuxSelectionProofMs: 4,
    },
  ]);
  assert.equal(JSON.stringify(outliers).includes("traceId"), false);

  const missing = exactEvidence();
  delete missing.switches[0].phaseTiming;
  assert.equal(assessProductWindowLifecycle({ evidence: missing, expected }).metrics.p95Ms, null);

  const inconsistent = exactEvidence();
  inconsistent.switches[0].phaseTiming.startToCanonicalLayoutMs = -1;
  const assessment = assessProductWindowLifecycle({ evidence: inconsistent, expected });
  assert.equal(assessment.firstFailedPredicate, "window-switch-samples");
  assert.equal(assessment.metrics.p95Ms, null);
});

test("replays the sealed r1 and r5 duration distributions into capped top phase vectors", () => {
  const runs = [
    [
      73.856, 135.702, 75.787, 179.078, 73.026, 76.77, 135.948, 72.42, 136.135, 76.597, 137.696,
      82.52, 78.013, 142.174, 85.143, 151.458, 79.014, 133.373, 76.082, 76.826, 135.685, 71.893,
      107.181, 81.409, 74.26, 139.761, 75.147, 139.102, 72.871, 144.67,
    ],
    [
      75.199, 137.649, 73.655, 131.1, 82.487, 154.343, 73.593, 74.35, 137.463, 78.717, 125.108,
      75.622, 151.838, 74.516, 71.731, 107.262, 73.462, 136.938, 76.699, 133.178, 73.093, 77.329,
      137.947, 78.647, 121.653, 76.921, 81.152, 138.328, 72.669, 135.326,
    ],
  ];
  const top = runs.map((durations) =>
    summarizeWindowSwitchPhaseOutliers(
      durations.map((durationMs, ordinal) => ({
        ordinal,
        durationMs,
        phaseTiming: {
          startToSemanticReceiptMs: durationMs,
          startToCanonicalLayoutMs: 0,
          startToPresentationMs: 0,
          canonicalLayoutToPresentationMs: 0,
          presentationToActualFrameMs: durationMs,
          receiptLayoutOrder: "layout-before-receipt",
          totalMs: durationMs,
          daemon: {
            semantic_pane_inventory_lookupMs: 0,
            semantic_pane_resolutionMs: 0,
            tmux_selection_effect_proofMs: 0,
            semantic_mutation_effectMs: 0,
          },
        },
      })),
      2,
    ),
  );
  assert.deepEqual(
    top.map((entries) => entries.map(({ ordinal, totalMs }) => ({ ordinal, totalMs }))),
    [
      [
        { ordinal: 3, totalMs: 179.078 },
        { ordinal: 15, totalMs: 151.458 },
      ],
      [
        { ordinal: 5, totalMs: 154.343 },
        { ordinal: 12, totalMs: 151.838 },
      ],
    ],
  );
});

test("retains the exact duration distribution when frame causality fails closed", () => {
  const evidence = exactEvidence();
  evidence.switches[0].renderWork.presentation.identicalPostSettleFrameCount = 1;
  const assessment = assessProductWindowLifecycle({ evidence, expected });
  assert.equal(assessment.qualified, false);
  assert.equal(assessment.metrics.sampleCount, 30);
  assert.equal(assessment.metrics.p95Ms, 29);
  assert.equal(
    assessment.predicates.find(({ id }) => id === "window-switch-p95-budget")?.passed,
    true,
  );
  assert.equal(
    assessment.predicates.find(({ id }) => id === "window-switch-visible-frame")?.passed,
    false,
  );
});

test("refuses latency credit when non-render switch causality is malformed", () => {
  for (const mutate of [
    (evidence) => (evidence.switches[0].operationId = "operation.wrong"),
    (evidence) => (evidence.switches[1].traceId = evidence.switches[0].traceId),
  ]) {
    const evidence = exactEvidence();
    mutate(evidence);
    const assessment = assessProductWindowLifecycle({ evidence, expected });
    assert.equal(assessment.qualified, false);
    assert.equal(assessment.metrics.sampleCount, 0);
    assert.equal(assessment.metrics.p95Ms, null);
    assert.equal(
      assessment.predicates.find(({ id }) => id === "window-switch-p95-budget")?.passed,
      false,
    );
  }
});

test("bounds a path-free application-shell cardinality timeout observation", () => {
  const observation = windowApplicationShellTimeoutObservation({
    resources: [
      {
        resourceId: "window.one",
        windowResourceId: "group.one",
        semanticPaneId: "pane.one",
        active: true,
      },
      {
        resourceId: "window.two",
        windowResourceId: "group.two",
        semanticPaneId: "pane.two",
        active: false,
      },
    ],
    expectedCount: 1,
    attempts: 99_999,
    elapsedMs: 10_004.9,
    revision: 7,
  });
  assert.deepEqual(
    {
      ...observation,
      identityDigest: observation.identityDigest.replace(/./gu, "a"),
    },
    {
      operation: "window-application-shell-wait",
      reason: "timeout",
      samples: 10_000,
      elapsedMs: 10_004,
      expectedCount: 1,
      actualCount: 2,
      activeCount: 1,
      revision: 7,
      identityDigest: "a".repeat(64),
    },
  );
  assert.doesNotMatch(JSON.stringify(observation), /[/\\]|window\.one|pane\.one/u);
});

test("joins live-shaped generic resource titles to exact tmux window labels", () => {
  const rawWindowId = "raw.window.1";
  const resource = {
    resourceId: "pane.one",
    windowResourceId: `terminal-window.${createHash("sha256")
      .update(rawWindowId)
      .digest("hex")
      .slice(0, 20)}`,
    semanticPaneId: "pane.one",
    resourceTitle: "Terminal",
    active: true,
  };
  const tmux = {
    resourceId: rawWindowId,
    semanticPaneId: "pane.one",
    name: "one",
  };
  const joined = joinWindowResourcesToTmuxLabels([resource], [tmux]);
  assert.equal(joined[0].resourceTitle, "Terminal");
  assert.equal(joined[0].name, "one");
  assert.throws(() =>
    joinWindowResourcesToTmuxLabels([resource], [{ ...tmux, semanticPaneId: "pane.wrong" }]),
  );
  assert.throws(() => joinWindowResourcesToTmuxLabels([resource], [tmux, tmux]));
});

test("summarizes relocated partial WC and TUI evidence without raw identity or content", () => {
  const lifecycleRecords = [
    { phase: "layout-publication", windows: 2, panes: 1, monotonicMicros: 10 },
    {
      phase: "generation-shell-lifecycle",
      shellStatus: "live",
      inventoryResources: 2,
      monotonicMicros: 11,
    },
    {
      phase: "generation-workspace-client-state",
      processId: "opentui:42",
      daemonGeneration: "daemon.one",
      workspaceClient: {
        committed: {
          phase: "live",
          generation: 1,
          terminalResourceRevision: 0,
          terminalResources: [{}, {}],
          authority: {
            revision: 23,
            owners: { input: null, focus: null, geometry: null },
            clients: [{ surface: "opentui", state: "foreground" }],
          },
        },
        pending: [],
        derived: { terminalInventory: { resources: [{}, {}] } },
      },
    },
    { phase: "first-terminal-frame" },
  ];
  const referenceRecords = [
    { type: "performance.frame", secret: "/private/path" },
    { type: "performance.terminal-paint", grapheme: "secret" },
  ];
  const summary = summarizeWindowPartialRuntimeEvidence({
    lifecycleText: lifecycleRecords.map(JSON.stringify).join("\n"),
    lifecycleRecords,
    referenceText: referenceRecords.map(JSON.stringify).join("\n"),
    referenceRecords,
  });
  assert.equal(summary.lifecycle.latestShell.inventoryResources, 2);
  assert.equal(summary.lifecycle.latestWorkspaceClient.committedResourceCount, 2);
  assert.equal(summary.lifecycle.latestWorkspaceClient.derivedResourceCount, 2);
  assert.equal(summary.lifecycle.latestWorkspaceClient.authorityRevision, 23);
  assert.equal(summary.lifecycle.latestWorkspaceClient.authorityOwnerCount, 0);
  assert.deepEqual(summary.lifecycle.latestWorkspaceClient.authorityOwnerPresence, {
    input: false,
    focus: false,
    geometry: false,
  });
  assert.equal(summary.lifecycle.latestWorkspaceClient.opentuiClientState, "foreground");
  assert.equal(summary.lifecycle.layoutPublicationCount, 1);
  assert.equal(summary.referenceTrace.frameCount, 1);
  assert.equal(summary.referenceTrace.terminalPaintCount, 1);
  assert.doesNotMatch(JSON.stringify(summary), /private|secret|daemon\.one|opentui:42/u);
});

test("rejects each stale malformed missing or over-budget lifecycle boundary", () => {
  const mutations = [
    (value) => (value.baseline.processId = "opentui:wrong"),
    (value) => value.baseline.windows.push(windowState(expected.created, false)),
    (value) => (value.created.actionResult.outcome = "replayed"),
    (value) => (value.created.terminalResourceRevision = value.baseline.terminalResourceRevision),
    (value) => (value.created.selected.semanticPaneId = "pane.wrong"),
    (value) => (value.primed.fence.traceId = "switch.wrong"),
    (value) => value.switches.pop(),
    (value) => (value.switches[4].traceId = value.switches[3].traceId),
    (value) => (value.switches[7].targetResourceId = expected.initial.resourceId),
    (value) => (value.switches[8].visibleFrame.resourceId = expected.created.resourceId),
    (value) => (value.switches[9].fence.traceId = "switch.wrong"),
    (value) => (value.switches[10].fence.writerHealth.droppedRecords = 1),
    (value) => (value.switches[11].fence.writerHealth.pendingCriticalRecords = 1),
    (value) => (value.switches[12].renderWork.terminalPaintCount = 1),
    (value) => (value.switches[13].renderWork.canonicalPublicationCount = 1),
    (value) => (value.switches[14].renderWork.quietDurationMs = 299),
    (value) => delete value.switches[15].renderWork.presentation,
    (value) => (value.switches[16].renderWork.presentation.unclassifiedFrameCount = 1),
    (value) => (value.switches[16].renderWork.presentation.invalidIdentityFrameCount = 1),
    (value) => (value.switches[17].renderWork.presentation.settledTargetFrameCount = 0),
    (value) => (value.switches[18].renderWork.presentation.identicalPostSettleFrameCount = 1),
    (value) => (value.switches[18].renderWork.presentation.identicalPreSettleFrameCount = 1),
    (value) => (value.switches[19].renderWork.presentation.settledPresentationDigest = null),
    (value) => (value.switches[12].fence.writerHealth.failed = true),
    (value) => (value.switches[13].delivery.bytesInjected = 2),
    (value) =>
      (value.switches[14].tmux.find(
        ({ semanticPaneId }) => semanticPaneId === expected.created.semanticPaneId,
      ).name = expected.created.name),
    (value) => (value.switches[0].durationMs = -1),
    (value) => value.switches.forEach((sample) => (sample.durationMs = 151)),
    (value) => (value.renamed.actionResult.operationId = "rename.wrong"),
    (value) => (value.renamed.presentation.renderWork.quietDurationMs = 299),
    (value) =>
      (value.renamed.presentation.renderWork.presentation.identicalPostSettleFrameCount = 1),
    (value) => (value.renamed.selected.name = "stale"),
    (value) =>
      (value.renamed.terminalResourceRevision = value.created.terminalResourceRevision + 1),
    (value) =>
      (value.renamed.workspaceClient.committed.lastResourceChangeAcknowledgement.operationId =
        "rename.wrong"),
    (value) => (value.renamed.workspaceClient.pending = [{}]),
    (value) =>
      (value.renamed.workspaceClient.derived.terminalInventory.resources[1].title = "stale"),
    (value) => (value.correlation.web = false),
    (value) => (value.web.semantic.windows[1].label = "stale"),
    (value) => value.web.semantic.windows.push({ ...value.web.semantic.windows[0] }),
  ];
  for (const mutate of mutations) {
    const evidence = exactEvidence();
    mutate(evidence);
    assert.equal(assessProductWindowLifecycle({ evidence, expected }).qualified, false);
  }
});

test("reports the earliest exact ordered journey boundary", () => {
  const phases = [
    "window-namespace-ready",
    "window-daemon-ready",
    "window-tui-build",
    "window-tui-started",
    "window-host-ready",
    "window-tui-coherent",
    "window-baseline",
    "window-create-proved",
    "window-switch-visible",
    "window-rename-visible",
    "window-switch-distribution",
    "window-web-correlation",
  ];
  const passed = assessWindowLifecycleJourneyBoundaries({
    timeline: phases.map((phase) => ({ phase })),
    assessment: assessProductWindowLifecycle({ evidence: exactEvidence(), expected }),
    correlationComplete: true,
  });
  assert.equal(passed.status, "passed");
  const failed = assessWindowLifecycleJourneyBoundaries({
    timeline: phases
      .filter((phase) => phase !== "window-create-proved")
      .map((phase) => ({ phase })),
    assessment: { qualified: true },
    correlationComplete: true,
  });
  assert.equal(failed.firstBrokenBoundary, "window-create-proved");
});

test("qualifies only the latest exact same-record window WorkspaceClient projection", () => {
  const resources = [
    {
      resourceId: "window.one",
      semanticPaneId: "pane.one",
      resourceTitle: "Lifecycle One",
      active: false,
    },
    {
      resourceId: "window.two",
      semanticPaneId: "pane.two",
      resourceTitle: "Lifecycle Two",
      active: true,
    },
  ];
  const record = {
    phase: "generation-workspace-client-state",
    processId: expected.processId,
    daemonGeneration: expected.daemonGeneration,
    monotonicMicros: 10,
    workspaceClient: {
      committed: {
        generation: expected.clientGeneration,
        phase: "live",
        target: {
          daemon: { instanceId: expected.daemonGeneration },
          workspaceName: expected.workspaceName,
        },
        authorityWorkspaceId: "workspace.id",
        authorityWorkspaceName: "Workspace",
        terminalResourceRevision: 7,
        lastReceipt: {
          type: "interaction.receipt",
          operationId: "12345678-1234-4234-8234-123456789abc",
          operationKind: "workspace.pane.select",
          phase: "observed",
          resourceRevision: null,
          proof: {
            operationKind: "workspace.pane.select",
            outcome: "applied",
            semanticPaneId: "pane.two",
          },
        },
        authority: {
          generation: expected.daemonGeneration,
          session: expected.sessionName,
          owners: {
            input: expected.processId,
            focus: expected.processId,
            geometry: expected.processId,
          },
          clients: [{ clientId: expected.processId, surface: "opentui", state: "foreground" }],
        },
        terminalResources: resources,
      },
      pending: [],
      derived: {
        workspace: { id: "workspace.id", name: "Workspace" },
        terminalInventory: {
          activeResourceId: "window.two",
          resources: resources.map(({ resourceId, semanticPaneId, resourceTitle, active }) => ({
            id: resourceId,
            title: resourceTitle,
            active,
            attachability: { status: "available", semanticPaneId },
          })),
        },
      },
    },
  };
  const expectedState = {
    ...identity,
    clientId: expected.processId,
    afterMicros: 9,
    boundary: "window-create",
    resources,
    web: false,
    minimumTerminalResourceRevision: 7,
    receipt: {
      operationId: "12345678-1234-4234-8234-123456789abc",
      operationKind: "workspace.pane.select",
      semanticPaneId: "pane.two",
    },
  };
  const qualified = qualifyWindowWorkspaceState([record], expectedState);
  assert.equal(qualified.record, record);
  assert.equal(qualified.committed, record.workspaceClient.committed);
  const staleValid = structuredClone(record);
  staleValid.monotonicMicros = 11;
  const latestInvalid = structuredClone(record);
  latestInvalid.monotonicMicros = 12;
  latestInvalid.workspaceClient.derived.terminalInventory.resources.pop();
  assert.throws(() => qualifyWindowWorkspaceState([staleValid, latestInvalid], expectedState));
  const staleRevision = structuredClone(record);
  staleRevision.workspaceClient.committed.terminalResourceRevision = 6;
  assert.throws(() => qualifyWindowWorkspaceState([staleRevision], expectedState));
  const wrongReceipt = structuredClone(record);
  wrongReceipt.workspaceClient.committed.lastReceipt.operationId =
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.throws(() => qualifyWindowWorkspaceState([wrongReceipt], expectedState));
  const staleActive = structuredClone(record);
  staleActive.workspaceClient.committed.terminalResources =
    staleActive.workspaceClient.committed.terminalResources.map((resource) => ({
      ...resource,
      active: resource.resourceId === "window.one",
    }));
  staleActive.workspaceClient.derived.terminalInventory.resources =
    staleActive.workspaceClient.derived.terminalInventory.resources.map((resource) => ({
      ...resource,
      active: resource.id === "window.one",
    }));
  staleActive.workspaceClient.derived.terminalInventory.activeResourceId = "window.one";
  assert.throws(
    () => qualifyWindowWorkspaceState([staleActive], expectedState),
    (error) => {
      assert.deepEqual(error.observation, {
        operation: "qualify-window-workspace-client",
        firstFailedPredicate: "resources",
        matches: 1,
        phaseExact: true,
        targetDaemonExact: true,
        targetWorkspaceExact: true,
        workspaceIdentityExact: true,
        authorityGenerationExact: true,
        authoritySessionExact: true,
        pendingExact: true,
        committedDerivedExact: true,
        resourcesExact: false,
        titlesExact: true,
        expectedActiveCount: 1,
        committedActiveCount: 1,
        derivedActiveCount: 1,
        activeResourceExact: false,
        clientsExact: true,
        tuiClientSurfaceExact: true,
        tuiClientStateExact: true,
        authorityOwnersExact: true,
        authorityOwnerCount: 3,
        authorityOwnerPresence: { input: true, focus: true, geometry: true },
        receiptExact: true,
        acknowledgementPresent: false,
        acknowledgementDaemonExact: true,
        acknowledgementOperationExact: true,
        acknowledgementSequenceNewer: true,
        acknowledgementRevisionSafe: true,
        generationExact: true,
        revisionExact: true,
      });
      return true;
    },
  );
  const authorityLost = structuredClone(record);
  authorityLost.workspaceClient.committed.authority.owners = {
    input: null,
    focus: null,
    geometry: null,
  };
  assert.throws(
    () => qualifyWindowWorkspaceState([authorityLost], expectedState),
    (error) => {
      assert.equal(error.observation.firstFailedPredicate, "authority-owners");
      assert.equal(error.observation.authorityOwnersExact, false);
      assert.equal(error.observation.authorityOwnerCount, 0);
      assert.deepEqual(error.observation.authorityOwnerPresence, {
        input: false,
        focus: false,
        geometry: false,
      });
      return true;
    },
  );

  const renameOperationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const renamed = structuredClone(record);
  renamed.monotonicMicros = 20;
  renamed.workspaceClient.committed.lastResourceChangeAcknowledgement = {
    daemonInstanceId: expected.daemonGeneration,
    operationId: renameOperationId,
    sequence: 12,
    revision: 9,
  };
  renamed.workspaceClient.committed.terminalResources[1].resourceTitle = "Lifecycle Renamed";
  renamed.workspaceClient.derived.terminalInventory.resources[1].title = "Lifecycle Renamed";
  const renameExpected = {
    ...expectedState,
    afterMicros: 19,
    receipt: undefined,
    minimumTerminalResourceRevision: undefined,
    exactTerminalResourceRevision: 7,
    acknowledgement: {
      daemonInstanceId: expected.daemonGeneration,
      operationId: renameOperationId,
      afterSequence: 11,
    },
    resources: resources.map((resource) =>
      resource.resourceId === "window.two"
        ? { ...resource, resourceTitle: "Lifecycle Renamed" }
        : resource,
    ),
  };
  assert.equal(qualifyWindowWorkspaceState([renamed], renameExpected).record, renamed);
  for (const mutate of [
    (candidate) => {
      candidate.workspaceClient.committed.lastResourceChangeAcknowledgement.operationId =
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    },
    (candidate) => {
      candidate.workspaceClient.committed.lastResourceChangeAcknowledgement.daemonInstanceId =
        "daemon.stale";
    },
    (candidate) => {
      candidate.workspaceClient.committed.lastResourceChangeAcknowledgement.sequence = 11;
    },
    (candidate) => {
      candidate.workspaceClient.committed.lastResourceChangeAcknowledgement.revision = -1;
    },
    (candidate) => {
      candidate.workspaceClient.committed.terminalResourceRevision = 8;
    },
    (candidate) => {
      candidate.workspaceClient.derived.terminalInventory.resources[1].title = "Stale title";
    },
  ]) {
    const candidate = structuredClone(renamed);
    mutate(candidate);
    assert.throws(() => qualifyWindowWorkspaceState([candidate], renameExpected));
  }
});

test("window switch selection failures seal a bounded named predicate", () => {
  assert.deepEqual(
    windowSwitchSelectionFailureObservation(
      { stage: "dispatch", reason: "transport-rejected", message: "sensitive" },
      1,
      1,
      1,
    ),
    {
      version: 1,
      operation: "window-switch",
      predicate: "selection-receipt",
      stage: "dispatch",
      reason: "transport-rejected",
      backendReason: null,
      startCount: 1,
      receiptCount: 1,
      failureCount: 1,
      selected: false,
      applied: false,
    },
  );
  assert.deepEqual(
    windowSwitchSelectionFailureObservation(
      { stage: "x".repeat(1_000_000), reason: "y".repeat(1_000_000) },
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ),
    {
      version: 1,
      operation: "window-switch",
      predicate: "selection-receipt",
      stage: "invalid",
      reason: "invalid",
      backendReason: null,
      startCount: 2,
      receiptCount: 2,
      failureCount: 2,
      selected: false,
      applied: false,
    },
  );
  assert.equal(
    windowSwitchSelectionFailureObservation(
      {
        stage: "dispatch",
        reason: "transport-rejected",
        backendReason: "pane_inventory_not_ready",
        message: "sensitive",
      },
      1,
      0,
      1,
    ).backendReason,
    "pane_inventory_not_ready",
  );
});

test("window switch input failures retain the exact prime or distribution caller", () => {
  assert.deepEqual(
    windowSwitchInputFailureObservation({
      boundary: "window-switch-visible",
      ordinal: 9,
      reason: "command-timeout",
      timeoutMs: 2_000,
    }),
    {
      version: 1,
      operation: "window-switch-input",
      predicate: "hosted-control-key",
      boundary: "window-switch-visible",
      stage: "window-switch-visible",
      ordinal: null,
      reason: "command-timeout",
      timeoutMs: 2_000,
    },
  );
  assert.deepEqual(
    windowSwitchInputFailureObservation({
      boundary: "window-switch-distribution",
      ordinal: 17,
      reason: "aborted",
      timeoutMs: 2_000,
    }),
    {
      version: 1,
      operation: "window-switch-input",
      predicate: "hosted-control-key",
      boundary: "window-switch-distribution",
      stage: "window-switch-distribution",
      ordinal: 17,
      reason: "aborted",
      timeoutMs: 2_000,
    },
  );
});

test("window lifecycle writer failures seal bounded health and transport pressure", () => {
  const workspaceClientRecord = {
    phase: "generation-workspace-client-state",
    workspaceClient: { committed: { terminalResourceRevision: 7 } },
  };
  assert.deepEqual(
    windowLifecycleWriterFailureObservation({
      stage: "switch",
      health: { droppedRecords: 2, failed: false, pendingCriticalRecords: 0 },
      records: [
        { phase: "terminal-http-start" },
        { phase: "terminal-http-response" },
        workspaceClientRecord,
        { ...workspaceClientRecord },
      ],
    }),
    {
      version: 1,
      operation: "window-lifecycle",
      predicate: "lifecycle-writer-health",
      stage: "switch",
      droppedRecords: 2,
      failed: false,
      pendingCriticalRecords: 0,
      httpStartCount: 1,
      httpResponseCount: 1,
      acceptedWorkspaceClientStateCount: 2,
      acceptedWorkspaceClientStateBytes:
        2 * (Buffer.byteLength(JSON.stringify(workspaceClientRecord), "utf8") + 1),
      consecutiveDuplicateWorkspaceClientStateCount: 1,
      terminalResourceRevision: 7,
    },
  );
});
