import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createProductDiagnosticBundle,
  PRODUCT_DIAGNOSTIC_BUNDLE_FILES,
} from "../product-test-rig-journeys.mjs";

import {
  assessProductSelectionCopyAppMouse,
  assessApplicationMouseDistribution,
  applicationMouseDistributionFailureObservation,
  applicationMouseForwardFailureObservation,
  applicationMouseCausalSamples,
  assessSelectionCopyAppMouseBoundaries,
  assessSelectionMouseModeConditioning,
  selectionClipboardEvidence,
  selectionCausalFailureObservation,
  selectionCopyFailureEvidence,
  selectionLocalModeFailureObservation,
  selectionMouseFixtureProgram,
  selectionWebEvidence,
  selectionWorkspaceClientEvidence,
  waitForSelectionMouseModeConditioning,
} from "./product-selection-copy-app-mouse.mjs";

test("local selection failure evidence is bounded, delta-scoped, and content free", () => {
  const evidence = selectionLocalModeFailureObservation({
    inputObservation: {
      operation: "tui-testdrive-input",
      kind: "selection-drag",
      substage: "post-input-identity",
      cause: "timeout",
      elapsedMs: 2_120,
      remainingMs: 880,
      raw: "secret",
    },
    performanceRecords: [
      { phase: "terminal-selection-copy" },
      { phase: "terminal-selection-copy", semanticPaneId: "pane.a", raw: "secret" },
      { phase: "terminal-application-mouse-route", semanticPaneId: "pane.a" },
      { phase: "terminal-application-mouse-route", semanticPaneId: "pane.other" },
    ],
    traceRecords: [
      { type: "performance.frame" },
      { type: "performance.input-origin", origin: "application-mouse", semanticPaneId: "pane.a" },
      {
        type: "performance.input-origin",
        origin: "application-mouse",
        semanticPaneId: "pane.other",
      },
      { type: "performance.terminal-paint", raw: "secret" },
      { type: "performance.terminal-paint" },
    ],
    performanceWatermark: 1,
    traceWatermark: 1,
    copyCountBefore: 1,
    expectedPaneId: "pane.a",
    mouseMode: { protocol: "drag", encoding: "sgr" },
  });
  assert.deepEqual(evidence.localMode, {
    originDelta: 1,
    routeDelta: 1,
    copyDelta: 1,
    localPaintCount: 2,
    mouseProtocol: "drag",
    mouseEncoding: "sgr",
  });
  assert.equal(evidence.substage, "post-input-identity");
  assert.equal(evidence.cause, "timeout");
  assert.equal(evidence.elapsedMs, 2_120);
  assert.equal(evidence.remainingMs, 880);
  assert.equal(JSON.stringify(evidence).includes("secret"), false);
  assert.deepEqual(
    selectionLocalModeFailureObservation({
      performanceRecords: new Array(8_193),
      traceRecords: new Array(8_193),
      performanceWatermark: 0,
      traceWatermark: 0,
      copyCountBefore: 0,
      expectedPaneId: "pane.a",
      mouseMode: { protocol: "unknown", encoding: "unknown" },
    }).localMode,
    {
      originDelta: 0,
      routeDelta: 0,
      copyDelta: 0,
      localPaintCount: 0,
      mouseProtocol: null,
      mouseEncoding: null,
    },
  );
});

test("application mouse failure evidence is bounded, identity joined, and content free", () => {
  const receipt = (sequence, operationId) => ({
    workspaceClient: {
      committed: {
        lastReceipt: {
          operationKind: "workspace.pane.select",
          phase: "observed",
          sequence,
          operationId,
        },
      },
    },
  });
  const delivery = {
    kind: "application-mouse",
    requestedAction: "down",
    requestedPoint: { x: 30, y: 3 },
    requestedButton: "left",
    requestedModifiers: [],
    raw: "must-not-escape",
  };
  const evidence = applicationMouseForwardFailureObservation({
    performanceRecords: [
      receipt(4, "00000000-0000-4000-8000-000000000001"),
      receipt(5, "00000000-0000-4000-8000-000000000002"),
      receipt(6, "00000000-0000-4000-8000-000000000003"),
      {
        phase: "terminal-application-mouse-route",
        semanticPaneId: expected.semanticPaneId,
        action: "down",
        sent: false,
        outcome: "refused",
      },
    ],
    traceRecords: [
      {
        type: "performance.input-origin",
        origin: "application-mouse",
        semanticPaneId: expected.semanticPaneId,
        traceId: "00000000-0000-4000-8000-000000000010",
      },
      {
        type: "performance.stage",
        stage: "paint",
        traceId: "00000000-0000-4000-8000-000000000010",
      },
    ],
    deliveries: Array.from({ length: 70 }, () => delivery),
    expectedPaneId: expected.semanticPaneId,
    selectReceiptWatermark: 3,
    fixtureReceiptCount: 80,
  });
  assert.deepEqual(evidence, {
    operation: "application-mouse-forwarding",
    completedDeliveries: 64,
    lastDelivery: { action: "down", x: 30, y: 3, button: "left", modifierCount: 0 },
    selectReceiptCount: 2,
    selectReceiptOverflow: true,
    routeOutcome: { available: true, sent: false, outcome: "refused" },
    originCount: 1,
    paintCount: 1,
    fixtureReceiptCount: 64,
  });
  assert.equal(JSON.stringify(evidence).includes("must-not-escape"), false);
  assert.equal(
    applicationMouseForwardFailureObservation({
      performanceRecords: [
        {
          phase: "terminal-application-mouse-route",
          semanticPaneId: "pane.other",
          action: "down",
          sent: true,
          outcome: "sent",
        },
      ],
      traceRecords: [],
      deliveries: [delivery],
      expectedPaneId: expected.semanticPaneId,
      selectReceiptWatermark: 0,
      fixtureReceiptCount: -1,
    }).routeOutcome.available,
    false,
  );
});

const expected = Object.freeze({
  processId: "opentui:123",
  daemonGeneration: "00000000-0000-4000-8000-000000000001",
  clientGeneration: 2,
  workspaceName: "workspace.product",
  sessionName: "session.product",
  semanticPaneId: "pane.product",
  canonicalGeneration: "00000000-0000-4000-8000-000000000002",
  canonicalIncarnation: "00000000-0000-4000-8000-000000000002:0",
  canonicalStateHash: "fedcba9876543210",
  terminalResourceRevision: 3,
});
const clipboard = selectionClipboardEvidence("select me", Buffer.alloc(32, 7));
const host = Object.freeze({ paneId: "%9", sessionId: "$3" });
const point = Object.freeze({
  from: Object.freeze({ x: 30, y: 3 }),
  to: Object.freeze({ x: 38, y: 3 }),
  contentRect: Object.freeze({ x: 28, y: 3, width: 132, height: 40 }),
});
const appMouseExpectedPoint = Object.freeze({ column: 2, row: 0 });
const exactApplicationMouseSamples = (
  durationMicros = (ordinal) => (ordinal === 29 ? 12_000 : 10_000),
) =>
  Array.from({ length: 30 }, (_, ordinal) => ({
    version: 1,
    ordinal,
    action: ["down", "drag", "up"][ordinal % 3],
    traceHmac: (ordinal + 1).toString(16).padStart(64, "0"),
    gestureHmac: (Math.floor(ordinal / 3) + 101).toString(16).padStart(64, "0"),
    unique: true,
    durationMicros: durationMicros(ordinal),
    durationMs: Number((durationMicros(ordinal) / 1_000).toFixed(3)),
    inputCount: 1,
    paintCount: 1,
    hostFrameCount: 1,
    fenceCount: 1,
    pointerColumn: appMouseExpectedPoint.column + (ordinal % 3 === 0 ? 0 : 1),
    pointerRow: appMouseExpectedPoint.row,
    pointerButton: 0,
    receiptOrdinal: ordinal + 1,
    receiptCode: ordinal % 3 === 1 ? 32 : 0,
    receiptColumn: appMouseExpectedPoint.column + (ordinal % 3 === 0 ? 1 : 2),
    receiptRow: appMouseExpectedPoint.row + 1,
    receiptRelease: ordinal % 3 === 2,
    pointExact: true,
    receiptExact: true,
    gestureExact: true,
    identityExact: true,
    orderExact: true,
    writerDroppedRecords: 0,
    writerOversizedRecords: 0,
    writerFailed: false,
    writerExact: true,
    causalExact: true,
  }));
