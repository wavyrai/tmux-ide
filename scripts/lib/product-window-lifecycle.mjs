import { createHash } from "node:crypto";

const MAX_SAMPLES = 512;
const WINDOW_SWITCH_PHASE_KEYS = Object.freeze([
  "startToSemanticReceiptMs",
  "startToCanonicalLayoutMs",
  "startToPresentationMs",
  "canonicalLayoutToPresentationMs",
  "presentationToActualFrameMs",
]);

export function assessWindowSwitchPhaseTimingRecords({ records, started, settled }) {
  const bounded = Array.isArray(records) && records.length <= 4_096 ? records : [];
  const exact = (phase) =>
    bounded.filter((record) => record?.phase === phase && record.traceId === started?.traceId);
  const receipts = exact("window-switch-receipt");
  const layouts = exact("window-switch-layout");
  const presentations = exact("window-switch-presentation");
  const identityKeys = [
    "traceId",
    "target",
    "paneId",
    "daemonGeneration",
    "clientGeneration",
    "rendererEpoch",
    "sourceEpoch",
    "generation",
    "incarnation",
    "revision",
    "stateHash",
    "cols",
    "rows",
    "processId",
    "clockId",
  ];
  const joined = [started, receipts[0], layouts[0], presentations[0], settled];
  const points = [
    started?.startedAtMicros,
    receipts[0]?.phaseAtMicros,
    layouts[0]?.phaseAtMicros,
    presentations[0]?.phaseAtMicros,
    settled?.phaseAtMicros,
  ];
  const exactCardinality =
    receipts.length === 1 && layouts.length === 1 && presentations.length === 1;
  const startShapeExact =
    started?.phase === "window-switch-start" &&
    typeof started.traceId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      started.traceId,
    ) &&
    ["target", "paneId", "daemonGeneration", "generation", "incarnation"].every(
      (key) =>
        typeof started[key] === "string" && started[key].length > 0 && started[key].length <= 256,
    ) &&
    ["clientGeneration", "rendererEpoch", "sourceEpoch", "revision"].every(
      (key) => Number.isSafeInteger(started[key]) && started[key] >= 0,
    ) &&
    Number.isSafeInteger(started.cols) &&
    started.cols > 0 &&
    Number.isSafeInteger(started.rows) &&
    started.rows > 0 &&
    typeof started.stateHash === "string" &&
    /^[0-9a-f]{16}$/u.test(started.stateHash) &&
    typeof started.processId === "string" &&
    /^opentui:[1-9][0-9]*$/u.test(started.processId) &&
    started.clockId === "opentui-performance-now" &&
    settled?.phase === "window-switch-settled";
  const phaseLabelsExact =
    receipts[0]?.phase === "window-switch-receipt" &&
    receipts[0]?.operationId === started?.traceId &&
    receipts[0]?.selected === true &&
    receipts[0]?.applied === true &&
    layouts[0]?.phase === "window-switch-layout" &&
    presentations[0]?.phase === "window-switch-presentation";
  const identityExact =
    startShapeExact &&
    exactCardinality &&
    phaseLabelsExact &&
    joined.every((record) => identityKeys.every((key) => record?.[key] === started?.[key]));
  const rawOrderExact =
    identityExact &&
    points.every((point) => Number.isSafeInteger(point) && point >= 0) &&
    points.slice(1).every((point) => point >= points[0]) &&
    points[3] >= points[2] &&
    points[4] >= points[1] &&
    points[4] >= points[3];
  if (!rawOrderExact)
    return Object.freeze({
      qualified: false,
      firstFailedPredicate: !exactCardinality
        ? "phase-cardinality"
        : !startShapeExact || !phaseLabelsExact || !identityExact
          ? "phase-identity"
          : "phase-monotonic",
      timing: null,
    });
  const duration = (left, right) => (right - left) / 1_000;
  return Object.freeze({
    qualified: true,
    firstFailedPredicate: null,
    timing: Object.freeze({
      startToSemanticReceiptMs: duration(points[0], points[1]),
      startToCanonicalLayoutMs: duration(points[0], points[2]),
      startToPresentationMs: duration(points[0], points[3]),
      canonicalLayoutToPresentationMs: duration(points[2], points[3]),
      presentationToActualFrameMs: duration(points[3], points[4]),
      receiptLayoutOrder:
        points[1] < points[2]
          ? "receipt-before-layout"
          : points[1] > points[2]
            ? "layout-before-receipt"
            : "simultaneous",
      totalMs: duration(points[0], points[4]),
    }),
  });
}

const OWNED_ACTION_CODES = new Set([
  "validation_failed",
  "bad_request",
  "daemon_instance_mismatch",
  "workspace_not_found",
  "workspace_unavailable",
  "operation_conflict",
  "operation_capacity",
  "pane_not_found",
  "window_not_found",
  "ambiguous_target",
  "mutation_failed",
  "mutation_unverified",
  "result_invalid",
  "internal",
]);
const OWNED_ACTION_REASONS = new Set([
  "authority_disposed",
  "session_unreachable",
  "window_name_mismatch",
  "pane_identity_changed",
  "generation_replaced",
  "controller_unavailable",
  "authenticated_controller_unavailable",
  "controller_conflict",
]);

export function ownedWindowActionFailureObservation({ action, operationId, status, payload }) {
  const code = OWNED_ACTION_CODES.has(payload?.error?.code) ? payload.error.code : "invalid";
  const reason = OWNED_ACTION_REASONS.has(payload?.error?.details?.reason)
    ? payload.error.details.reason
    : null;
  return Object.freeze({
    version: 1,
    operation: "window-owned-action",
    predicate: "action-result",
    action: ["workspace.pane.create", "workspace.rename"].includes(action) ? action : "invalid",
    operationId:
      typeof operationId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)
        ? operationId
        : null,
    status: Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null,
    ok: payload?.ok === true,
    resultPresent: payload?.result !== null && typeof payload?.result === "object",
    code,
    reason,
    issueCount: Array.isArray(payload?.error?.details?.issues)
      ? Math.min(payload.error.details.issues.length, 16)
      : 0,
  });
}

export function classifyWindowTmuxPostFailureSnapshot(result) {
  if (result?.status === "fulfilled")
    return Object.freeze({
      tmuxAvailable: true,
      tmuxWindowCount: Array.isArray(result.value) ? Math.min(result.value.length, 512) : 0,
      tmuxPreActionStateExact: true,
    });
  const snapshotReadButMismatched =
    result?.status === "rejected" &&
    result?.reason?.observation?.operation === "window-tmux-snapshot";
  const actualCount = result?.reason?.observation?.actualCount;
  return Object.freeze({
    tmuxAvailable: snapshotReadButMismatched,
    tmuxWindowCount:
      snapshotReadButMismatched && Number.isSafeInteger(actualCount)
        ? Math.min(Math.max(actualCount, 0), 512)
        : 0,
    tmuxPreActionStateExact: false,
  });
}