const delivery = (kind, extra = {}) => ({
  version: 1,
  kind,
  delivery: "exact-bytes-to-immutable-host-pane-pty",
  paneId: host.paneId,
  target: host.paneId,
  sessionId: host.sessionId,
  geometry: { cols: 160, rows: 44 },
  bytesInjected: 8,
  phases: kind === "selection-drag" ? 13 : 1,
  transportCalls: kind === "selection-drag" ? 5 : 1,
  physicalTransportCalls: kind === "selection-drag" ? 5 : 1,
  ...(kind === "application-mouse"
    ? {}
    : {
        clipboardObservation: {
          candidateAttempts: 1,
          occupiedCount: 0,
          retirementExact: true,
          retirementStage: "complete",
          retirementElapsedMs: 20,
          finalOwnerAbsent: true,
          finalHookAbsent: true,
          priorCopyCount: 0,
          newCopyCount: 1,
          identityExact: true,
          callbackInvocations: 1,
          callbackStage: "artifact-published",
          callbackOutcome: "published",
          callbackInventoryPolls: 1,
          callbackHookElapsedMs: 1,
          callbackHookEntryLagMs: 5,
          callbackInventorySeenElapsedMs: 10,
          callbackPreSaveElapsedMs: 11,
          callbackSaveElapsedMs: 8,
          callbackSaveOutcome: "complete",
          callbackArtifactPublishedElapsedMs: 20,
          callbackRetirementStage: "already-exited",
          callbackRetirementElapsedMs: 0,
          callbackWorkSettled: true,
          callbackLeaseInactive: true,
          artifactObservedElapsedMs: 25,
          duplicateSettleElapsedMs: 40,
          callbackLastScanElapsedMs: 66,
          clipboardArmElapsedMs: 100,
          clipboardArmStartedElapsedMs: 80,
          clipboardArmBudgetAtStartMs: 90,
          clipboardArmRawRemainingAtStartMs: 1_340,
          clipboardReleaseElapsedMs: 120,
          clipboardWaitStartedElapsedMs: 120,
          clipboardReleaseBudgetAtStartMs: 200,
          clipboardReleaseIdentityElapsedMs: 20,
          clipboardReleaseTransportAttempted: true,
          clipboardReleaseEffectOccurred: true,
          clipboardReleaseLoadMarkerAcquired: true,
          clipboardReleaseCleanupAttempted: false,
        },
      }),
  ...extra,
});

test("selection failure evidence retains copied false with exact bounded identity", () => {
  const baseline = {
    ...expected,
    mouseMode: {
      incarnation: expected.canonicalIncarnation,
      revision: 3,
      stateHash: expected.canonicalStateHash,
    },
  };
  const record = {
    phase: "terminal-selection-copy",
    processId: expected.processId,
    daemonGeneration: expected.daemonGeneration,
    clientGeneration: expected.clientGeneration,
    semanticPaneId: expected.semanticPaneId,
    bytes: 19,
    copied: false,
    canonicalIdentity: {
      generation: expected.canonicalGeneration,
      incarnation: expected.canonicalIncarnation,
      revision: 3,
      stateHash: expected.canonicalStateHash,
    },
    writerHealth: { droppedRecords: 0, failed: false, pendingCriticalRecords: 0 },
  };
  assert.deepEqual(selectionCopyFailureEvidence([record], baseline), {
    available: true,
    copied: false,
    bytes: 19,
    identityExact: true,
    writerHealthy: true,
    copyCount: 1,
  });
  assert.deepEqual(selectionCopyFailureEvidence([], baseline), { available: false });
  assert.equal(
    selectionCopyFailureEvidence([record, { ...record, semanticPaneId: "pane.other" }], baseline)
      .identityExact,
    false,
  );
});
const copyFence = (copyOrdinal) => ({
  copied: true,
  copyOrdinal,
  daemonGeneration: expected.daemonGeneration,
  clientGeneration: expected.clientGeneration,
  semanticPaneId: expected.semanticPaneId,
  canonicalIdentity: {
    generation: expected.canonicalGeneration,
    incarnation: expected.canonicalIncarnation,
    revision: 4,
    stateHash: "0123456789abcdef",
    cols: 132,
    rows: 41,
  },
  writerHealth: { droppedRecords: 0, failed: false, pendingCriticalRecords: 0 },
});
const fixture = () => ({
  baseline: {
    ...expected,
    point,
    mouseMode: {
      protocol: "drag",
      encoding: "sgr",
      revision: 4,
      incarnation: expected.canonicalIncarnation,
      stateHash: "0123456789abcdef",
    },
    conditioning: { kind: "control-key", requestedKey: "y", applicationMouseReceipts: 0 },
  },
  host,
  clipboard,
  selection: {
    delivery: delivery("selection-drag", {
      clipboard,
      requestedSelection: point,
      selectionStyle: { presentationHmac: "a".repeat(64) },
    }),
    style: { cells: 8, extraChangedCells: 0 },
    presentationHmac: "a".repeat(64),
    copyFence: copyFence(0),
  },
  copy: {
    delivery: delivery("copy-capture", { clipboard }),
    copyFence: copyFence(1),
    copySequence: {
      beforeCount: 1,
      afterCount: 2,
      priorOrdinal: 0,
      expectedOrdinal: 1,
      actualOrdinal: 1,
      identityExact: true,
    },
  },
  appMouse: {
    deliveries: Array.from({ length: 30 }, (_, index) =>
      delivery("application-mouse", {
        requestedAction: ["down", "drag", "up"][index % 3],
        requestedPoint: { x: index % 3 === 0 ? 30 : 31, y: 3 },
        requestedButton: "left",
        requestedModifiers: [],
      }),
    ),
    terminalInputDelta: 30,
    localSelectionCopyDelta: 0,
    acceptedReceiptsExact: true,
    terminalProofHmac: "b".repeat(64),
    distribution: assessApplicationMouseDistribution(
      exactApplicationMouseSamples(),
      appMouseExpectedPoint,
    ),
  },
  localMode: {
    delivery: delivery("selection-drag", {
      clipboard,
      requestedSelection: point,
      selectionStyle: { presentationHmac: "d".repeat(64) },
    }),
    point,
    terminalInputDelta: 0,
    style: { cells: 8, extraChangedCells: 0 },
    copyFence: copyFence(2),
  },
  workspaceClient: {
    pendingCount: 0,
    clientGeneration: expected.clientGeneration,
    workspaceName: expected.workspaceName,
    authorityWorkspaceName: "session.product workspace",
    derivedWorkspaceName: "session.product workspace",
    semanticPaneId: expected.semanticPaneId,
    sameRecordExact: true,
    resourceCount: 1,
    activeResourceCount: 1,
    terminalResourceRevision: expected.terminalResourceRevision,
  },
  tmux: {
    semanticPaneId: expected.semanticPaneId,
    geometryStable: true,
    snapshotExact: true,
    applicationMouseMode: "sgr-drag",
  },
  correlation: { daemon: true, workspaceClient: true, tui: true, web: true, tmux: true },
  web: {
    qualified: true,
    stableExactSamples: 2,
    windowGroupCount: 1,
    terminalNodeCount: 1,
    semanticPaneExact: true,
  },
  work: { identicalIdleFrames: 0, unchangedPaneGridWalks: 0, terminalPaintsOutsideGestures: 0 },
  writerHealth: { droppedRecords: 0, failed: false, pendingCriticalRecords: 0 },
});