export function windowSwitchSelectionFailureObservation(
  record,
  startCount,
  receiptCount,
  failureCount,
) {
  const stage = [
    "authority-request",
    "pre-dispatch",
    "dispatch",
    "post-dispatch",
    "receipt",
  ].includes(record?.stage)
    ? record.stage
    : "invalid";
  const reason = [
    "authority-rejected",
    "generation-replaced",
    "operation-timeout",
    "transport-rejected",
    "receipt-invalid",
  ].includes(record?.reason)
    ? record.reason
    : "invalid";
  const backendReason = [
    "pane_inventory_not_ready",
    "pane_identity_changed_before_select",
    "pane_not_active",
  ].includes(record?.backendReason)
    ? record.backendReason
    : null;
  return Object.freeze({
    version: 1,
    operation: "window-switch",
    predicate: "selection-receipt",
    stage,
    reason,
    backendReason,
    startCount: Number.isSafeInteger(startCount) ? Math.min(Math.max(startCount, 0), 2) : 0,
    receiptCount: Number.isSafeInteger(receiptCount) ? Math.min(Math.max(receiptCount, 0), 2) : 0,
    failureCount: Number.isSafeInteger(failureCount) ? Math.min(Math.max(failureCount, 0), 2) : 0,
    selected: false,
    applied: false,
  });
}

export function windowSwitchInputFailureObservation({ boundary, ordinal, reason, timeoutMs }) {
  const exactBoundary = ["window-switch-visible", "window-switch-distribution"].includes(boundary)
    ? boundary
    : "window-switch-visible";
  const exactReason = ["aborted", "command-timeout", "command-failed"].includes(reason)
    ? reason
    : "command-failed";
  return Object.freeze({
    version: 1,
    operation: "window-switch-input",
    predicate: "hosted-control-key",
    boundary: exactBoundary,
    stage: exactBoundary,
    ordinal:
      exactBoundary === "window-switch-distribution" && Number.isSafeInteger(ordinal)
        ? Math.min(Math.max(ordinal, 0), 31)
        : null,
    reason: exactReason,
    timeoutMs: Number.isSafeInteger(timeoutMs) ? Math.min(Math.max(timeoutMs, 1), 5_000) : null,
  });
}

export function windowLifecycleWriterFailureObservation({ stage, health, records }) {
  const boundedRecords = Array.isArray(records) ? records.slice(-4_096) : [];
  const workspaceClientRecords = boundedRecords.filter(
    (record) => record?.phase === "generation-workspace-client-state",
  );
  const latestWorkspaceClient = workspaceClientRecords.at(-1);
  const revision = latestWorkspaceClient?.workspaceClient?.committed?.terminalResourceRevision;
  let acceptedWorkspaceClientStateBytes = 0;
  let consecutiveDuplicateWorkspaceClientStateCount = 0;
  let previousWorkspaceClientSignature = null;
  for (const record of workspaceClientRecords) {
    let serialized;
    try {
      serialized = JSON.stringify(record);
    } catch {
      previousWorkspaceClientSignature = null;
      continue;
    }
    if (typeof serialized !== "string") continue;
    acceptedWorkspaceClientStateBytes = Math.min(
      acceptedWorkspaceClientStateBytes + Buffer.byteLength(serialized, "utf8") + 1,
      16 * 1_024 * 1_024,
    );
    let signature;
    try {
      signature = JSON.stringify({
        daemonGeneration: record.daemonGeneration,
        workspaceClient: record.workspaceClient,
      });
    } catch {
      previousWorkspaceClientSignature = null;
      continue;
    }
    if (signature === previousWorkspaceClientSignature)
      consecutiveDuplicateWorkspaceClientStateCount += 1;
    previousWorkspaceClientSignature = signature;
  }
  return Object.freeze({
    version: 1,
    operation: "window-lifecycle",
    predicate: "lifecycle-writer-health",
    stage: stage === "switch" || stage === "rename" ? stage : "invalid",
    droppedRecords: Number.isSafeInteger(health?.droppedRecords)
      ? Math.min(Math.max(health.droppedRecords, 0), 65_536)
      : null,
    failed: typeof health?.failed === "boolean" ? health.failed : null,
    pendingCriticalRecords: Number.isSafeInteger(health?.pendingCriticalRecords)
      ? Math.min(Math.max(health.pendingCriticalRecords, 0), 16)
      : null,
    httpStartCount: Math.min(
      boundedRecords.filter((record) => record?.phase === "terminal-http-start").length,
      4_096,
    ),
    httpResponseCount: Math.min(
      boundedRecords.filter((record) => record?.phase === "terminal-http-response").length,
      4_096,
    ),
    acceptedWorkspaceClientStateCount: Math.min(workspaceClientRecords.length, 4_096),
    acceptedWorkspaceClientStateBytes,
    consecutiveDuplicateWorkspaceClientStateCount: Math.min(
      consecutiveDuplicateWorkspaceClientStateCount,
      4_096,
    ),
    terminalResourceRevision: Number.isSafeInteger(revision) && revision >= 0 ? revision : null,
  });
}

export function assessWindowPresentationFrames(frames, expected) {
  const boundedFrames = Array.isArray(frames) && frames.length <= 64 ? frames : [];
  const expectedTargetDigest = createHash("sha256")
    .update(expected?.target ?? "")
    .digest("hex");
  const expectedPaneDigest = createHash("sha256")
    .update(expected?.paneId ?? "")
    .digest("hex");
  const exactIdentity = (window) =>
    window?.kind === expected?.kind &&
    window.traceId === expected?.traceId &&
    window.targetIdentityDigest === expectedTargetDigest &&
    window.paneIdentityDigest === expectedPaneDigest &&
    window.daemonGeneration === expected?.daemonGeneration &&
    window.clientGeneration === expected?.clientGeneration &&
    window.rendererEpoch === expected?.rendererEpoch &&
    window.sourceEpoch === expected?.sourceEpoch &&
    window.generation === expected?.generation &&
    window.incarnation === expected?.incarnation &&
    window.revision === expected?.revision &&
    window.stateHash === expected?.stateHash &&
    window.cols === expected?.cols &&
    window.rows === expected?.rows &&
    typeof window.presentationDigest === "string" &&
    /^[0-9a-f]{64}$/u.test(window.presentationDigest) &&
    (window.presentationChanged === null || typeof window.presentationChanged === "boolean") &&
    typeof window.identityExact === "boolean" &&
    typeof window.targetVisible === "boolean" &&
    typeof window.settledTargetFrame === "boolean";
  const classified = boundedFrames.map((frame) => frame?.window).filter(exactIdentity);
  const settledIndexes = classified.flatMap((window, index) =>
    window.settledTargetFrame === true && window.targetVisible === true ? [index] : [],
  );
  const settledIndex = settledIndexes.length === 1 ? settledIndexes[0] : -1;
  const invalidIdentityFrameCount = classified.filter((window) => !window.identityExact).length;
  const targetVisibleChangedFrameCount =
    settledIndex < 0
      ? 0
      : classified
          .slice(0, settledIndex + 1)
          .filter(
            (window) =>
              window.identityExact && window.targetVisible && window.presentationChanged === true,
          ).length;
  const identicalPreSettleFrameCount =
    settledIndex > 0
      ? classified.slice(0, settledIndex).filter((window) => window.presentationChanged === false)
          .length
      : 0;
  const postSettled = settledIndex >= 0 ? classified.slice(settledIndex + 1) : [];
  const identicalPostSettleFrameCount = postSettled.filter(
    (window) =>
      window.presentationChanged === false ||
      window.presentationDigest === classified[settledIndex]?.presentationDigest,
  ).length;
  return Object.freeze({
    version: 1,
    expectedTargetDigest,
    expectedPaneDigest,
    classifiedFrameCount: classified.length,
    unclassifiedFrameCount: boundedFrames.length - classified.length,
    settledTargetFrameCount: settledIndexes.length,
    invalidIdentityFrameCount,
    targetVisibleChangedFrameCount,
    identicalPreSettleFrameCount,
    identicalPostSettleFrameCount,
    meaningfulPostSettleFrameCount: postSettled.length - identicalPostSettleFrameCount,
    settledPresentationDigest:
      settledIndex >= 0 ? classified[settledIndex].presentationDigest : null,
  });
}

function boundedId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function exactWindowSwitchPhaseTiming(timing, durationMs) {
  if (!timing || typeof timing !== "object") return false;
  const phases = WINDOW_SWITCH_PHASE_KEYS.map((key) => timing[key]);
  const daemon = timing.daemon;
  const daemonKeys = [
    "semantic_pane_inventory_lookupMs",
    "semantic_pane_resolutionMs",
    "tmux_selection_effect_proofMs",
    "semantic_mutation_effectMs",
  ];
  const orderExact =
    (timing.receiptLayoutOrder === "receipt-before-layout" &&
      timing.startToSemanticReceiptMs < timing.startToCanonicalLayoutMs) ||
    (timing.receiptLayoutOrder === "layout-before-receipt" &&
      timing.startToCanonicalLayoutMs < timing.startToSemanticReceiptMs) ||
    (timing.receiptLayoutOrder === "simultaneous" &&
      timing.startToCanonicalLayoutMs === timing.startToSemanticReceiptMs);
  return (
    phases.every((value) => Number.isFinite(value) && value >= 0 && value <= 10_000) &&
    Number.isFinite(timing.totalMs) &&
    timing.totalMs >= 0 &&
    timing.totalMs <= 10_000 &&
    orderExact &&
    timing.startToCanonicalLayoutMs <= timing.startToPresentationMs &&
    timing.startToSemanticReceiptMs <= timing.totalMs &&
    Math.abs(
      timing.startToPresentationMs -
        timing.startToCanonicalLayoutMs -
        timing.canonicalLayoutToPresentationMs,
    ) < 0.002 &&
    Math.abs(timing.startToPresentationMs + timing.presentationToActualFrameMs - timing.totalMs) <
      0.002 &&
    Math.abs(timing.totalMs - durationMs) < 0.002 &&
    daemon &&
    daemonKeys.every(
      (key) => Number.isFinite(daemon[key]) && daemon[key] >= 0 && daemon[key] <= 10_000,
    ) &&
    daemon.semantic_mutation_effectMs + 0.002 >=
      daemon.semantic_pane_inventory_lookupMs +
        daemon.semantic_pane_resolutionMs +
        daemon.tmux_selection_effect_proofMs
  );
}

export function summarizeWindowSwitchPhaseOutliers(samples, limit = 5) {
  if (!Array.isArray(samples) || samples.length > MAX_SAMPLES) return Object.freeze([]);
  const cap = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 0), 10) : 5;
  return Object.freeze(
    samples
      .filter((sample) => exactWindowSwitchPhaseTiming(sample?.phaseTiming, sample?.durationMs))
      .map((sample) =>
        Object.freeze({
          ordinal: sample.ordinal,
          totalMs: sample.phaseTiming.totalMs,
          ...Object.fromEntries(
            WINDOW_SWITCH_PHASE_KEYS.map((key) => [key, sample.phaseTiming[key]]),
          ),
          receiptLayoutOrder: sample.phaseTiming.receiptLayoutOrder,
          daemonSemanticMutationMs: sample.phaseTiming.daemon.semantic_mutation_effectMs,
          daemonInventoryLookupMs: sample.phaseTiming.daemon.semantic_pane_inventory_lookupMs,
          daemonPaneResolutionMs: sample.phaseTiming.daemon.semantic_pane_resolutionMs,
          daemonTmuxSelectionProofMs: sample.phaseTiming.daemon.tmux_selection_effect_proofMs,
        }),
      )
      .sort((left, right) => right.totalMs - left.totalMs || left.ordinal - right.ordinal)
      .slice(0, cap),
  );
}

function exactWindowPresentationWork(renderWork) {
  const presentation = renderWork?.presentation;
  return (
    Number.isSafeInteger(renderWork?.frameCount) &&
    renderWork.frameCount >= 1 &&
    renderWork.frameCount <= 64 &&
    presentation?.version === 1 &&
    presentation.classifiedFrameCount === renderWork.frameCount &&
    presentation.unclassifiedFrameCount === 0 &&
    presentation.invalidIdentityFrameCount === 0 &&
    presentation.settledTargetFrameCount === 1 &&
    Number.isSafeInteger(presentation.targetVisibleChangedFrameCount) &&
    presentation.targetVisibleChangedFrameCount >= 1 &&
    presentation.targetVisibleChangedFrameCount <= renderWork.frameCount &&
    presentation.identicalPreSettleFrameCount === 0 &&
    presentation.identicalPostSettleFrameCount === 0 &&
    Number.isSafeInteger(presentation.meaningfulPostSettleFrameCount) &&
    presentation.meaningfulPostSettleFrameCount >= 0 &&
    presentation.meaningfulPostSettleFrameCount <= 63 &&
    typeof presentation.expectedTargetDigest === "string" &&
    /^[0-9a-f]{64}$/u.test(presentation.expectedTargetDigest) &&
    typeof presentation.expectedPaneDigest === "string" &&
    /^[0-9a-f]{64}$/u.test(presentation.expectedPaneDigest) &&
    typeof presentation.settledPresentationDigest === "string" &&
    /^[0-9a-f]{64}$/u.test(presentation.settledPresentationDigest)
  );
}

export function windowApplicationShellTimeoutObservation({
  resources,
  expectedCount,
  attempts,
  elapsedMs,
  revision,
}) {
  const boundedResources = Array.isArray(resources) ? resources.slice(0, 513) : [];
  const identityDigest = createHash("sha256")
    .update(
      JSON.stringify(
        boundedResources.map(({ resourceId, windowResourceId, semanticPaneId, active }) => [
          boundedId(resourceId) ? resourceId : null,
          boundedId(windowResourceId) ? windowResourceId : null,
          boundedId(semanticPaneId) ? semanticPaneId : null,
          active === true,
        ]),
      ),
    )
    .digest("hex");
  return Object.freeze({
    operation: "window-application-shell-wait",
    reason: "timeout",
    samples: Number.isSafeInteger(attempts) ? Math.min(Math.max(attempts, 0), 10_000) : 0,
    elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs)) : 0,
    expectedCount: Number.isSafeInteger(expectedCount) ? expectedCount : null,
    actualCount: Math.min(boundedResources.length, 513),
    activeCount: Math.min(boundedResources.filter(({ active }) => active === true).length, 513),
    revision: Number.isSafeInteger(revision) ? revision : null,
    identityDigest,
  });
}