test("strict selection/copy/app-mouse evidence qualifies only the exact production shape", () => {
  assert.equal(
    assessProductSelectionCopyAppMouse({ evidence: fixture(), expected }).qualified,
    true,
  );
  for (const [name, mutate] of [
    ["mouseModeConditionedExact", (value) => (value.baseline.conditioning.requestedKey = "x")],
    ["selectionDeliveryExact", (value) => (value.selection.delivery.transportCalls = 24)],
    [
      "selectionDeliveryExact",
      (value) => (value.selection.delivery.clipboardObservation.retirementExact = false),
    ],
    [
      "selectionDeliveryExact",
      (value) => (value.selection.delivery.clipboardObservation.retirementStage = "verification"),
    ],
    [
      "selectionDeliveryExact",
      (value) => (value.selection.delivery.clipboardObservation.finalOwnerAbsent = false),
    ],
    [
      "selectionDeliveryExact",
      (value) => (value.selection.delivery.clipboardObservation.finalHookAbsent = false),
    ],
    [
      "selectionDeliveryExact",
      (value) => delete value.selection.delivery.clipboardObservation.clipboardArmStartedElapsedMs,
    ],
    [
      "selectionDeliveryExact",
      (value) => delete value.selection.delivery.clipboardObservation.clipboardArmBudgetAtStartMs,
    ],
    [
      "selectionDeliveryExact",
      (value) => (value.selection.delivery.clipboardObservation.clipboardArmBudgetAtStartMs = 89),
    ],
    [
      "selectionDeliveryExact",
      (value) =>
        delete value.selection.delivery.clipboardObservation.clipboardArmRawRemainingAtStartMs,
    ],
    [
      "selectionDeliveryExact",
      (value) =>
        (value.selection.delivery.clipboardObservation.clipboardArmRawRemainingAtStartMs = 1_339),
    ],
    [
      "selectionDeliveryExact",
      (value) => {
        value.selection.delivery.clipboardObservation.clipboardArmRawRemainingAtStartMs = 1_341;
        value.selection.delivery.clipboardObservation.clipboardArmBudgetAtStartMs = 90;
      },
    ],
    [
      "selectionDeliveryExact",
      (value) => {
        value.selection.delivery.clipboardObservation.clipboardArmRawRemainingAtStartMs = 1_921;
        value.selection.delivery.clipboardObservation.clipboardArmBudgetAtStartMs = 900;
      },
    ],
    [
      "selectionDeliveryExact",
      (value) => {
        value.selection.delivery.clipboardObservation.clipboardArmRawRemainingAtStartMs = 1_921;
        value.selection.delivery.clipboardObservation.clipboardArmBudgetAtStartMs = 670;
      },
    ],
    [
      "selectionDeliveryExact",
      (value) =>
        (value.selection.delivery.clipboardObservation.clipboardArmRawRemainingAtStartMs =
          Number.MAX_SAFE_INTEGER),
    ],
    [
      "selectionDeliveryExact",
      (value) => (value.selection.delivery.clipboardObservation.clipboardArmStartedElapsedMs = 101),
    ],
    [
      "selectionDeliveryExact",
      (value) =>
        (value.selection.delivery.clipboardObservation.clipboardReleaseBudgetAtStartMs = 199),
    ],
    [
      "selectionDeliveryExact",
      (value) =>
        (value.selection.delivery.clipboardObservation.clipboardReleaseIdentityElapsedMs = 201),
    ],
    [
      "selectionDeliveryExact",
      (value) =>
        (value.selection.delivery.clipboardObservation.clipboardReleaseTransportAttempted = false),
    ],
    [
      "selectionDeliveryExact",
      (value) =>
        (value.selection.delivery.clipboardObservation.clipboardReleaseEffectOccurred = false),
    ],
    [
      "selectionDeliveryExact",
      (value) =>
        (value.selection.delivery.clipboardObservation.clipboardReleaseLoadMarkerAcquired = false),
    ],
    [
      "selectionDeliveryExact",
      (value) =>
        (value.selection.delivery.clipboardObservation.clipboardReleaseCleanupAttempted = true),
    ],
    [
      "selectionDeliveryExact",
      (value) => {
        value.selection.delivery.clipboardObservation.clipboardArmStartedElapsedMs = 0;
        value.selection.delivery.clipboardObservation.clipboardArmRawRemainingAtStartMs = 2_150;
        value.selection.delivery.clipboardObservation.clipboardArmBudgetAtStartMs = 900;
        value.selection.delivery.clipboardObservation.clipboardArmElapsedMs = 901;
      },
    ],
    [
      "selectionDeliveryExact",
      (value) => {
        value.selection.delivery.clipboardObservation.clipboardArmStartedElapsedMs = 80;
        value.selection.delivery.clipboardObservation.clipboardArmRawRemainingAtStartMs = 1_340;
        value.selection.delivery.clipboardObservation.clipboardArmBudgetAtStartMs = 90;
        value.selection.delivery.clipboardObservation.clipboardArmElapsedMs = 171;
      },
    ],
    [
      "selectionDeliveryExact",
      (value) => {
        value.selection.delivery.clipboardObservation.clipboardReleaseElapsedMs = 301;
        value.selection.delivery.clipboardObservation.clipboardWaitStartedElapsedMs = 301;
      },
    ],
    [
      "copyDeliveryExact",
      (value) => delete value.copy.delivery.clipboardObservation.clipboardReleaseBudgetAtStartMs,
    ],
    [
      "copyDeliveryExact",
      (value) =>
        (value.copy.delivery.clipboardObservation.clipboardArmStartedElapsedMs =
          Number.MAX_SAFE_INTEGER),
    ],
    [
      "copyDeliveryExact",
      (value) => (value.copy.delivery.clipboardObservation.clipboardArmBudgetAtStartMs = 901),
    ],
    [
      "localModeExact",
      (value) => (value.localMode.delivery.clipboardObservation.clipboardReleaseElapsedMs = 301),
    ],
    ["selectionCellsExact", (value) => (value.selection.delivery.phases = 12)],
    ["selectionCellsExact", (value) => (value.selection.style.extraChangedCells = 1)],
    [
      "copyClipboardExact",
      (value) => (value.copy.delivery.clipboard = { ...value.clipboard, hmac: "c".repeat(64) }),
    ],
    ["copyDeliveryExact", (value) => delete value.copy.delivery.clipboardObservation],
    [
      "copyDeliveryExact",
      (value) => (value.copy.delivery.clipboardObservation.callbackInvocations = 2),
    ],
    [
      "copyDeliveryExact",
      (value) => (value.copy.delivery.clipboardObservation.callbackStage = "inventory-pending"),
    ],
    [
      "copyDeliveryExact",
      (value) => delete value.copy.delivery.clipboardObservation.callbackHookElapsedMs,
    ],
    [
      "copyDeliveryExact",
      (value) => (value.copy.delivery.clipboardObservation.callbackInventorySeenElapsedMs = null),
    ],
    [
      "copyDeliveryExact",
      (value) => (value.copy.delivery.clipboardObservation.callbackArtifactPublishedElapsedMs = 9),
    ],
    [
      "copyDeliveryExact",
      (value) => delete value.copy.delivery.clipboardObservation.callbackPreSaveElapsedMs,
    ],
    [
      "copyDeliveryExact",
      (value) => (value.copy.delivery.clipboardObservation.callbackSaveElapsedMs = 10),
    ],
    [
      "copyDeliveryExact",
      (value) => (value.copy.delivery.clipboardObservation.callbackSaveOutcome = "pending"),
    ],
    [
      "copyDeliveryExact",
      (value) => (value.copy.delivery.clipboardObservation.callbackWorkSettled = false),
      (value) => (value.copy.delivery.clipboardObservation.callbackLeaseInactive = false),
    ],
    [
      "copyDeliveryExact",
      (value) => (value.copy.delivery.clipboardObservation.artifactObservedElapsedMs = 19),
    ],
    [
      "copyDeliveryExact",
      (value) => (value.copy.delivery.clipboardObservation.duplicateSettleElapsedMs = 39),
    ],
    [
      "copyDeliveryExact",
      (value) => (value.copy.delivery.clipboardObservation.duplicateSettleElapsedMs = null),
    ],
    [
      "copyDeliveryExact",
      (value) => (value.copy.delivery.clipboardObservation.callbackHookElapsedMs = Infinity),
    ],
    [
      "copyDeliveryExact",
      (value) => delete value.copy.delivery.clipboardObservation.callbackHookEntryLagMs,
    ],
    [
      "copyDeliveryExact",
      (value) => (value.copy.delivery.clipboardObservation.callbackHookEntryLagMs = 6),
    ],
    [
      "copyDeliveryExact",
      (value) => {
        value.copy.delivery.clipboardObservation.callbackHookEntryLagMs = Number.MAX_SAFE_INTEGER;
        value.copy.delivery.clipboardObservation.callbackArtifactPublishedElapsedMs = 1;
      },
    ],
    [
      "copyDeliveryExact",
      (value) => (value.copy.delivery.clipboardObservation.callbackLastScanElapsedMs = 24),
    ],
    [
      "copyDeliveryExact",
      (value) => (value.copy.delivery.clipboardObservation.clipboardArmElapsedMs = 121),
    ],
    [
      "copyDeliveryExact",
      (value) => (value.copy.delivery.clipboardObservation.artifactObservedElapsedMs = 3_001),
    ],
    ["copyClipboardExact", (value) => (value.copy.copySequence.expectedOrdinal = 0)],
    ["copyClipboardExact", (value) => (value.copy.copyFence.copyOrdinal = 0)],
    ["appMouseForwardedExact", (value) => (value.appMouse.terminalInputDelta = 2)],
    ["appMouseDistributionExact", (value) => (value.appMouse.distribution.qualified = false)],
    ["appMouseDistributionExact", (value) => delete value.appMouse.distribution.samples],
    [
      "appMouseDistributionExact",
      (value) =>
        value.appMouse.distribution.samples.splice(
          0,
          2,
          ...value.appMouse.distribution.samples.slice(0, 2).reverse(),
        ),
    ],
    [
      "appMouseDistributionExact",
      (value) =>
        (value.appMouse.distribution.samples[1].traceHmac =
          value.appMouse.distribution.samples[0].traceHmac),
    ],
    [
      "appMouseDistributionExact",
      (value) =>
        (value.appMouse.distribution.samples[3].gestureHmac =
          value.appMouse.distribution.samples[0].gestureHmac),
    ],
    [
      "appMouseDistributionExact",
      (value) => (value.appMouse.distribution.samples[2].inputCount = 2),
    ],
    [
      "appMouseDistributionExact",
      (value) => (value.appMouse.distribution.samples[2].pointerColumn += 1),
    ],
    [
      "appMouseDistributionExact",
      (value) => (value.appMouse.distribution.samples[2].receiptRelease = false),
    ],
    [
      "appMouseDistributionExact",
      (value) => (value.appMouse.distribution.samples[2].writerDroppedRecords = 1),
    ],
    [
      "appMouseDistributionExact",
      (value) => (value.appMouse.distribution.samples[2].causalExact = false),
    ],
    [
      "appMouseDistributionExact",
      (value) => {
        value.appMouse.distribution.samples[29].durationMicros = 34_000;
        value.appMouse.distribution.samples[29].durationMs = 34;
      },
    ],
    ["appMouseDistributionExact", (value) => (value.appMouse.distribution.p95Ms = 9)],
    ["localModeExact", (value) => (value.localMode.terminalInputDelta = 1)],
    ["workspaceClientExact", (value) => (value.workspaceClient.activeResourceCount = 2)],
    ["workspaceClientExact", (value) => (value.workspaceClient.authorityWorkspaceName = "other")],
    ["webExact", (value) => (value.web.stableExactSamples = 1)],
    ["zeroIdleWork", (value) => (value.work.identicalIdleFrames = 1)],
  ]) {
    const value = structuredClone(fixture());
    mutate(value);
    assert.equal(
      assessProductSelectionCopyAppMouse({ evidence: value, expected }).firstFailedPredicate,
      name,
    );
  }
});

test("sealed exact10 selection report replays causal distribution without mutable artifacts", () => {
  const evidence = fixture();
  const initial = assessProductSelectionCopyAppMouse({ evidence, expected });
  const report = {
    selectionCopyAppMouse: evidence,
    causalAssessment: initial,
  };
  const alignment = { causalAssessment: initial };
  const root = mkdtempSync(join(tmpdir(), "selection-exact10-"));
  try {
    const bundle = createProductDiagnosticBundle({
      root,
      runId: "selection-sealed-replay",
      evidence: {
        report,
        alignment,
        timeline: "",
        tmuxTruth: {},
        daemonState: {},
        clientState: {},
        tuiAnsi: "",
        webPng: Buffer.from("89504e470d0a1a0a", "hex"),
        stderr: "",
        reproduction: "#!/bin/sh\nexit 0\n",
      },
    });
    const exact10Report = JSON.parse(readFileSync(join(bundle.runDir, "report.json"), "utf8"));
    const exact10Alignment = JSON.parse(
      readFileSync(join(bundle.runDir, "alignment.json"), "utf8"),
    );
    assert.deepEqual(
      readdirSync(bundle.runDir).sort(),
      [...PRODUCT_DIAGNOSTIC_BUNDLE_FILES].sort(),
    );
    assert.equal(readdirSync(bundle.runDir).length, 10);
    const replay = assessProductSelectionCopyAppMouse({
      evidence: exact10Report.selectionCopyAppMouse,
      expected,
    });
    assert.equal(replay.qualified, true);
    assert.deepEqual(replay.metrics, {
      selectedCells: 8,
      clipboardBytes: 9,
      appMouseSampleCount: 30,
      appMouseP95Ms: 10,
      appMouseP99Ms: 12,
    });
    assert.equal(replay.appMouseCausalSamples.length, 30);
    assert.deepEqual(
      replay.appMouseCausalSamples,
      exact10Alignment.causalAssessment.appMouseCausalSamples,
    );
    const sealedVector = JSON.stringify(replay.appMouseCausalSamples);
    assert.doesNotMatch(sealedVector, /traceId|gestureId|semanticPaneId|\/tmp\//u);
    assert.equal(
      replay.appMouseCausalSamples.every(
        ({ traceHmac, gestureHmac }) =>
          /^[0-9a-f]{64}$/u.test(traceHmac) && /^[0-9a-f]{64}$/u.test(gestureHmac),
      ),
      true,
    );

    const legacy = structuredClone(exact10Report.selectionCopyAppMouse);
    delete legacy.appMouse.distribution.samples;
    assert.equal(
      assessProductSelectionCopyAppMouse({ evidence: legacy, expected }).firstFailedPredicate,
      "appMouseDistributionExact",
    );
  } finally {
    try {
      chmodSync(join(root, "selection-sealed-replay"), 0o700);
    } catch {
      // The bundle may have failed before its immutable directory was published.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("WorkspaceClient evidence uses target identity and committed revision from one exact record", () => {
  const committed = {
    generation: expected.clientGeneration,
    target: { workspaceName: expected.workspaceName },
    authorityWorkspaceName: "session.product workspace",
    terminalResourceRevision: 0,
  };
  const pending = [];
  const derived = {
    workspace: { name: "session.product workspace" },
    terminalInventory: {
      activeResourceId: "resource.one",
      resources: [
        {
          id: "resource.one",
          active: true,
          attachability: { status: "available", semanticPaneId: expected.semanticPaneId },
        },
      ],
    },
  };
  const workspaceClient = {
    record: { workspaceClient: { committed, pending, derived } },
    committed,
    pending,
    derived,
  };
  assert.deepEqual(selectionWorkspaceClientEvidence(workspaceClient), {
    pendingCount: 0,
    clientGeneration: expected.clientGeneration,
    workspaceName: expected.workspaceName,
    authorityWorkspaceName: "session.product workspace",
    derivedWorkspaceName: "session.product workspace",
    semanticPaneId: expected.semanticPaneId,
    resourceCount: 1,
    activeResourceCount: 1,
    terminalResourceRevision: 0,
    sameRecordExact: true,
  });
  const productionEvidence = structuredClone(fixture());
  productionEvidence.baseline.terminalResourceRevision = 0;
  productionEvidence.workspaceClient = selectionWorkspaceClientEvidence(workspaceClient);
  const productionExpected = { ...expected, terminalResourceRevision: 0 };
  assert.equal(
    assessProductSelectionCopyAppMouse({
      evidence: productionEvidence,
      expected: productionExpected,
    }).qualified,
    true,
  );
  const changedAfterWeb = structuredClone(productionEvidence);
  changedAfterWeb.workspaceClient.terminalResourceRevision = 1;
  assert.equal(
    assessProductSelectionCopyAppMouse({
      evidence: changedAfterWeb,
      expected: productionExpected,
    }).firstFailedPredicate,
    "workspaceClientExact",
  );
  assert.equal("terminalResourceRevision" in derived.terminalInventory, false);
  for (const revision of [undefined, -1, 0.5, Number.NaN]) {
    const invalidCommitted = { ...committed, terminalResourceRevision: revision };
    assert.equal(
      selectionWorkspaceClientEvidence({
        record: { workspaceClient: { committed: invalidCommitted, pending, derived } },
        committed: invalidCommitted,
        pending,
        derived,
      }).terminalResourceRevision,
      null,
    );
  }
  assert.equal(
    selectionWorkspaceClientEvidence({
      record: { workspaceClient: { committed: { ...committed }, pending, derived } },
      committed,
      pending,
      derived,
    }).sameRecordExact,
    false,
  );
});

test("WorkspaceClient assessment rejects every unsafe or changed committed revision", () => {
  for (const revision of [undefined, -1, 0.5, Number.NaN, expected.terminalResourceRevision + 1]) {
    const value = structuredClone(fixture());
    value.workspaceClient.terminalResourceRevision = revision;
    assert.equal(
      assessProductSelectionCopyAppMouse({ evidence: value, expected }).firstFailedPredicate,
      "workspaceClientExact",
    );
  }
  for (const revision of [undefined, -1, 0.5, Number.NaN]) {
    const expectedValue = { ...expected, terminalResourceRevision: revision };
    assert.equal(
      assessProductSelectionCopyAppMouse({ evidence: fixture(), expected: expectedValue })
        .firstFailedPredicate,
      "workspaceClientExact",
    );
  }
});

test("causal failure observation seals the full bounded component vector without identities", () => {
  const value = structuredClone(fixture());
  value.workspaceClient.workspaceName = "wrong-target";
  const assessment = assessProductSelectionCopyAppMouse({ evidence: value, expected });
  const observation = selectionCausalFailureObservation(assessment, {
    ...value,
    expected,
  });
  assert.equal(observation.firstFailedPredicate, "workspaceClientExact");
  assert.equal(observation.predicateVector.length, Object.keys(assessment.predicates).length);
  assert.equal(observation.workspaceClient.targetWorkspaceExact, false);
  assert.equal(observation.workspaceClient.authorityWorkspaceExact, true);
  assert.equal(observation.workspaceClient.revisionExact, true);
  assert.equal(observation.tmux.geometryStable, true);
  assert.equal(observation.web.qualified, true);
  assert.equal(observation.writer.healthy, true);
  const serialized = JSON.stringify(observation);
  assert.equal(serialized.includes(expected.workspaceName), false);
  assert.equal(serialized.includes(expected.semanticPaneId), false);
  assert.equal(serialized.includes("/Users/"), false);
});

test("journey boundaries are exact and ordered", () => {
  const names = [
    "selection-namespace-ready",
    "selection-daemon-ready",
    "selection-tui-build",
    "selection-tui-started",
    "selection-host-ready",
    "selection-tui-coherent",
    "selection-baseline",
    "selection-visible",
    "selection-copy-proved",
    "application-mouse-forwarded",
    "selection-local-mode-proved",
    "selection-web-correlation",
  ];
  assert.equal(
    assessSelectionCopyAppMouseBoundaries({ expected: names, actual: names }).qualified,
    true,
  );
  assert.equal(
    assessSelectionCopyAppMouseBoundaries({ expected: names, actual: names.toReversed() })
      .qualified,
    false,
  );
});

test("fixture emits mouse modes only for one post-attachment dedicated trigger", async () => {
  const child = spawn(process.execPath, ["-e", selectionMouseFixtureProgram(), "SELECT", "READY"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("latin1").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 1_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`fixture deadline elapsed: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    await waitFor(() => stdout.includes("SELECT\n"));
    assert.equal(stdout, "SELECT\n");
    child.stdin.write("wrong");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stdout, "SELECT\n");
    child.stdin.write("\u0019");
    await waitFor(() => stdout.includes("READY\n"));
    assert.equal(stdout.split("\u001b[?1002h").length - 1, 1);
    assert.equal(stdout.split("\u001b[?1006h").length - 1, 1);
    const conditioned = stdout;
    child.stdin.write("\u0019");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stdout, conditioned);
    child.stdin.write("\u001b[<0;31;4M");
    await waitFor(() => stdout.includes("APP_MOUSE_1_0_31_4_M\n"));
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
  }
});

const conditioningExpected = Object.freeze({
  processId: expected.processId,
  clockId: "opentui-performance-now",
  daemonGeneration: expected.daemonGeneration,
  semanticPaneId: expected.semanticPaneId,
  canonicalGeneration: expected.canonicalGeneration,
  canonicalIncarnation: `${expected.canonicalGeneration}:0`,
  beforeStateHash: "fedcba9876543210",
  afterRevision: 3,
  sourceEpoch: 1,
  rendererEpoch: 2,
  canonicalCols: 132,
  canonicalRows: 41,
  viewportCols: 132,
  viewportRows: 40,
});

function conditioningRecords() {
  const identity = {
    processId: conditioningExpected.processId,
    clockId: conditioningExpected.clockId,
    clockKind: "performance-now",
    semanticPaneId: conditioningExpected.semanticPaneId,
    generation: conditioningExpected.canonicalGeneration,
    incarnation: `${conditioningExpected.canonicalGeneration}:0`,
    revision: 4,
    stateHash: "0123456789abcdef",
  };
  return [
    {
      version: 1,
      type: "performance.input-origin",
      ...identity,
      revision: 3,
      stateHash: "fedcba9876543210",
      atMicros: 19,
      origin: "keyboard",
      traceId: "20000000-0000-4000-8000-000000000001",
    },
    {
      version: 1,
      type: "performance.terminal-canonical-update",
      ...identity,
      atMicros: 20,
      updateType: "terminal.patch",
      sourceEpoch: 1,
      cols: 132,
      rows: 41,
    },
    {
      version: 1,
      type: "performance.terminal-canonical-mode",
      ...identity,
      atMicros: 21,
      mouseProtocol: "drag",
      mouseEncoding: "sgr",
    },
    {
      version: 1,
      type: "performance.stage",
      ...identity,
      stage: "paint",
      scenario: "terminal-input-to-paint",
      traceId: "20000000-0000-4000-8000-000000000001",
      startedAtMicros: 20,
      endedAtMicros: 22,
      paintStateIdentity: "latest-canonical-state-blitted",
    },
    {
      version: 1,
      type: "performance.terminal-canonical-host-frame",
      ...identity,
      atMicros: 23,
      sourceEpoch: 1,
      rendererEpoch: 2,
      cols: 132,
      rows: 41,
      viewportCols: 132,
      viewportRows: 40,
      acceptedUpdateType: "terminal.patch",
      acceptedRevision: 4,
    },
    {
      version: 1,
      type: "performance.terminal-frame-fence",
      ...identity,
      atMicros: 24,
      daemonGeneration: conditioningExpected.daemonGeneration,
      sourceEpoch: 1,
      rendererEpoch: 2,
      cols: 132,
      rows: 41,
      viewportCols: 132,
      viewportRows: 40,
      acceptedUpdateType: "terminal.patch",
      acceptedRevision: 4,
      writerHealth: { droppedRecords: 0, oversizedRecords: 0, failed: false },
    },
  ];
}

test("post-attachment mouse conditioning requires one newer exact mode patch, frame and fence", () => {
  const records = conditioningRecords();
  const exact = assessSelectionMouseModeConditioning(records, conditioningExpected);
  assert.equal(exact.qualified, true);
  assert.equal(exact.qualifiedMode.revision, 4);
  assert.deepEqual(exact.observation, {
    recordCount: 6,
    modeCount: 1,
    transitionModeCount: 1,
    inputOriginCount: 1,
    patchCount: 1,
    transitionPatchCount: 1,
    paintCount: 1,
    frameCount: 1,
    fenceCount: 1,
    latestProtocol: "drag",
    latestEncoding: "sgr",
    latestRevision: 4,
  });

  for (const [predicate, mutate] of [
    ["inputOriginExact", (value) => (value[0].origin = "application-mouse")],
    ["modeExact", (value) => value.splice(2, 1)],
    ["modeExact", (value) => value.push({ ...value[2] })],
    ["patchExact", (value) => (value[1].sourceEpoch = 2)],
    ["changedPaintExact", (value) => (value[3].traceId = "wrong")],
    ["changedFrameExact", (value) => (value[4].semanticPaneId = "pane.replaced")],
    ["healthyFenceExact", (value) => (value[5].writerHealth.droppedRecords = 1)],
    ["orderExact", (value) => (value[5].atMicros = 19)],
  ]) {
    const value = structuredClone(records);
    mutate(value);
    assert.equal(
      assessSelectionMouseModeConditioning(value, conditioningExpected).firstFailedPredicate,
      predicate,
    );
  }
  assert.equal(
    assessSelectionMouseModeConditioning(records, {
      ...conditioningExpected,
      canonicalGeneration: "00000000-0000-4000-8000-000000000099",
    }).qualified,
    false,
  );
  const preAttachmentOnly = [
    {
      type: "performance.terminal-canonical-mode",
      processId: conditioningExpected.processId,
      clockId: conditioningExpected.clockId,
      clockKind: "performance-now",
      semanticPaneId: conditioningExpected.semanticPaneId,
      generation: conditioningExpected.canonicalGeneration,
      incarnation: conditioningExpected.canonicalIncarnation,
      revision: 3,
      stateHash: "fedcba9876543210",
      atMicros: 1,
      mouseProtocol: "none",
      mouseEncoding: "default",
    },
  ];
  assert.equal(
    assessSelectionMouseModeConditioning(preAttachmentOnly, conditioningExpected)
      .firstFailedPredicate,
    "modeExact",
  );
  const stale = structuredClone(records);
  for (const record of stale) {
    if (Number.isSafeInteger(record.revision)) record.revision = 3;
    if (record.acceptedRevision !== undefined) record.acceptedRevision = 3;
  }
  assert.equal(
    assessSelectionMouseModeConditioning(stale, conditioningExpected).firstFailedPredicate,
    "modeExact",
  );
  const replacement = structuredClone(records);
  for (const record of replacement.slice(1)) record.incarnation = "replacement:0";
  assert.equal(
    assessSelectionMouseModeConditioning(replacement, conditioningExpected).firstFailedPredicate,
    "modeExact",
  );
  const splitTransition = structuredClone(records);
  splitTransition.splice(
    1,
    0,
    {
      ...splitTransition[1],
      revision: 4,
      stateHash: "1111111111111111",
      atMicros: 19.5,
    },
    {
      ...splitTransition[2],
      revision: 4,
      stateHash: "1111111111111111",
      atMicros: 19.75,
      mouseProtocol: "drag",
      mouseEncoding: "default",
    },
  );
  assert.equal(
    assessSelectionMouseModeConditioning(splitTransition, conditioningExpected)
      .firstFailedPredicate,
    "transitionCardinalityExact",
  );
});

test("mouse conditioning waiter admits delayed exact evidence and fails boundedly on timeout or abort", async () => {
  const records = conditioningRecords();
  let reads = 0;
  let clock = 0;
  const exact = await waitForSelectionMouseModeConditioning({
    readRecords: () => (++reads < 2 ? records.slice(0, 2) : records),
    expected: conditioningExpected,
    now: () => clock,
    sleep: async () => {
      clock += 10;
    },
    timeoutMs: 20,
  });
  assert.equal(exact.qualified, true);
  assert.equal(reads, 2);

  await assert.rejects(
    waitForSelectionMouseModeConditioning({
      readRecords: () => records.slice(0, 2),
      expected: conditioningExpected,
      now: () => clock,
      sleep: async () => {
        clock += 10;
      },
      timeoutMs: 10,
    }),
    (error) =>
      error.boundary === "selection-baseline" &&
      error.observation?.reason === "timeout" &&
      error.observation?.firstFailedPredicate === "modeExact",
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    waitForSelectionMouseModeConditioning({
      readRecords: () => records,
      expected: conditioningExpected,
      signal: controller.signal,
    }),
    (error) => error.observation?.reason === "aborted" && error.observation?.attempts === 0,
  );
});

test("application mouse distribution requires thirty unique causal samples and hard p95/p99", () => {
  const samples = exactApplicationMouseSamples((ordinal) => (ordinal === 29 ? 32_000 : 10_000));
  assert.deepEqual(assessApplicationMouseDistribution(samples, appMouseExpectedPoint), {
    sampleCount: 30,
    uniqueSamples: 30,
    causalSamples: 30,
    p95Ms: 10,
    p99Ms: 32,
    qualified: true,
    samples,
  });
  assert.equal(
    assessApplicationMouseDistribution(samples.slice(0, 29), appMouseExpectedPoint).qualified,
    false,
  );
  assert.equal(
    assessApplicationMouseDistribution(
      samples.map((sample, index) =>
        index === 28 ? { ...sample, durationMicros: 17_000, durationMs: 17 } : sample,
      ),
      appMouseExpectedPoint,
    ).qualified,
    false,
  );
  assert.equal(
    assessApplicationMouseDistribution(
      samples.map((sample, index) =>
        index === 29 ? { ...sample, durationMicros: 34_000, durationMs: 34 } : sample,
      ),
      appMouseExpectedPoint,
    ).qualified,
    false,
  );
  assert.equal(
    assessApplicationMouseDistribution(
      samples.map((sample, index) => (index === 0 ? { ...sample, ordinal: 1 } : sample)),
      appMouseExpectedPoint,
    ).qualified,
    false,
  );
});

test("application mouse durations use exact integer microseconds and canonical milliseconds", () => {
  const exact = exactApplicationMouseSamples((ordinal) => [8_114, 8_201, 9_999][ordinal % 3]);
  const qualified = assessApplicationMouseDistribution(exact, appMouseExpectedPoint);
  assert.equal(qualified.qualified, true);
  assert.equal(qualified.samples[0].durationMicros, 8_114);
  assert.equal(qualified.samples[0].durationMs, 8.114);

  for (const mutate of [
    (samples) => delete samples[0].durationMicros,
    (samples) => delete samples[0].durationMs,
    (samples) => (samples[0].durationMicros = 8_114.5),
    (samples) => (samples[0].durationMicros = -1),
    (samples) => (samples[0].durationMicros = 5_000_001),
    (samples) => (samples[0].durationMicros = Number.MAX_SAFE_INTEGER),
    (samples) => (samples[0].durationMs = 8.1141),
    (samples) => (samples[0].durationMs = 8.115),
    (samples) => (samples[0].durationMs = Number.NaN),
  ]) {
    const samples = structuredClone(exact);
    mutate(samples);
    assert.equal(
      assessApplicationMouseDistribution(samples, appMouseExpectedPoint).qualified,
      false,
    );
  }

  const outlier = structuredClone(exact);
  outlier[29].durationMicros = 34_000;
  outlier[29].durationMs = 34;
  assert.equal(assessApplicationMouseDistribution(outlier, appMouseExpectedPoint).qualified, false);
});

test("application mouse distribution failure observation seals the first invalid sample", () => {
  const samples = exactApplicationMouseSamples((ordinal) => (ordinal === 29 ? 8_114 : 10_000));
  samples[29].durationMs = 8.1141;
  const distribution = assessApplicationMouseDistribution(samples, appMouseExpectedPoint);
  const observation = applicationMouseDistributionFailureObservation({
    samples,
    distribution,
    expected: appMouseExpectedPoint,
    deliveryCount: 30,
    receiptCount: 30,
  });
  assert.equal(observation.firstInvalidOrdinal, 29);
  assert.equal(observation.firstInvalidReason, "duration");
  assert.equal(observation.deliveryCount, 30);
  assert.equal(observation.receiptCount, 30);
  assert.equal(observation.sampleCount, 30);
  assert.equal(observation.uniqueSamples, 30);
  assert.equal(observation.causalSamples, 29);
  assert.equal(observation.samples.length, 30);
  assert.doesNotMatch(
    JSON.stringify(observation),
    /traceId|gestureId|semanticPaneId|stateHash|content|path|\/tmp\//u,
  );

  const receiptMismatch = applicationMouseDistributionFailureObservation({
    samples: null,
    distribution: null,
    expected: appMouseExpectedPoint,
    deliveryCount: 30,
    receiptCount: 29,
  });
  assert.equal(receiptMismatch.firstInvalidOrdinal, null);
  assert.equal(receiptMismatch.firstInvalidReason, "receipt-count");
  assert.equal(receiptMismatch.sampleCount, 0);
});

test("selection Web evidence projects one exact waiter result without nonexistent raw fields", () => {
  const waiter = () => ({
    semantic: {
      windowNodeCount: 1,
      terminalNodeCount: 1,
      windows: [{ windowResourceId: "window.a" }],
      terminals: [{ semanticPaneId: expected.semanticPaneId }],
    },
    readiness: {
      qualified: true,
      normalized: {
        expectedGroupCount: 1,
        observedTerminalCount: 1,
        terminalExact: true,
      },
    },
    stableExactSamples: 2,
  });
  const exact = waiter();
  assert.equal("windowGroupCount" in exact.semantic, false);
  assert.deepEqual(selectionWebEvidence(exact, expected.semanticPaneId), {
    qualified: true,
    stableExactSamples: 2,
    windowGroupCount: 1,
    terminalNodeCount: 1,
    semanticPaneExact: true,
  });
  for (const mutate of [
    (value) => (value.readiness.qualified = false),
    (value) => delete value.readiness.qualified,
    (value) => delete value.readiness.normalized,
    (value) => (value.readiness.normalized.expectedGroupCount = "1"),
    (value) => {
      value.readiness.normalized.expectedGroupCount = 2;
      value.semantic.windowNodeCount = 2;
      value.semantic.windows.push({ windowResourceId: "window.b" });
    },
    (value) => {
      value.readiness.normalized.observedTerminalCount = 2;
      value.semantic.terminalNodeCount = 2;
      value.semantic.terminals.push({ semanticPaneId: "pane.other" });
    },
    (value) => (value.readiness.normalized.terminalExact = false),
    (value) => (value.semantic.terminals[0].semanticPaneId = "pane.other"),
    (value) => (value.stableExactSamples = 1),
  ]) {
    const changed = structuredClone(waiter());
    mutate(changed);
    assert.equal(selectionWebEvidence(changed, expected.semanticPaneId).qualified, false);
  }
  const sibling = waiter();
  sibling.semantic = structuredClone(waiter().semantic);
  sibling.semantic.terminals[0].semanticPaneId = "pane.sibling";
  assert.equal(selectionWebEvidence(sibling, expected.semanticPaneId).qualified, false);
});

test("clipboard evidence is run-ephemeral HMAC and never a stable content digest", () => {
  const first = selectionClipboardEvidence("select me", Buffer.alloc(32, 1));
  const second = selectionClipboardEvidence("select me", Buffer.alloc(32, 2));
  assert.equal(first.bytes, second.bytes);
  assert.notEqual(first.hmac, second.hmac);
  assert.deepEqual(Object.keys(first).sort(), ["bytes", "hmac"]);
  assert.equal(selectionClipboardEvidence("select me", Buffer.alloc(31)), null);
});

test("mouse causal samples exact-join typed ingress, application receipt, changed paint and frame fence", () => {
  const records = [];
  const receipts = [];
  for (let ordinal = 0; ordinal < 30; ordinal += 1) {
    const traceId = `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
    const gestureId = `10000000-0000-4000-8000-${String(Math.floor(ordinal / 3)).padStart(12, "0")}`;
    const action = ["down", "drag", "up"][ordinal % 3];
    const revision = ordinal + 4;
    records.push(
      {
        type: "performance.input-origin",
        traceId,
        origin: "application-mouse",
        processId: expected.processId,
        clockId: "opentui-performance-now",
        clockKind: "performance-now",
        gestureId,
        atMicros: ordinal * 20_000,
        semanticPaneId: expected.semanticPaneId,
        generation: expected.daemonGeneration,
        incarnation: `${expected.canonicalGeneration}:0`,
        revision: Math.max(0, revision - 1),
        stateHash: `state-${Math.max(0, revision - 1)}`,
        pointerAction: action,
        pointerColumn: 2 + (ordinal % 3 === 0 ? 0 : 1),
        pointerRow: 0,
        pointerButton: 0,
      },
      {
        type: "performance.stage",
        stage: "input",
        traceId,
        processId: expected.processId,
        clockId: "opentui-performance-now",
        clockKind: "performance-now",
        scenario: "terminal-input-to-paint",
        startedAtMicros: ordinal * 20_000 + 1_000,
        endedAtMicros: ordinal * 20_000 + 2_000,
      },
      {
        type: "performance.stage",
        stage: "paint",
        traceId,
        processId: expected.processId,
        clockId: "opentui-performance-now",
        clockKind: "performance-now",
        scenario: "terminal-input-to-paint",
        startedAtMicros: ordinal * 20_000 + 5_000,
        endedAtMicros: ordinal * 20_000 + (ordinal === 29 ? 8_114 : 10_000),
        paintStateIdentity: "latest-canonical-state-blitted",
        semanticPaneId: expected.semanticPaneId,
        generation: expected.canonicalGeneration,
        incarnation: `${expected.canonicalGeneration}:0`,
        revision,
        stateHash: `state-${revision}`,
      },
      {
        type: "performance.terminal-canonical-host-frame",
        processId: expected.processId,
        clockId: "opentui-performance-now",
        clockKind: "performance-now",
        atMicros: ordinal * 20_000 + 11_000,
        semanticPaneId: expected.semanticPaneId,
        generation: expected.canonicalGeneration,
        incarnation: `${expected.canonicalGeneration}:0`,
        revision,
        stateHash: `state-${revision}`,
        rendererEpoch: 1,
      },
      {
        type: "performance.terminal-frame-fence",
        processId: expected.processId,
        clockId: "opentui-performance-now",
        clockKind: "performance-now",
        atMicros: ordinal * 20_000 + 12_000,
        daemonGeneration: expected.daemonGeneration,
        semanticPaneId: expected.semanticPaneId,
        generation: expected.canonicalGeneration,
        incarnation: `${expected.canonicalGeneration}:0`,
        revision,
        stateHash: `state-${revision}`,
        rendererEpoch: 1,
        writerHealth: { droppedRecords: 0, oversizedRecords: 0, failed: false },
      },
    );
    receipts.push({
      ordinal: ordinal + 1,
      code: ordinal % 3 === 1 ? 32 : 0,
      column: 3 + (ordinal % 3 === 0 ? 0 : 1),
      row: 1,
      release: ordinal % 3 === 2,
    });
  }
  const samples = applicationMouseCausalSamples({
    records,
    receipts,
    evidenceKey: Buffer.alloc(32, 9),
    expected: {
      processId: expected.processId,
      semanticPaneId: expected.semanticPaneId,
      daemonGeneration: expected.daemonGeneration,
      canonicalGeneration: expected.canonicalGeneration,
      column: 2,
      row: 0,
    },
  });
  assert.equal(assessApplicationMouseDistribution(samples, appMouseExpectedPoint).qualified, true);
  assert.equal(samples[29].durationMicros, 8_114);
  assert.equal(samples[29].durationMs, 8.114);
  const wrongGesture = structuredClone(records);
  wrongGesture.find(
    (record) => record.type === "performance.input-origin" && record.pointerAction === "drag",
  ).gestureId = "20000000-0000-4000-8000-000000000099";
  assert.equal(
    assessApplicationMouseDistribution(
      applicationMouseCausalSamples({
        records: wrongGesture,
        receipts,
        evidenceKey: Buffer.alloc(32, 9),
        expected: {
          processId: expected.processId,
          semanticPaneId: expected.semanticPaneId,
          daemonGeneration: expected.daemonGeneration,
          canonicalGeneration: expected.canonicalGeneration,
          column: 2,
          row: 0,
        },
      }),
      appMouseExpectedPoint,
    ).qualified,
    false,
  );
  assert.equal(
    assessApplicationMouseDistribution(
      applicationMouseCausalSamples({
        records: records.filter(
          (record) => record.type !== "performance.terminal-frame-fence" || record.revision !== 4,
        ),
        receipts,
        evidenceKey: Buffer.alloc(32, 9),
        expected: {
          processId: expected.processId,
          semanticPaneId: expected.semanticPaneId,
          daemonGeneration: expected.daemonGeneration,
          canonicalGeneration: expected.canonicalGeneration,
          column: 2,
          row: 0,
        },
      }),
      appMouseExpectedPoint,
    ).qualified,
    false,
  );
});