export function summarizeWindowPartialRuntimeEvidence({
  lifecycleText,
  lifecycleRecords,
  lifecycleReadReason = null,
  referenceText,
  referenceRecords,
  referenceReadReason = null,
}) {
  const boundedReadReason = (value) =>
    ["invalid-path", "invalid-file", "file-changed", "read-failed"].includes(value)
      ? value
      : value === null
        ? null
        : "read-failed";
  const lifecycle = Array.isArray(lifecycleRecords) ? lifecycleRecords.slice(-10_000) : [];
  const reference = Array.isArray(referenceRecords) ? referenceRecords.slice(-10_000) : [];
  const boundedLifecycleText =
    typeof lifecycleText === "string" ? lifecycleText.slice(-64 * 1024) : "";
  const boundedReferenceText =
    typeof referenceText === "string" ? referenceText.slice(-64 * 1024) : "";
  const latestWorkspaceClient = lifecycle.findLast(
    (record) => record?.phase === "generation-workspace-client-state",
  );
  const committed = latestWorkspaceClient?.workspaceClient?.committed;
  const derived = latestWorkspaceClient?.workspaceClient?.derived;
  const latestShell = lifecycle.findLast(
    (record) => record?.phase === "generation-shell-lifecycle",
  );
  const latestLayout = lifecycle.findLast((record) => record?.phase === "layout-publication");
  const count = (records, key, value) =>
    Math.min(records.filter((record) => record?.[key] === value).length, 10_000);
  return Object.freeze({
    version: 1,
    lifecycle: Object.freeze({
      available: boundedLifecycleText.length > 0,
      readReason: boundedLifecycleText.length > 0 ? null : boundedReadReason(lifecycleReadReason),
      retainedBytes: boundedLifecycleText.length,
      retainedRecordCount: lifecycle.length,
      retainedDigest: boundedLifecycleText
        ? createHash("sha256").update(boundedLifecycleText).digest("hex")
        : null,
      layoutPublicationCount: count(lifecycle, "phase", "layout-publication"),
      workspaceClientStateCount: count(lifecycle, "phase", "generation-workspace-client-state"),
      firstTerminalFrameCount: count(lifecycle, "phase", "first-terminal-frame"),
      latestLayout: latestLayout
        ? Object.freeze({
            windows: Number.isSafeInteger(latestLayout.windows) ? latestLayout.windows : null,
            panes: Number.isSafeInteger(latestLayout.panes) ? latestLayout.panes : null,
            monotonicMicros: Number.isSafeInteger(latestLayout.monotonicMicros)
              ? latestLayout.monotonicMicros
              : null,
          })
        : null,
      latestShell: latestShell
        ? Object.freeze({
            status: ["loading", "live", "failed"].includes(latestShell.shellStatus)
              ? latestShell.shellStatus
              : null,
            inventoryResources: Number.isSafeInteger(latestShell.inventoryResources)
              ? Math.min(Math.max(latestShell.inventoryResources, 0), 513)
              : null,
            monotonicMicros: Number.isSafeInteger(latestShell.monotonicMicros)
              ? latestShell.monotonicMicros
              : null,
          })
        : null,
      latestWorkspaceClient: Object.freeze({
        processIdExact: boundedId(latestWorkspaceClient?.processId),
        daemonGenerationExact: boundedId(latestWorkspaceClient?.daemonGeneration),
        clientPhase: ["loading", "live", "failed"].includes(committed?.phase)
          ? committed.phase
          : null,
        clientGeneration: Number.isSafeInteger(committed?.generation) ? committed.generation : null,
        pendingCount: Math.min(
          Array.isArray(latestWorkspaceClient?.workspaceClient?.pending)
            ? latestWorkspaceClient.workspaceClient.pending.length
            : 0,
          513,
        ),
        committedResourceCount: Math.min(
          Array.isArray(committed?.terminalResources) ? committed.terminalResources.length : 0,
          513,
        ),
        derivedResourceCount: Math.min(
          Array.isArray(derived?.terminalInventory?.resources)
            ? derived.terminalInventory.resources.length
            : 0,
          513,
        ),
        terminalResourceRevision: Number.isSafeInteger(committed?.terminalResourceRevision)
          ? committed.terminalResourceRevision
          : null,
        authorityRevision: Number.isSafeInteger(committed?.authority?.revision)
          ? committed.authority.revision
          : null,
        authorityOwnerCount: Math.min(
          ["input", "focus", "geometry"].filter(
            (kind) => typeof committed?.authority?.owners?.[kind] === "string",
          ).length,
          3,
        ),
        authorityOwnerPresence: Object.freeze({
          input: typeof committed?.authority?.owners?.input === "string",
          focus: typeof committed?.authority?.owners?.focus === "string",
          geometry: typeof committed?.authority?.owners?.geometry === "string",
        }),
        opentuiClientState: ["foreground", "background"].includes(
          committed?.authority?.clients?.find((client) => client?.surface === "opentui")?.state,
        )
          ? committed.authority.clients.find((client) => client?.surface === "opentui").state
          : null,
      }),
    }),
    referenceTrace: Object.freeze({
      available: boundedReferenceText.length > 0,
      readReason: boundedReferenceText.length > 0 ? null : boundedReadReason(referenceReadReason),
      retainedBytes: boundedReferenceText.length,
      retainedRecordCount: reference.length,
      retainedDigest: boundedReferenceText
        ? createHash("sha256").update(boundedReferenceText).digest("hex")
        : null,
      canonicalPublicationCount: count(
        reference,
        "type",
        "performance.terminal-canonical-publication",
      ),
      terminalPaintCount: count(reference, "type", "performance.terminal-paint"),
      frameCount: count(reference, "type", "performance.frame"),
    }),
  });
}

export function joinWindowResourcesToTmuxLabels(resources, tmuxRows) {
  if (!Array.isArray(resources) || !Array.isArray(tmuxRows) || resources.length !== tmuxRows.length)
    throw new Error("window resource/tmux label cardinality diverged");
  return Object.freeze(
    resources.map((resource) => {
      const matches = tmuxRows.filter(
        (row) =>
          row?.semanticPaneId === resource?.semanticPaneId &&
          boundedId(row?.resourceId) &&
          `terminal-window.${createHash("sha256")
            .update(row.resourceId)
            .digest("hex")
            .slice(0, 20)}` === resource?.windowResourceId,
      );
      if (
        matches.length !== 1 ||
        typeof matches[0].name !== "string" ||
        matches[0].name.length < 1 ||
        matches[0].name.length > 256 ||
        /[\0\r\n]/u.test(matches[0].name)
      )
        throw new Error("window resource did not join one exact tmux window label");
      return Object.freeze({ ...resource, name: matches[0].name });
    }),
  );
}

function percentile(sorted, percentileValue) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

function exactIdentity(actual, expected) {
  return (
    actual?.processId === expected.processId &&
    actual?.daemonGeneration === expected.daemonGeneration &&
    actual?.clientGeneration === expected.clientGeneration &&
    actual?.workspaceName === expected.workspaceName &&
    actual?.sessionName === expected.sessionName
  );
}

function exactWindow(window, expected, { name = expected.name, active = expected.active } = {}) {
  return (
    boundedId(window?.resourceId) &&
    window.resourceId === expected.resourceId &&
    boundedId(window?.semanticPaneId) &&
    window.semanticPaneId === expected.semanticPaneId &&
    boundedId(window?.name) &&
    window.name === name &&
    window.active === active
  );
}

function exactTmuxSnapshot(rows, windows) {
  if (!Array.isArray(rows) || rows.length !== windows.length) return false;
  return (
    rows.filter((row) => row?.active === true).length === 1 &&
    rows.every((row) => {
      const window = windows.find(({ semanticPaneId }) => semanticPaneId === row?.semanticPaneId);
      const geometry = row?.geometry;
      return (
        window !== undefined &&
        boundedId(row?.resourceId) &&
        /^@[0-9]+$/u.test(row?.nativeWindowId ?? "") &&
        /^%[0-9]+$/u.test(row?.paneId ?? "") &&
        row.name === window.name &&
        row.active === window.active &&
        [
          geometry?.windowCols,
          geometry?.windowRows,
          geometry?.left,
          geometry?.top,
          geometry?.cols,
          geometry?.rows,
        ].every(Number.isSafeInteger) &&
        geometry.windowCols > 0 &&
        geometry.windowRows > 0 &&
        geometry.left >= 0 &&
        geometry.top >= 0 &&
        geometry.cols > 0 &&
        geometry.rows > 0
      );
    })
  );
}

function sameTmuxGeometry(left, right, semanticPaneId) {
  const a = left?.find((row) => row?.semanticPaneId === semanticPaneId);
  const b = right?.find((row) => row?.semanticPaneId === semanticPaneId);
  return (
    a !== undefined &&
    b !== undefined &&
    a.resourceId === b.resourceId &&
    a.nativeWindowId === b.nativeWindowId &&
    a.paneId === b.paneId &&
    JSON.stringify(a.geometry) === JSON.stringify(b.geometry)
  );
}

function normalizeWindowResources(committed, derived) {
  if (
    !Array.isArray(committed) ||
    committed.length < 1 ||
    committed.length > 512 ||
    !Array.isArray(derived) ||
    derived.length !== committed.length
  )
    return null;
  const normalize = (resources, committedKind) => {
    const ids = new Set();
    const panes = new Set();
    const tuples = [];
    for (const resource of resources) {
      const id = committedKind ? resource?.resourceId : resource?.id;
      const pane = committedKind
        ? resource?.semanticPaneId
        : resource?.attachability?.status === "available"
          ? resource.attachability.semanticPaneId
          : null;
      const windowId = resource?.windowResourceId ?? id;
      const title = committedKind ? resource?.resourceTitle : resource?.title;
      if (
        !boundedId(id) ||
        !boundedId(windowId) ||
        !boundedId(pane) ||
        typeof title !== "string" ||
        title.length < 1 ||
        title.length > 256 ||
        [...title].some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
        }) ||
        typeof resource?.active !== "boolean" ||
        ids.has(id) ||
        panes.has(pane)
      )
        return null;
      ids.add(id);
      panes.add(pane);
      tuples.push([id, windowId, pane, title, resource.active]);
    }
    return tuples.sort(([left], [right]) => left.localeCompare(right));
  };
  const left = normalize(committed, true);
  const right = normalize(derived, false);
  return left && right && JSON.stringify(left) === JSON.stringify(right) ? left : null;
}

/** Latest-only, same-record WorkspaceClient proof for window convergence. */
export function qualifyWindowWorkspaceState(records, expected) {
  const matches = records.filter(
    (record) =>
      record?.phase === "generation-workspace-client-state" &&
      record.processId === expected.processId &&
      record.daemonGeneration === expected.daemonGeneration &&
      Number.isSafeInteger(record.monotonicMicros) &&
      record.monotonicMicros >= expected.afterMicros,
  );
  const record = matches.at(-1);
  const committed = record?.workspaceClient?.committed;
  const pending = record?.workspaceClient?.pending;
  const derived = record?.workspaceClient?.derived;
  const resources = normalizeWindowResources(
    committed?.terminalResources,
    derived?.terminalInventory?.resources,
  );
  const expectedTuples = Array.isArray(expected.resources)
    ? expected.resources
        .map((resource) => [
          resource.resourceId,
          resource.windowResourceId ?? resource.resourceId,
          resource.semanticPaneId,
          resource.resourceTitle,
          resource.active,
        ])
        .sort(([left], [right]) => left.localeCompare(right))
    : null;
  const titlesExact =
    resources !== null &&
    expectedTuples !== null &&
    resources.length === expectedTuples.length &&
    resources.every(
      (resource, index) =>
        resource[0] === expectedTuples[index]?.[0] && resource[3] === expectedTuples[index]?.[3],
    );
  const clients = committed?.authority?.clients;
  const tuiClients = Array.isArray(clients)
    ? clients.filter((client) => client?.clientId === expected.clientId)
    : [];
  const webClients = Array.isArray(clients)
    ? clients.filter((client) => client?.surface === "web")
    : [];
  const clientsExact =
    expected.web === true
      ? clients?.length === 2 && tuiClients.length === 1 && webClients.length === 1
      : clients?.length === 1 && tuiClients.length === 1 && webClients.length === 0;
  const terminalResourceRevision = committed?.terminalResourceRevision;
  const lastReceipt = committed?.lastReceipt;
  const acknowledgement = committed?.lastResourceChangeAcknowledgement;
  const receiptExact =
    expected.receipt === undefined ||
    (lastReceipt?.type === "interaction.receipt" &&
      lastReceipt.operationId === expected.receipt.operationId &&
      lastReceipt.operationKind === expected.receipt.operationKind &&
      lastReceipt.phase === "observed" &&
      lastReceipt.proof?.operationKind === expected.receipt.operationKind &&
      lastReceipt.proof?.outcome === "applied" &&
      (expected.receipt.semanticPaneId === undefined ||
        lastReceipt.proof.semanticPaneId === expected.receipt.semanticPaneId) &&
      (expected.receipt.scope === undefined || lastReceipt.proof.scope === expected.receipt.scope));
  const acknowledgementExact =
    expected.acknowledgement === undefined ||
    (acknowledgement?.daemonInstanceId === expected.acknowledgement.daemonInstanceId &&
      acknowledgement.operationId === expected.acknowledgement.operationId &&
      Number.isSafeInteger(acknowledgement.sequence) &&
      acknowledgement.sequence > expected.acknowledgement.afterSequence &&
      Number.isSafeInteger(acknowledgement.revision) &&
      acknowledgement.revision >= 0);
  const revisionExact =
    Number.isSafeInteger(terminalResourceRevision) &&
    terminalResourceRevision >= 0 &&
    (expected.minimumTerminalResourceRevision === undefined ||
      terminalResourceRevision >= expected.minimumTerminalResourceRevision) &&
    (expected.exactTerminalResourceRevision === undefined ||
      terminalResourceRevision === expected.exactTerminalResourceRevision);
  const generationExact = committed?.generation === expected.clientGeneration;
  const phaseExact = committed?.phase === "live";
  const targetDaemonExact = committed?.target?.daemon?.instanceId === expected.daemonGeneration;
  const targetWorkspaceExact = committed?.target?.workspaceName === expected.workspaceName;
  const workspaceIdentityExact =
    committed?.authorityWorkspaceId === derived?.workspace?.id &&
    committed?.authorityWorkspaceName === derived?.workspace?.name;
  const authorityGenerationExact = committed?.authority?.generation === expected.daemonGeneration;
  const authoritySessionExact = committed?.authority?.session === expected.sessionName;
  const pendingExact = Array.isArray(pending) && pending.length === 0;
  const tuiClientSurfaceExact = tuiClients[0]?.surface === "opentui";
  const tuiClientStateExact = tuiClients[0]?.state === "foreground";
  const authorityOwnersExact = ["input", "focus", "geometry"].every(
    (kind) => committed?.authority?.owners?.[kind] === expected.clientId,
  );
  const resourcesExact =
    resources !== null && JSON.stringify(resources) === JSON.stringify(expectedTuples);
  const activeResourceExact =
    derived?.terminalInventory?.activeResourceId ===
    expected.resources?.find((resource) => resource?.active === true)?.resourceId;
  const predicateValues = [
    ["record-present", matches.length > 0],
    ["generation", generationExact],
    ["phase", phaseExact],
    ["target-daemon", targetDaemonExact],
    ["target-workspace", targetWorkspaceExact],
    ["workspace-identity", workspaceIdentityExact],
    ["authority-generation", authorityGenerationExact],
    ["authority-session", authoritySessionExact],
    ["pending-empty", pendingExact],
    ["clients", clientsExact],
    ["receipt", receiptExact],
    ["acknowledgement", acknowledgementExact],
    ["terminal-resource-revision", revisionExact],
    ["tui-client-surface", tuiClientSurfaceExact],
    ["tui-client-state", tuiClientStateExact],
    ["authority-owners", authorityOwnersExact],
    ["resources", resourcesExact],
    ["active-resource", activeResourceExact],
  ];
  const passed = predicateValues.every(([, value]) => value === true);
  if (passed) return Object.freeze({ record, committed, pending, derived });
  const error = new Error("exact window WorkspaceClient state is unavailable");
  error.boundary = expected.boundary;
  error.observation = Object.freeze({
    operation: "qualify-window-workspace-client",
    firstFailedPredicate: predicateValues.find(([, value]) => value !== true)?.[0] ?? null,
    matches: Math.min(matches.length, 513),
    phaseExact,
    targetDaemonExact,
    targetWorkspaceExact,
    workspaceIdentityExact,
    authorityGenerationExact,
    authoritySessionExact,
    pendingExact,
    committedDerivedExact: resources !== null,
    resourcesExact:
      resources !== null && JSON.stringify(resources) === JSON.stringify(expectedTuples),
    titlesExact,
    expectedActiveCount: Array.isArray(expected.resources)
      ? Math.min(expected.resources.filter((resource) => resource?.active === true).length, 513)
      : 0,
    committedActiveCount: Array.isArray(committed?.terminalResources)
      ? Math.min(
          committed.terminalResources.filter((resource) => resource?.active === true).length,
          513,
        )
      : 0,
    derivedActiveCount: Array.isArray(derived?.terminalInventory?.resources)
      ? Math.min(
          derived.terminalInventory.resources.filter((resource) => resource?.active === true)
            .length,
          513,
        )
      : 0,
    activeResourceExact,
    clientsExact,
    tuiClientSurfaceExact,
    tuiClientStateExact,
    authorityOwnersExact,
    authorityOwnerCount: Math.min(
      ["input", "focus", "geometry"].filter(
        (kind) => typeof committed?.authority?.owners?.[kind] === "string",
      ).length,
      3,
    ),
    authorityOwnerPresence: Object.freeze({
      input: typeof committed?.authority?.owners?.input === "string",
      focus: typeof committed?.authority?.owners?.focus === "string",
      geometry: typeof committed?.authority?.owners?.geometry === "string",
    }),
    receiptExact,
    acknowledgementPresent: acknowledgement !== null && acknowledgement !== undefined,
    acknowledgementDaemonExact:
      expected.acknowledgement === undefined ||
      acknowledgement?.daemonInstanceId === expected.acknowledgement.daemonInstanceId,
    acknowledgementOperationExact:
      expected.acknowledgement === undefined ||
      acknowledgement?.operationId === expected.acknowledgement.operationId,
    acknowledgementSequenceNewer:
      expected.acknowledgement === undefined ||
      (Number.isSafeInteger(acknowledgement?.sequence) &&
        acknowledgement.sequence > expected.acknowledgement.afterSequence),
    acknowledgementRevisionSafe:
      expected.acknowledgement === undefined ||
      (Number.isSafeInteger(acknowledgement?.revision) && acknowledgement.revision >= 0),
    generationExact,
    revisionExact,
  });
  throw error;
}

/** Pure, fail-closed proof for one isolated real-tmux window lifecycle. */
export function assessProductWindowLifecycle({ evidence, expected }) {
  const predicates = [];
  const check = (id, passed, actual = null) =>
    predicates.push(Object.freeze({ id, passed: passed === true, actual }));
  const baseline = evidence?.baseline;
  const created = evidence?.created;
  const primed = evidence?.primed;
  const renamed = evidence?.renamed;
  const switches = evidence?.switches;
  const switchTraceIds = new Set();
  check("window-baseline-identity", exactIdentity(baseline, expected));
  check(
    "window-baseline-state",
    boundedId(expected.initial.semanticWindowId) &&
      exactWindow(baseline?.selected, expected.initial, { active: true }) &&
      Array.isArray(baseline?.windows) &&
      baseline.windows.length === 1 &&
      baseline.tmux?.[0]?.resourceId === expected.initial.semanticWindowId,
  );
  check("window-baseline-tmux", exactTmuxSnapshot(baseline?.tmux, baseline?.windows ?? []));
  check("window-create-identity", exactIdentity(created, expected));
  check(
    "window-create-receipt",
    created?.actionResult?.operationId === created?.operationId &&
      boundedId(created?.operationId) &&
      created.actionResult.daemonInstanceId === expected.daemonGeneration &&
      created.actionResult.outcome === "created" &&
      created.actionResult.resource?.kind === "terminal" &&
      created.actionResult.resource?.resourceVersion === 1 &&
      created.actionResult.resource?.workspaceName === expected.workspaceName &&
      created.actionResult.resource?.semanticPaneId === expected.created.semanticPaneId &&
      created.actionResult.resource?.displayTitle === expected.created.name &&
      Number.isSafeInteger(baseline?.terminalResourceRevision) &&
      Number.isSafeInteger(created?.terminalResourceRevision) &&
      created.terminalResourceRevision > baseline.terminalResourceRevision &&
      exactWindow(created?.selected, expected.created, { active: false }) &&
      Array.isArray(created?.windows) &&
      created.windows.length === 2 &&
      created.windows.filter((window) => window.active === true).length === 1 &&
      exactWindow(
        created.windows.find((window) => window.resourceId === expected.initial.resourceId),
        expected.initial,
        { active: true },
      ),
  );
  check(
    "window-create-tmux",
    exactTmuxSnapshot(created?.tmux, created?.windows ?? []) &&
      sameTmuxGeometry(baseline?.tmux, created?.tmux, expected.initial.semanticPaneId),
  );
  check(
    "window-first-switch",
    exactIdentity(primed, expected) &&
      boundedId(primed?.traceId) &&
      primed?.operationId === primed.traceId &&
      primed?.selectionApplied === true &&
      primed?.targetResourceId === expected.created.resourceId &&
      primed?.visibleFrame?.semanticPaneId === expected.created.semanticPaneId &&
      primed?.fence?.traceId === primed?.traceId &&
      primed?.fence?.writerHealth?.droppedRecords === 0 &&
      primed?.fence?.writerHealth?.failed === false &&
      primed?.fence?.writerHealth?.pendingCriticalRecords === 0 &&
      primed?.delivery?.kind === "control-key" &&
      primed?.delivery?.requestedKey === "t" &&
      primed?.delivery?.bytesInjected === 1 &&
      exactTmuxSnapshot(
        primed?.tmux,
        created.windows.map((window) => ({
          ...window,
          active: window.resourceId === expected.created.resourceId,
        })),
      ) &&
      [expected.initial.semanticPaneId, expected.created.semanticPaneId].every((paneId) =>
        sameTmuxGeometry(created.tmux, primed.tmux, paneId),
      ),
  );
  const structuralSamplesExact =
    Array.isArray(switches) &&
    Array.isArray(renamed?.windows) &&
    switches.length >= 30 &&
    switches.length <= MAX_SAMPLES &&
    switches.every((sample, ordinal) => {
      const uniqueTrace = boundedId(sample?.traceId) && !switchTraceIds.has(sample.traceId);
      if (uniqueTrace) switchTraceIds.add(sample.traceId);
      return (
        sample?.ordinal === ordinal &&
        exactIdentity(sample, expected) &&
        uniqueTrace &&
        sample.operationId === sample.traceId &&
        sample.selectionApplied === true &&
        sample.targetResourceId ===
          (ordinal % 2 === 0 ? expected.initial.resourceId : expected.created.resourceId) &&
        sample.visibleFrame?.resourceId === sample.targetResourceId &&
        sample.visibleFrame?.semanticPaneId ===
          (ordinal % 2 === 0 ? expected.initial.semanticPaneId : expected.created.semanticPaneId) &&
        sample.fence?.traceId === sample.traceId &&
        sample.fence?.writerHealth?.droppedRecords === 0 &&
        sample.fence?.writerHealth?.failed === false &&
        sample.fence?.writerHealth?.pendingCriticalRecords === 0 &&
        sample.delivery?.kind === "control-key" &&
        sample.delivery?.requestedKey === "t" &&
        sample.delivery?.delivery === "exact-bytes-to-immutable-host-pane-pty" &&
        sample.delivery?.bytesInjected === 1 &&
        sample.delivery?.phases === 1 &&
        exactTmuxSnapshot(
          sample.tmux,
          renamed.windows.map((window) => ({
            ...window,
            active: window.resourceId === sample.targetResourceId,
          })),
        ) &&
        [expected.initial.semanticPaneId, expected.created.semanticPaneId].every((paneId) =>
          sameTmuxGeometry(created.tmux, sample.tmux, paneId),
        ) &&
        Number.isFinite(sample.durationMs) &&
        sample.durationMs >= 0 &&
        exactWindowSwitchPhaseTiming(sample.phaseTiming, sample.durationMs)
      );
    });
  const samplesExact =
    structuralSamplesExact &&
    switches.every(
      (sample) =>
        sample.renderWork?.terminalPaintCount === 0 &&
        sample.renderWork?.canonicalPublicationCount === 0 &&
        sample.renderWork?.canonicalPaintCount === 0 &&
        sample.renderWork?.canonicalUpdateCount === 0 &&
        exactWindowPresentationWork(sample.renderWork) &&
        sample.renderWork?.quiet === true &&
        Number.isSafeInteger(sample.renderWork?.stableSamples) &&
        sample.renderWork.stableSamples >= 2 &&
        sample.renderWork.stableSamples <= 64 &&
        Number.isSafeInteger(sample.renderWork?.quietDurationMs) &&
        sample.renderWork.quietDurationMs >= 300 &&
        typeof sample.renderWork?.traceDigest === "string" &&
        /^[0-9a-f]{64}$/u.test(sample.renderWork.traceDigest),
    );
  const durations = structuralSamplesExact
    ? switches.map(({ durationMs }) => durationMs).sort((left, right) => left - right)
    : [];
  const p95Ms = durations.length >= 30 ? percentile(durations, 0.95) : null;
  const phaseOutliers = structuralSamplesExact
    ? summarizeWindowSwitchPhaseOutliers(switches)
    : Object.freeze([]);
  check("window-switch-samples", samplesExact, Array.isArray(switches) ? switches.length : null);
  check("window-switch-visible-frame", samplesExact);
  check("window-switch-p95-budget", Number.isFinite(p95Ms) && p95Ms <= 150, p95Ms);
  check("window-rename-identity", exactIdentity(renamed, expected));
  const renameAcknowledgement =
    renamed?.workspaceClient?.committed?.lastResourceChangeAcknowledgement;
  const renamedDerivedResource =
    renamed?.workspaceClient?.derived?.terminalInventory?.resources?.find(
      (resource) => resource?.id === expected.created.resourceId,
    );
  check(
    "window-rename-receipt",
    renamed?.actionResult?.operationId === renamed?.operationId &&
      boundedId(renamed?.operationId) &&
      renamed.actionResult.daemonInstanceId === expected.daemonGeneration &&
      renamed.actionResult.outcome === "applied" &&
      renamed.actionResult.verb === "workspace.rename" &&
      renamed.actionResult.scope === "window" &&
      renamed.actionResult.name === expected.renamedName &&
      renamed.actionResult.workspaceName === expected.workspaceName &&
      exactWindow(renamed?.selected, expected.created, {
        name: expected.renamedName,
        active: true,
      }) &&
      Number.isSafeInteger(created?.terminalResourceRevision) &&
      Number.isSafeInteger(renamed?.terminalResourceRevision) &&
      renamed.terminalResourceRevision === created.terminalResourceRevision &&
      Array.isArray(renamed?.workspaceClient?.pending) &&
      renamed.workspaceClient.pending.length === 0 &&
      renameAcknowledgement?.daemonInstanceId === expected.daemonGeneration &&
      renameAcknowledgement.operationId === renamed.operationId &&
      Number.isSafeInteger(renameAcknowledgement.sequence) &&
      Number.isSafeInteger(renamed.acknowledgementWatermark) &&
      renamed.acknowledgementWatermark >= -1 &&
      renameAcknowledgement.sequence > renamed.acknowledgementWatermark &&
      Number.isSafeInteger(renameAcknowledgement.revision) &&
      renameAcknowledgement.revision >= 0 &&
      renamedDerivedResource?.title === expected.renamedName &&
      renamedDerivedResource?.active === true &&
      renamed.workspaceClient.derived.terminalInventory.activeResourceId ===
        expected.created.resourceId,
  );
  const renamePresentation = renamed?.presentation;
  const renameIdentity = renamePresentation?.started;
  check(
    "window-rename-visible-frame",
    boundedId(renamePresentation?.traceId) &&
      renamePresentation.presented?.traceId === renamePresentation.traceId &&
      renamePresentation.fence?.traceId === renamePresentation.traceId &&
      renameIdentity?.paneId === expected.created.semanticPaneId &&
      renameIdentity?.target === expected.created.semanticWindowId &&
      renameIdentity?.windowName === expected.renamedName &&
      renameIdentity?.sourceEpoch === primed?.canonicalIdentity?.sourceEpoch &&
      renameIdentity?.generation === primed?.canonicalIdentity?.generation &&
      renameIdentity?.incarnation === primed?.canonicalIdentity?.incarnation &&
      renameIdentity?.revision === primed?.canonicalIdentity?.revision &&
      renameIdentity?.stateHash === primed?.canonicalIdentity?.stateHash &&
      renameIdentity?.cols === primed?.canonicalIdentity?.cols &&
      renameIdentity?.rows === primed?.canonicalIdentity?.rows &&
      renamePresentation.fence?.writerHealth?.droppedRecords === 0 &&
      renamePresentation.fence?.writerHealth?.failed === false &&
      renamePresentation.fence?.writerHealth?.pendingCriticalRecords === 0 &&
      renamePresentation.renderWork?.terminalPaintCount === 0 &&
      renamePresentation.renderWork?.canonicalPublicationCount === 0 &&
      renamePresentation.renderWork?.canonicalPaintCount === 0 &&
      renamePresentation.renderWork?.canonicalUpdateCount === 0 &&
      exactWindowPresentationWork(renamePresentation.renderWork) &&
      renamePresentation.renderWork?.quiet === true &&
      Number.isSafeInteger(renamePresentation.renderWork?.stableSamples) &&
      renamePresentation.renderWork.stableSamples >= 2 &&
      renamePresentation.renderWork.stableSamples <= 64 &&
      Number.isSafeInteger(renamePresentation.renderWork?.quietDurationMs) &&
      renamePresentation.renderWork.quietDurationMs >= 300,
  );
  check(
    "window-rename-tmux",
    exactTmuxSnapshot(renamed?.tmux, renamed?.windows ?? []) &&
      [expected.initial.semanticPaneId, expected.created.semanticPaneId].every((paneId) =>
        sameTmuxGeometry(created?.tmux, renamed?.tmux, paneId),
      ),
  );
  check(
    "window-correlation",
    evidence?.correlation?.daemon === true &&
      evidence.correlation.workspaceClient === true &&
      evidence.correlation.tui === true &&
      evidence.correlation.web === true &&
      evidence.correlation.tmux === true,
  );
  const webWindows = evidence?.web?.semantic?.windows;
  const expectedWebWindows = [expected.initial, expected.created];
  check(
    "window-web-labels",
    Array.isArray(webWindows) &&
      webWindows.length === 2 &&
      expectedWebWindows.every((window) => {
        const matches = webWindows.filter(
          (candidate) =>
            candidate?.windowResourceId === (window.windowResourceId ?? window.resourceId),
        );
        if (matches.length !== 1) return false;
        const match = matches[0];
        return (
          match.label === (window === expected.created ? expected.renamedName : window.name) &&
          match.active === (window === expected.created ? "true" : "false")
        );
      }),
  );
  const firstFailedPredicate = predicates.find(({ passed }) => !passed)?.id ?? null;
  return Object.freeze({
    qualified: firstFailedPredicate === null,
    firstFailedPredicate,
    predicates: Object.freeze(predicates),
    metrics: Object.freeze({
      sampleCount: durations.length,
      p95Ms,
      phaseOutliers,
      classifiedFrameCount: samplesExact
        ? switches.reduce(
            (total, sample) => total + sample.renderWork.presentation.classifiedFrameCount,
            0,
          )
        : null,
      invalidIdentityFrameCount: samplesExact
        ? switches.reduce(
            (total, sample) => total + sample.renderWork.presentation.invalidIdentityFrameCount,
            0,
          )
        : null,
      settledTargetFrameCount: samplesExact
        ? switches.reduce(
            (total, sample) => total + sample.renderWork.presentation.settledTargetFrameCount,
            0,
          )
        : null,
      targetVisibleChangedFrameCount: samplesExact
        ? switches.reduce(
            (total, sample) =>
              total + sample.renderWork.presentation.targetVisibleChangedFrameCount,
            0,
          )
        : null,
      identicalPreSettleFrameCount: samplesExact
        ? switches.reduce(
            (total, sample) => total + sample.renderWork.presentation.identicalPreSettleFrameCount,
            0,
          )
        : null,
      identicalPostSettleFrameCount: samplesExact
        ? switches.reduce(
            (total, sample) => total + sample.renderWork.presentation.identicalPostSettleFrameCount,
            0,
          )
        : null,
    }),
  });
}

export function assessWindowLifecycleJourneyBoundaries({
  timeline,
  assessment,
  correlationComplete,
}) {
  const required = [
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
  let cursor = -1;
  const boundaries = required.map((id) => {
    const index = timeline.findIndex(
      (entry, candidate) => candidate > cursor && entry?.phase === id,
    );
    const passed = index > cursor;
    if (passed) cursor = index;
    return Object.freeze({ id, status: passed ? "passed" : "failed" });
  });
  boundaries.push(
    Object.freeze({
      id: "window-causal-proof",
      status: assessment?.qualified === true ? "passed" : "failed",
    }),
    Object.freeze({
      id: "diagnostic-correlation",
      status: correlationComplete === true ? "passed" : "failed",
    }),
  );
  const failed = boundaries.find(({ status }) => status !== "passed")?.id ?? null;
  return Object.freeze({
    status: failed === null ? "passed" : "failed",
    firstBrokenBoundary: failed,
    firstUnmeasuredBoundary: null,
    boundaries: Object.freeze(boundaries),
  });
}
