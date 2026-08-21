import { createHmac } from "node:crypto";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export function selectionMouseFixtureProgram() {
  return [
    "const marker=process.argv[1]",
    "const modeMarker=process.argv[2]",
    "process.stdout.write(marker+'\\n')",
    "if(typeof process.stdin.setRawMode==='function')process.stdin.setRawMode(true);process.stdin.resume()",
    "let pending='',seen=0,conditioned=false",
    "process.stdin.on('data',chunk=>{let input=chunk.toString('latin1').replace(/\\x19/g,()=>{if(!conditioned){conditioned=true;process.stdout.write('\\x1b[?1002h\\x1b[?1006h'+modeMarker+'\\n')}return ''});pending+=input;for(;;){const start=pending.indexOf('\\x1b[<');if(start<0){pending=pending.slice(-2);break}if(start>0)pending=pending.slice(start);const end=pending.search(/[Mm]/);if(end<0)break;const item=pending.slice(0,end+1);pending=pending.slice(end+1);const match=/^\\x1b\\[<([0-9]+);([0-9]+);([0-9]+)([Mm])$/.exec(item);if(match)process.stdout.write(['APP_MOUSE',++seen,match[1],match[2],match[3],match[4]].join('_')+'\\n')}})",
    "setInterval(()=>{},2147483647)",
  ].join(";");
}

function boundedIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function selectionWebEvidence(web, expectedSemanticPaneId) {
  const readiness = web?.readiness;
  const normalized = readiness?.normalized;
  const semantic = web?.semantic;
  const stableExactSamples = Number.isSafeInteger(web?.stableExactSamples)
    ? web.stableExactSamples
    : null;
  const windowGroupCount = Number.isSafeInteger(normalized?.expectedGroupCount)
    ? normalized.expectedGroupCount
    : null;
  const terminalNodeCount = Number.isSafeInteger(normalized?.observedTerminalCount)
    ? normalized.observedTerminalCount
    : null;
  const rawShapeExact =
    Array.isArray(semantic?.windows) &&
    semantic.windows.length === semantic.windowNodeCount &&
    semantic.windowNodeCount === windowGroupCount &&
    Array.isArray(semantic?.terminals) &&
    semantic.terminals.length === semantic.terminalNodeCount &&
    semantic.terminalNodeCount === terminalNodeCount;
  const semanticPaneExact =
    normalized?.terminalExact === true &&
    boundedIdentity(expectedSemanticPaneId) &&
    terminalNodeCount === 1 &&
    semantic?.terminals?.[0]?.semanticPaneId === expectedSemanticPaneId;
  return Object.freeze({
    qualified:
      readiness?.qualified === true &&
      stableExactSamples === 2 &&
      windowGroupCount === 1 &&
      terminalNodeCount === 1 &&
      rawShapeExact &&
      semanticPaneExact,
    stableExactSamples,
    windowGroupCount,
    terminalNodeCount,
    semanticPaneExact,
  });
}

function exactWriterHealth(value) {
  return (
    value?.droppedRecords === 0 && value?.failed === false && value?.pendingCriticalRecords === 0
  );
}

function exactCanonicalIdentity(left, right) {
  return (
    left?.processId === right?.processId &&
    left?.clockId === right?.clockId &&
    left?.clockKind === "performance-now" &&
    left.clockKind === right?.clockKind &&
    left?.semanticPaneId === right?.semanticPaneId &&
    left?.generation === right?.generation &&
    left?.incarnation === right?.incarnation &&
    left?.revision === right?.revision &&
    left?.stateHash === right?.stateHash
  );
}

export function applicationMouseForwardFailureObservation({
  performanceRecords,
  traceRecords,
  deliveries,
  expectedPaneId,
  selectReceiptWatermark,
  fixtureReceiptCount,
}) {
  const boundedPerformance =
    Array.isArray(performanceRecords) && performanceRecords.length <= 8_192
      ? performanceRecords
      : [];
  const boundedTrace =
    Array.isArray(traceRecords) && traceRecords.length <= 8_192 ? traceRecords : [];
  const boundedDeliveries = Array.isArray(deliveries) ? deliveries : [];
  const selectReceipts = new Set(
    boundedPerformance
      .map((record) => record?.workspaceClient?.committed?.lastReceipt)
      .filter(
        (receipt) =>
          receipt?.operationKind === "workspace.pane.select" &&
          receipt.phase === "observed" &&
          Number.isSafeInteger(receipt.sequence) &&
          receipt.sequence > selectReceiptWatermark &&
          boundedIdentity(receipt.operationId),
      )
      .map(({ operationId }) => operationId),
  );
  const origins = boundedTrace.filter(
    (record) =>
      record?.type === "performance.input-origin" &&
      record.origin === "application-mouse" &&
      record.semanticPaneId === expectedPaneId,
  );
  const originIds = new Set(origins.map(({ traceId }) => traceId).filter(boundedIdentity));
  const paintCount = boundedTrace.filter(
    (record) =>
      record?.type === "performance.stage" &&
      record.stage === "paint" &&
      originIds.has(record.traceId),
  ).length;
  const routes = boundedPerformance.filter(
    (record) => record?.phase === "terminal-application-mouse-route",
  );
  const lastDelivery = boundedDeliveries.at(-1) ?? null;
  const lastRoute = routes.at(-1) ?? null;
  const routeExact =
    lastRoute?.semanticPaneId === expectedPaneId &&
    lastRoute.action === lastDelivery?.requestedAction &&
    ["sent", "refused", "error"].includes(lastRoute.outcome) &&
    typeof lastRoute.sent === "boolean";
  return Object.freeze({
    operation: "application-mouse-forwarding",
    completedDeliveries: Math.min(Array.isArray(deliveries) ? deliveries.length : 0, 64),
    lastDelivery:
      lastDelivery?.kind === "application-mouse"
        ? Object.freeze({
            action: lastDelivery.requestedAction,
            x: Number.isSafeInteger(lastDelivery.requestedPoint?.x)
              ? lastDelivery.requestedPoint.x
              : null,
            y: Number.isSafeInteger(lastDelivery.requestedPoint?.y)
              ? lastDelivery.requestedPoint.y
              : null,
            button: ["left", "middle", "right"].includes(lastDelivery.requestedButton)
              ? lastDelivery.requestedButton
              : null,
            modifierCount: Array.isArray(lastDelivery.requestedModifiers)
              ? Math.min(lastDelivery.requestedModifiers.length, 8)
              : null,
          })
        : null,
    selectReceiptCount: Math.min(selectReceipts.size, 2),
    selectReceiptOverflow: selectReceipts.size > 2,
    routeOutcome: routeExact
      ? Object.freeze({ available: true, sent: lastRoute.sent, outcome: lastRoute.outcome })
      : Object.freeze({ available: false }),
    originCount: Math.min(origins.length, 64),
    paintCount: Math.min(paintCount, 64),
    fixtureReceiptCount:
      Number.isSafeInteger(fixtureReceiptCount) && fixtureReceiptCount >= 0
        ? Math.min(fixtureReceiptCount, 64)
        : 0,
  });
}

export function selectionLocalModeFailureObservation({
  inputObservation,
  performanceRecords,
  traceRecords,
  performanceWatermark,
  traceWatermark,
  copyCountBefore,
  expectedPaneId,
  mouseMode,
}) {
  const boundedPerformance =
    Array.isArray(performanceRecords) && performanceRecords.length <= 8_192
      ? performanceRecords
      : [];
  const boundedTrace =
    Array.isArray(traceRecords) && traceRecords.length <= 8_192 ? traceRecords : [];
  const performanceStart =
    Number.isSafeInteger(performanceWatermark) && performanceWatermark >= 0
      ? Math.min(performanceWatermark, boundedPerformance.length)
      : boundedPerformance.length;
  const traceStart =
    Number.isSafeInteger(traceWatermark) && traceWatermark >= 0
      ? Math.min(traceWatermark, boundedTrace.length)
      : boundedTrace.length;
  const performanceDelta = boundedPerformance.slice(performanceStart);
  const traceDelta = boundedTrace.slice(traceStart);
  const boundedCount = (value) => Math.min(Math.max(value, 0), 64);
  const copyCountAfter = boundedPerformance.filter(
    ({ phase }) => phase === "terminal-selection-copy",
  ).length;
  const origins = traceDelta.filter(
    (record) =>
      record?.type === "performance.input-origin" &&
      record.origin === "application-mouse" &&
      record.semanticPaneId === expectedPaneId,
  ).length;
  const routes = performanceDelta.filter(
    (record) =>
      record?.phase === "terminal-application-mouse-route" &&
      record.semanticPaneId === expectedPaneId,
  ).length;
  const paints = traceDelta.filter(
    (record) => record?.type === "performance.terminal-paint",
  ).length;
  const input = inputObservation && typeof inputObservation === "object" ? inputObservation : {};
  const boundedInteger = (value, cap) =>
    Number.isSafeInteger(value) && value >= 0 ? Math.min(value, cap) : null;
  const stages = new Set([
    "resolve-identity",
    "preflight-identity",
    "capabilities",
    "select-mode-identity",
    "enter-select-mode",
    "wait-select-mode",
    "capture-before-selection",
    "drag-pre-release-identity",
    "drag-pre-release",
    "selection-style-wait",
    "pre-release-budget",
    "clipboard-arm",
    "release-identity",
    "selection-release",
    "post-input-identity",
    "clipboard-wait",
    "clipboard-retirement",
    "unknown",
  ]);
  const causes = new Set(["deadline", "identity-mismatch", "operation-error", "timeout"]);
  const boundedInput = Object.freeze({
    operation: "tui-testdrive-input",
    kind: "selection-drag",
    substage: stages.has(input.substage) ? input.substage : "unknown",
    cause: causes.has(input.cause) ? input.cause : "operation-error",
    elapsedMs: boundedInteger(input.elapsedMs, 5_000),
    remainingMs: boundedInteger(input.remainingMs, 5_000),
    completedPhases: boundedInteger(input.completedPhases, 32),
    totalPhases: boundedInteger(input.totalPhases, 32),
    completedTransportCalls: boundedInteger(input.completedTransportCalls, 32),
    totalTransportCalls: boundedInteger(input.totalTransportCalls, 32),
    completedPhysicalTransportCalls: boundedInteger(input.completedPhysicalTransportCalls, 32),
    totalPhysicalTransportCalls: boundedInteger(input.totalPhysicalTransportCalls, 32),
    priorCopyCount: boundedInteger(input.priorCopyCount, 2_048),
    newCopyCount: boundedInteger(input.newCopyCount, 2_048),
    clipboardIdentityExact: input.clipboardIdentityExact === true,
    candidateAttempts: boundedInteger(input.candidateAttempts, 8),
    occupiedCount: boundedInteger(input.occupiedCount, 8),
    retirementExact: input.retirementExact === true,
    retirementStage: [
      "not-started",
      "lock",
      "preflight",
      "mutation",
      "verification",
      "unlock",
      "complete",
    ].includes(input.retirementStage)
      ? input.retirementStage
      : null,
    retirementElapsedMs: boundedInteger(input.retirementElapsedMs, 5_000),
    finalOwnerAbsent: input.finalOwnerAbsent === true,
    finalHookAbsent: input.finalHookAbsent === true,
    callbackInvocations: boundedInteger(input.callbackInvocations, 2),
    callbackStage: [
      "not-invoked",
      "hook-invoked",
      "inventory-pending",
      "inventory-seen",
      "save-pending",
      "artifact-published",
    ].includes(input.callbackStage)
      ? input.callbackStage
      : null,
    callbackOutcome: ["pending", "seen", "published", "error"].includes(input.callbackOutcome)
      ? input.callbackOutcome
      : null,
    callbackInventoryPolls: boundedInteger(input.callbackInventoryPolls, 2_048),
    callbackHookElapsedMs: boundedInteger(input.callbackHookElapsedMs, 5_000),
    callbackHookEntryLagMs: boundedInteger(input.callbackHookEntryLagMs, 5_000),
    callbackInventorySeenElapsedMs: boundedInteger(input.callbackInventorySeenElapsedMs, 5_000),
    callbackArtifactPublishedElapsedMs: boundedInteger(
      input.callbackArtifactPublishedElapsedMs,
      5_000,
    ),
    callbackPreSaveElapsedMs: boundedInteger(input.callbackPreSaveElapsedMs, 5_000),
    callbackSaveElapsedMs: boundedInteger(input.callbackSaveElapsedMs, 5_000),
    callbackSaveOutcome: ["not-started", "pending", "complete", "error"].includes(
      input.callbackSaveOutcome,
    )
      ? input.callbackSaveOutcome
      : null,
    callbackRetirementStage: ["not-started", "already-exited", "abort-ack", "failed"].includes(
      input.callbackRetirementStage,
    )
      ? input.callbackRetirementStage
      : null,
    callbackRetirementElapsedMs: boundedInteger(input.callbackRetirementElapsedMs, 5_000),
    callbackWorkSettled: input.callbackWorkSettled === true,
    callbackLeaseInactive: input.callbackLeaseInactive === true,
    artifactObservedElapsedMs: boundedInteger(input.artifactObservedElapsedMs, 5_000),
    duplicateSettleElapsedMs: boundedInteger(input.duplicateSettleElapsedMs, 5_000),
    callbackLastScanElapsedMs: boundedInteger(input.callbackLastScanElapsedMs, 5_000),
    clipboardArmElapsedMs: boundedInteger(input.clipboardArmElapsedMs, 5_000),
    clipboardArmStartedElapsedMs: boundedInteger(input.clipboardArmStartedElapsedMs, 5_000),
    clipboardArmBudgetAtStartMs: boundedInteger(input.clipboardArmBudgetAtStartMs, 5_000),
    clipboardArmRawRemainingAtStartMs: boundedInteger(
      input.clipboardArmRawRemainingAtStartMs,
      5_000,
    ),
    clipboardReleaseElapsedMs: boundedInteger(input.clipboardReleaseElapsedMs, 5_000),
    clipboardWaitStartedElapsedMs: boundedInteger(input.clipboardWaitStartedElapsedMs, 5_000),
    clipboardReleaseBudgetAtStartMs: boundedInteger(input.clipboardReleaseBudgetAtStartMs, 5_000),
    clipboardReleaseIdentityElapsedMs: boundedInteger(
      input.clipboardReleaseIdentityElapsedMs,
      5_000,
    ),
    clipboardReleaseTransportAttempted: input.clipboardReleaseTransportAttempted === true,
    clipboardReleaseEffectOccurred: [true, false, null].includes(
      input.clipboardReleaseEffectOccurred,
    )
      ? input.clipboardReleaseEffectOccurred
      : null,
    clipboardReleaseLoadMarkerAcquired: input.clipboardReleaseLoadMarkerAcquired === true,
    clipboardReleaseCleanupAttempted: input.clipboardReleaseCleanupAttempted === true,
  });
  return Object.freeze({
    ...boundedInput,
    localMode: Object.freeze({
      originDelta: boundedCount(origins),
      routeDelta: boundedCount(routes),
      copyDelta:
        Number.isSafeInteger(copyCountBefore) && copyCountBefore >= 0
          ? boundedCount(copyCountAfter - copyCountBefore)
          : null,
      localPaintCount: boundedCount(paints),
      mouseProtocol: ["none", "x10", "vt200", "drag", "any"].includes(mouseMode?.protocol)
        ? mouseMode.protocol
        : null,
      mouseEncoding: ["default", "utf8", "sgr", "sgr-pixels"].includes(mouseMode?.encoding)
        ? mouseMode.encoding
        : null,
    }),
  });
}

export function selectionWorkspaceClientEvidence(workspaceClient) {
  const recordClient = workspaceClient?.record?.workspaceClient;
  const committed = workspaceClient?.committed;
  const pending = workspaceClient?.pending;
  const derived = workspaceClient?.derived;
  const resources = derived?.terminalInventory?.resources;
  return Object.freeze({
    pendingCount: Array.isArray(pending) ? pending.length : null,
    clientGeneration: Number.isSafeInteger(committed?.generation) ? committed.generation : null,
    workspaceName: boundedIdentity(committed?.target?.workspaceName)
      ? committed.target.workspaceName
      : null,
    authorityWorkspaceName: boundedIdentity(committed?.authorityWorkspaceName)
      ? committed.authorityWorkspaceName
      : null,
    derivedWorkspaceName: boundedIdentity(derived?.workspace?.name) ? derived.workspace.name : null,
    semanticPaneId: Array.isArray(resources)
      ? (resources.find(({ active }) => active === true)?.attachability?.semanticPaneId ?? null)
      : null,
    resourceCount: Array.isArray(resources) ? resources.length : null,
    activeResourceCount: Array.isArray(resources)
      ? resources.filter(({ active }) => active === true).length
      : null,
    terminalResourceRevision:
      Number.isSafeInteger(committed?.terminalResourceRevision) &&
      committed.terminalResourceRevision >= 0
        ? committed.terminalResourceRevision
        : null,
    sameRecordExact:
      recordClient?.committed === committed &&
      recordClient?.pending === pending &&
      recordClient?.derived === derived,
  });
}

export function selectionCausalFailureObservation(assessment, evidence) {
  const predicates = assessment?.predicates;
  const predicateVector = Object.freeze(
    Object.entries(predicates && typeof predicates === "object" ? predicates : {})
      .slice(0, 32)
      .map(([id, passed]) => Object.freeze({ id, passed: passed === true })),
  );
  const requestedFirstFailedPredicate = assessment?.firstFailedPredicate;
  const workspaceClient = evidence?.workspaceClient;
  const tmux = evidence?.tmux;
  const web = evidence?.web;
  const work = evidence?.work;
  const writer = evidence?.writerHealth;
  const boundedCount = (value, cap = 64) =>
    Number.isSafeInteger(value) && value >= 0 ? Math.min(value, cap) : null;
  return Object.freeze({
    operation: "selection-copy-app-mouse-assessment",
    firstFailedPredicate: predicateVector.some(({ id }) => id === requestedFirstFailedPredicate)
      ? requestedFirstFailedPredicate
      : "assessment-unavailable",
    predicateVector,
    workspaceClient: Object.freeze({
      pendingCount: boundedCount(workspaceClient?.pendingCount),
      generationExact: workspaceClient?.clientGeneration === evidence?.expected?.clientGeneration,
      targetWorkspaceExact: workspaceClient?.workspaceName === evidence?.expected?.workspaceName,
      authorityWorkspaceExact:
        boundedIdentity(workspaceClient?.authorityWorkspaceName) &&
        workspaceClient.authorityWorkspaceName === workspaceClient?.derivedWorkspaceName,
      semanticPaneExact: workspaceClient?.semanticPaneId === evidence?.expected?.semanticPaneId,
      resourceCount: boundedCount(workspaceClient?.resourceCount),
      activeResourceCount: boundedCount(workspaceClient?.activeResourceCount),
      revisionExact:
        Number.isSafeInteger(workspaceClient?.terminalResourceRevision) &&
        workspaceClient.terminalResourceRevision >= 0 &&
        workspaceClient.terminalResourceRevision === evidence?.expected?.terminalResourceRevision,
      sameRecordExact: workspaceClient?.sameRecordExact === true,
    }),
    tmux: Object.freeze({
      semanticPaneExact: tmux?.semanticPaneId === evidence?.expected?.semanticPaneId,
      geometryStable: tmux?.geometryStable === true,
      snapshotExact: tmux?.snapshotExact === true,
      applicationMouseModeExact: tmux?.applicationMouseMode === "sgr-drag",
    }),
    web: Object.freeze({
      qualified: web?.qualified === true,
      stableExactSamples: boundedCount(web?.stableExactSamples, 8),
      windowGroupCount: boundedCount(web?.windowGroupCount, 8),
      terminalNodeCount: boundedCount(web?.terminalNodeCount, 8),
      semanticPaneExact: web?.semanticPaneExact === true,
    }),
    tui: Object.freeze({
      selectedCells: boundedCount(assessment?.metrics?.selectedCells, 1_000_000),
      clipboardBytes: boundedCount(assessment?.metrics?.clipboardBytes, 1_000_000),
      appMouseSampleCount: boundedCount(assessment?.metrics?.appMouseSampleCount),
      appMouseP95Ms:
        Number.isFinite(assessment?.metrics?.appMouseP95Ms) && assessment.metrics.appMouseP95Ms >= 0
          ? Math.min(assessment.metrics.appMouseP95Ms, 60_000)
          : null,
      appMouseP99Ms:
        Number.isFinite(assessment?.metrics?.appMouseP99Ms) && assessment.metrics.appMouseP99Ms >= 0
          ? Math.min(assessment.metrics.appMouseP99Ms, 60_000)
          : null,
      identicalIdleFrames: boundedCount(work?.identicalIdleFrames),
      unchangedPaneGridWalks: boundedCount(work?.unchangedPaneGridWalks),
      terminalPaintsOutsideGestures: boundedCount(work?.terminalPaintsOutsideGestures),
    }),
    writer: Object.freeze({
      droppedRecords: boundedCount(writer?.droppedRecords, 1_000_000),
      failed: writer?.failed === true,
      pendingCriticalRecords: boundedCount(writer?.pendingCriticalRecords, 1_000_000),
      healthy: exactWriterHealth(writer),
    }),
  });
}

export function selectionCopyFailureEvidence(records, expected) {
  const bounded = Array.isArray(records) && records.length <= 8_192 ? records : [];
  const copies = bounded.filter((record) => record?.phase === "terminal-selection-copy");
  const copy = copies.length > 0 ? copies.at(-1) : null;
  if (!copy) return Object.freeze({ available: false });
  const identity = copy.canonicalIdentity;
  return Object.freeze({
    available: true,
    copied: copy.copied === true,
    bytes:
      Number.isSafeInteger(copy.bytes) && copy.bytes >= 0 && copy.bytes <= 1_000_000
        ? copy.bytes
        : null,
    identityExact:
      copy.processId === expected?.processId &&
      copy.daemonGeneration === expected?.daemonGeneration &&
      copy.clientGeneration === expected?.clientGeneration &&
      copy.semanticPaneId === expected?.semanticPaneId &&
      identity?.generation === expected?.canonicalGeneration &&
      identity?.incarnation === expected?.mouseMode?.incarnation &&
      identity?.revision === expected?.mouseMode?.revision &&
      identity?.stateHash === expected?.mouseMode?.stateHash,
    writerHealthy: exactWriterHealth(copy.writerHealth),
    copyCount: Math.min(copies.length, 8_192),
  });
}

/**
 * Qualify the one post-attachment fixture transition that enables application
 * mouse reporting. Pre-attachment DEC modes are deliberately not recoverable
 * from capture-pane, so the transition must be a newer canonical patch with a
 * changed host frame and its exact writer-health fence.
 */
export function assessSelectionMouseModeConditioning(records, expected) {
  const boundedRecords = Array.isArray(records) && records.length <= 8_192 ? records : [];
  const sourceExact = (record) =>
    record?.processId === expected?.processId &&
    record.clockId === expected?.clockId &&
    record.clockKind === "performance-now" &&
    record.semanticPaneId === expected?.semanticPaneId &&
    record.generation === expected?.canonicalGeneration &&
    record.incarnation === expected?.canonicalIncarnation;
  const modes = boundedRecords.filter(
    (record) =>
      record?.type === "performance.terminal-canonical-mode" &&
      sourceExact(record) &&
      record.mouseProtocol === "drag" &&
      record.mouseEncoding === "sgr" &&
      Number.isSafeInteger(record.revision) &&
      record.revision > expected?.afterRevision &&
      boundedIdentity(record.incarnation) &&
      /^[0-9a-f]{16}$/u.test(record.stateHash ?? "") &&
      Number.isSafeInteger(record.atMicros) &&
      record.atMicros >= 0,
  );
  const mode = modes.length === 1 ? modes[0] : null;
  const origins = boundedRecords.filter(
    (record) =>
      record?.type === "performance.input-origin" &&
      record.origin === "keyboard" &&
      sourceExact(record) &&
      record.revision === expected?.afterRevision &&
      record.stateHash === expected?.beforeStateHash &&
      typeof record.traceId === "string" &&
      UUID_V4.test(record.traceId),
  );
  const patches = boundedRecords.filter(
    (record) =>
      record?.type === "performance.terminal-canonical-update" &&
      record.updateType === "terminal.patch" &&
      sourceExact(record) &&
      mode &&
      exactCanonicalIdentity(record, mode) &&
      record.sourceEpoch === expected?.sourceEpoch &&
      record.cols === expected?.canonicalCols &&
      record.rows === expected?.canonicalRows,
  );
  const frames = boundedRecords.filter(
    (record) =>
      record?.type === "performance.terminal-canonical-host-frame" &&
      sourceExact(record) &&
      mode &&
      exactCanonicalIdentity(record, mode) &&
      record.sourceEpoch === expected?.sourceEpoch &&
      record.rendererEpoch === expected?.rendererEpoch &&
      record.cols === expected?.canonicalCols &&
      record.rows === expected?.canonicalRows &&
      record.viewportCols === expected?.viewportCols &&
      record.viewportRows === expected?.viewportRows &&
      record.acceptedUpdateType === "terminal.patch" &&
      record.acceptedRevision === mode.revision,
  );
  const paints = boundedRecords.filter(
    (record) =>
      record?.type === "performance.stage" &&
      record.stage === "paint" &&
      record.scenario === "terminal-input-to-paint" &&
      origins.length === 1 &&
      record.traceId === origins[0].traceId &&
      sourceExact(record) &&
      mode &&
      exactCanonicalIdentity(record, mode) &&
      record.paintStateIdentity === "latest-canonical-state-blitted" &&
      Number.isSafeInteger(record.startedAtMicros) &&
      Number.isSafeInteger(record.endedAtMicros) &&
      record.startedAtMicros >= origins[0].atMicros &&
      record.endedAtMicros >= record.startedAtMicros,
  );
  const fences = boundedRecords.filter(
    (record) =>
      record?.type === "performance.terminal-frame-fence" &&
      sourceExact(record) &&
      mode &&
      exactCanonicalIdentity(record, mode) &&
      record.daemonGeneration === expected?.daemonGeneration &&
      record.sourceEpoch === expected?.sourceEpoch &&
      record.rendererEpoch === expected?.rendererEpoch &&
      record.cols === expected?.canonicalCols &&
      record.rows === expected?.canonicalRows &&
      record.viewportCols === expected?.viewportCols &&
      record.viewportRows === expected?.viewportRows &&
      record.acceptedUpdateType === "terminal.patch" &&
      record.acceptedRevision === mode.revision &&
      record.writerHealth?.droppedRecords === 0 &&
      record.writerHealth?.oversizedRecords === 0 &&
      record.writerHealth?.failed === false,
  );
  const originIndex = boundedRecords.indexOf(origins[0]);
  const fenceIndex = boundedRecords.indexOf(fences[0]);
  const transitionEndIndex = fenceIndex >= 0 ? fenceIndex : boundedRecords.length;
  const transitionModes = boundedRecords.filter(
    (record, index) =>
      index > originIndex &&
      index < transitionEndIndex &&
      record?.type === "performance.terminal-canonical-mode" &&
      sourceExact(record) &&
      Number.isSafeInteger(record.revision) &&
      record.revision > expected?.afterRevision,
  );
  const transitionPatches = boundedRecords.filter(
    (record, index) =>
      index > originIndex &&
      index < transitionEndIndex &&
      record?.type === "performance.terminal-canonical-update" &&
      record.updateType === "terminal.patch" &&
      sourceExact(record) &&
      record.sourceEpoch === expected?.sourceEpoch &&
      Number.isSafeInteger(record.revision) &&
      record.revision > expected?.afterRevision,
  );
  const indexes = [origins[0], patches[0], mode, paints[0], frames[0], fences[0]].map((record) =>
    boundedRecords.indexOf(record),
  );
  const predicates = Object.freeze({
    recordsBounded: boundedRecords === records,
    expectedExact:
      boundedIdentity(expected?.processId) &&
      boundedIdentity(expected?.clockId) &&
      boundedIdentity(expected?.daemonGeneration) &&
      boundedIdentity(expected?.semanticPaneId) &&
      boundedIdentity(expected?.canonicalGeneration) &&
      boundedIdentity(expected?.canonicalIncarnation) &&
      /^[0-9a-f]{16}$/u.test(expected?.beforeStateHash ?? "") &&
      Number.isSafeInteger(expected?.afterRevision) &&
      expected.afterRevision >= 0 &&
      Number.isSafeInteger(expected?.sourceEpoch) &&
      expected.sourceEpoch >= 0 &&
      Number.isSafeInteger(expected?.rendererEpoch) &&
      expected.rendererEpoch >= 0 &&
      Number.isSafeInteger(expected?.canonicalCols) &&
      expected.canonicalCols > 0 &&
      Number.isSafeInteger(expected?.canonicalRows) &&
      expected.canonicalRows > 0 &&
      Number.isSafeInteger(expected?.viewportCols) &&
      expected.viewportCols > 0 &&
      Number.isSafeInteger(expected?.viewportRows) &&
      expected.viewportRows > 0,
    modeExact: modes.length === 1,
    inputOriginExact: origins.length === 1,
    patchExact: patches.length === 1,
    transitionCardinalityExact: transitionModes.length === 1 && transitionPatches.length === 1,
    changedPaintExact: paints.length === 1,
    changedFrameExact: frames.length === 1,
    healthyFenceExact: fences.length === 1,
    orderExact:
      indexes.every((index) => index >= 0) &&
      indexes[0] < indexes[1] &&
      indexes[1] <= indexes[2] &&
      indexes[2] <= indexes[3] &&
      indexes[3] < indexes[4] &&
      indexes[4] < indexes[5] &&
      Number.isSafeInteger(origins[0]?.atMicros) &&
      Number.isFinite(mode?.atMicros) &&
      Number.isFinite(patches[0]?.atMicros) &&
      Number.isSafeInteger(paints[0]?.endedAtMicros) &&
      Number.isFinite(frames[0]?.atMicros) &&
      Number.isFinite(fences[0]?.atMicros) &&
      origins[0].atMicros <= patches[0].atMicros &&
      patches[0].atMicros <= mode.atMicros &&
      mode.atMicros <= paints[0].endedAtMicros &&
      paints[0].endedAtMicros <= frames[0].atMicros &&
      frames[0].atMicros <= fences[0].atMicros,
  });
  const firstFailedPredicate =
    Object.entries(predicates).find(([, passed]) => passed !== true)?.[0] ?? null;
  return Object.freeze({
    qualified: firstFailedPredicate === null,
    firstFailedPredicate,
    predicates,
    observation: Object.freeze({
      recordCount: Math.min(Array.isArray(records) ? records.length : 0, 8_193),
      modeCount: Math.min(modes.length, 2),
      transitionModeCount: Math.min(transitionModes.length, 3),
      inputOriginCount: Math.min(origins.length, 2),
      patchCount: Math.min(patches.length, 2),
      transitionPatchCount: Math.min(transitionPatches.length, 3),
      paintCount: Math.min(paints.length, 2),
      frameCount: Math.min(frames.length, 2),
      fenceCount: Math.min(fences.length, 2),
      latestProtocol: modes.at(-1)?.mouseProtocol ?? null,
      latestEncoding: modes.at(-1)?.mouseEncoding ?? null,
      latestRevision: Number.isSafeInteger(modes.at(-1)?.revision) ? modes.at(-1).revision : null,
    }),
    qualifiedMode: firstFailedPredicate === null ? mode : null,
  });
}

export async function waitForSelectionMouseModeConditioning({
  readRecords,
  expected,
  signal,
  timeoutMs = 3_000,
  now = () => performance.now(),
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
}) {
  const deadline = now() + timeoutMs;
  let attempts = 0;
  let latest = assessSelectionMouseModeConditioning([], expected);
  for (;;) {
    if (signal?.aborted) {
      const error = new Error("selection mouse-mode conditioning aborted");
      error.boundary = "selection-baseline";
      error.observation = Object.freeze({ reason: "aborted", attempts, ...latest.observation });
      throw error;
    }
    latest = assessSelectionMouseModeConditioning(readRecords(), expected);
    attempts += 1;
    if (latest.qualified) return latest;
    if (now() >= deadline) {
      const error = new Error("selection mouse-mode conditioning deadline elapsed");
      error.boundary = "selection-baseline";
      error.observation = Object.freeze({
        reason: "timeout",
        attempts,
        firstFailedPredicate: latest.firstFailedPredicate,
        ...latest.observation,
      });
      throw error;
    }
    await sleep(10);
  }
}

function exactIdentity(value, expected) {
  return (
    value?.processId === expected?.processId &&
    value?.daemonGeneration === expected?.daemonGeneration &&
    value?.clientGeneration === expected?.clientGeneration &&
    value?.workspaceName === expected?.workspaceName &&
    value?.sessionName === expected?.sessionName &&
    value?.semanticPaneId === expected?.semanticPaneId &&
    boundedIdentity(value?.processId) &&
    UUID_V4.test(value?.daemonGeneration ?? "") &&
    Number.isSafeInteger(value?.clientGeneration) &&
    boundedIdentity(value?.workspaceName) &&
    boundedIdentity(value?.sessionName) &&
    boundedIdentity(value?.semanticPaneId)
  );
}

function exactClipboard(value, expected) {
  return (
    Number.isSafeInteger(value?.bytes) &&
    value.bytes > 0 &&
    value.bytes <= 1_000_000 &&
    value.bytes === expected?.bytes &&
    SHA256.test(value?.hmac ?? "") &&
    value.hmac === expected?.hmac
  );
}

function exactDelivery(value, kind, anchor) {
  const clipboardTiming = value?.clipboardObservation;
  const callbackArtifactArmElapsedMs =
    clipboardTiming?.callbackHookEntryLagMs + clipboardTiming?.callbackArtifactPublishedElapsedMs;
  const releaseBudgetExact =
    kind === "application-mouse" ||
    (Number.isSafeInteger(clipboardTiming?.clipboardArmStartedElapsedMs) &&
      clipboardTiming.clipboardArmStartedElapsedMs >= 0 &&
      Number.isSafeInteger(clipboardTiming.clipboardArmElapsedMs) &&
      clipboardTiming.clipboardArmElapsedMs >= clipboardTiming.clipboardArmStartedElapsedMs &&
      Number.isSafeInteger(clipboardTiming.clipboardArmBudgetAtStartMs) &&
      clipboardTiming.clipboardArmBudgetAtStartMs >= 90 &&
      clipboardTiming.clipboardArmBudgetAtStartMs <= 900 &&
      Number.isSafeInteger(clipboardTiming.clipboardArmRawRemainingAtStartMs) &&
      clipboardTiming.clipboardArmRawRemainingAtStartMs >= 1_340 &&
      clipboardTiming.clipboardArmRawRemainingAtStartMs <= 3_000 &&
      clipboardTiming.clipboardArmBudgetAtStartMs ===
        Math.min(900, clipboardTiming.clipboardArmRawRemainingAtStartMs - 1_250) &&
      clipboardTiming.clipboardArmElapsedMs - clipboardTiming.clipboardArmStartedElapsedMs <=
        clipboardTiming.clipboardArmBudgetAtStartMs &&
      clipboardTiming.clipboardArmStartedElapsedMs <= clipboardTiming.clipboardArmElapsedMs &&
      clipboardTiming.clipboardReleaseBudgetAtStartMs === 200 &&
      Number.isSafeInteger(clipboardTiming.clipboardReleaseIdentityElapsedMs) &&
      clipboardTiming.clipboardReleaseIdentityElapsedMs >= 0 &&
      clipboardTiming.clipboardReleaseIdentityElapsedMs <=
        clipboardTiming.clipboardReleaseBudgetAtStartMs &&
      clipboardTiming.clipboardReleaseTransportAttempted === true &&
      clipboardTiming.clipboardReleaseEffectOccurred === true &&
      clipboardTiming.clipboardReleaseLoadMarkerAcquired === true &&
      clipboardTiming.clipboardReleaseCleanupAttempted === false &&
      Number.isSafeInteger(clipboardTiming.clipboardReleaseElapsedMs) &&
      clipboardTiming.clipboardReleaseElapsedMs >= clipboardTiming.clipboardArmElapsedMs &&
      clipboardTiming.clipboardReleaseElapsedMs - clipboardTiming.clipboardArmElapsedMs <= 200);
  const clipboardTimingsExact =
    kind === "application-mouse" ||
    ([
      clipboardTiming?.callbackHookElapsedMs,
      clipboardTiming?.callbackInventorySeenElapsedMs,
      clipboardTiming?.callbackPreSaveElapsedMs,
      clipboardTiming?.callbackSaveElapsedMs,
      clipboardTiming?.callbackArtifactPublishedElapsedMs,
      clipboardTiming?.artifactObservedElapsedMs,
    ].every((duration) => Number.isSafeInteger(duration) && duration >= 0 && duration <= 3_000) &&
      clipboardTiming.callbackHookElapsedMs <= clipboardTiming.callbackInventorySeenElapsedMs &&
      clipboardTiming.callbackInventorySeenElapsedMs <= clipboardTiming.callbackPreSaveElapsedMs &&
      clipboardTiming.callbackPreSaveElapsedMs + clipboardTiming.callbackSaveElapsedMs <=
        clipboardTiming.callbackArtifactPublishedElapsedMs &&
      clipboardTiming.callbackArtifactPublishedElapsedMs <=
        clipboardTiming.artifactObservedElapsedMs &&
      Number.isSafeInteger(clipboardTiming.duplicateSettleElapsedMs) &&
      clipboardTiming.duplicateSettleElapsedMs >= 40 &&
      clipboardTiming.duplicateSettleElapsedMs <= 650 &&
      [
        clipboardTiming.callbackHookEntryLagMs,
        clipboardTiming.callbackLastScanElapsedMs,
        clipboardTiming.clipboardArmElapsedMs,
        clipboardTiming.clipboardReleaseElapsedMs,
        clipboardTiming.clipboardWaitStartedElapsedMs,
      ].every((duration) => Number.isSafeInteger(duration) && duration >= 0 && duration <= 3_000) &&
      clipboardTiming.clipboardArmElapsedMs <= clipboardTiming.clipboardReleaseElapsedMs &&
      clipboardTiming.clipboardReleaseElapsedMs <= clipboardTiming.clipboardWaitStartedElapsedMs &&
      releaseBudgetExact &&
      Number.isSafeInteger(callbackArtifactArmElapsedMs) &&
      callbackArtifactArmElapsedMs >= 0 &&
      callbackArtifactArmElapsedMs <= clipboardTiming.artifactObservedElapsedMs &&
      clipboardTiming.artifactObservedElapsedMs <= clipboardTiming.callbackLastScanElapsedMs);
  const clipboardLeaseExact =
    kind === "application-mouse" ||
    (Number.isSafeInteger(value?.clipboardObservation?.candidateAttempts) &&
      value.clipboardObservation.candidateAttempts >= 1 &&
      value.clipboardObservation.candidateAttempts <= 8 &&
      Number.isSafeInteger(value.clipboardObservation.occupiedCount) &&
      value.clipboardObservation.occupiedCount >= 0 &&
      value.clipboardObservation.occupiedCount < value.clipboardObservation.candidateAttempts &&
      value.clipboardObservation.retirementExact === true &&
      value.clipboardObservation.retirementStage === "complete" &&
      Number.isSafeInteger(value.clipboardObservation.retirementElapsedMs) &&
      value.clipboardObservation.retirementElapsedMs >= 0 &&
      value.clipboardObservation.retirementElapsedMs <= 3_000 &&
      value.clipboardObservation.finalOwnerAbsent === true &&
      value.clipboardObservation.finalHookAbsent === true &&
      Number.isSafeInteger(value.clipboardObservation.priorCopyCount) &&
      value.clipboardObservation.priorCopyCount >= 0 &&
      Number.isSafeInteger(value.clipboardObservation.newCopyCount) &&
      value.clipboardObservation.newCopyCount >= value.clipboardObservation.priorCopyCount &&
      value.clipboardObservation.newCopyCount <= value.clipboardObservation.priorCopyCount + 1 &&
      value.clipboardObservation.identityExact === true &&
      value.clipboardObservation.callbackInvocations === 1 &&
      value.clipboardObservation.callbackStage === "artifact-published" &&
      value.clipboardObservation.callbackOutcome === "published" &&
      value.clipboardObservation.callbackSaveOutcome === "complete" &&
      ["already-exited", "abort-ack"].includes(
        value.clipboardObservation.callbackRetirementStage,
      ) &&
      Number.isSafeInteger(value.clipboardObservation.callbackRetirementElapsedMs) &&
      value.clipboardObservation.callbackRetirementElapsedMs >= 0 &&
      value.clipboardObservation.callbackRetirementElapsedMs <= 650 &&
      value.clipboardObservation.callbackWorkSettled === true &&
      value.clipboardObservation.callbackLeaseInactive === true &&
      Number.isSafeInteger(value.clipboardObservation.callbackInventoryPolls) &&
      value.clipboardObservation.callbackInventoryPolls >= 1 &&
      value.clipboardObservation.callbackInventoryPolls <= 2_048 &&
      clipboardTimingsExact);
  return (
    value?.version === 1 &&
    value.kind === kind &&
    value.delivery === "exact-bytes-to-immutable-host-pane-pty" &&
    /^%\d+$/u.test(value.paneId ?? "") &&
    /^\$\d+$/u.test(value.sessionId ?? "") &&
    value.paneId === anchor?.paneId &&
    value.sessionId === anchor?.sessionId &&
    value.target === value.paneId &&
    value.geometry?.cols === 160 &&
    value.geometry?.rows === 44 &&
    Number.isSafeInteger(value.bytesInjected) &&
    value.bytesInjected > 0 &&
    Number.isSafeInteger(value.transportCalls) &&
    value.transportCalls > 0 &&
    value.transportCalls <= 5 &&
    Number.isSafeInteger(value.physicalTransportCalls) &&
    value.physicalTransportCalls === value.transportCalls &&
    clipboardLeaseExact
  );
}

function exactCopyFence(value, expected, canonical = null) {
  return (
    value?.copied === true &&
    exactWriterHealth(value?.writerHealth) &&
    value?.daemonGeneration === expected?.daemonGeneration &&
    value?.clientGeneration === expected?.clientGeneration &&
    value?.semanticPaneId === expected?.semanticPaneId &&
    Number.isSafeInteger(value?.copyOrdinal) &&
    value.copyOrdinal >= 0 &&
    value?.canonicalIdentity?.generation === expected?.canonicalGeneration &&
    Number.isSafeInteger(value.canonicalIdentity.revision) &&
    value.canonicalIdentity.revision >= 0 &&
    (canonical === null ||
      (value.canonicalIdentity.incarnation === canonical?.incarnation &&
        value.canonicalIdentity.revision === canonical?.revision &&
        value.canonicalIdentity.stateHash === canonical?.stateHash)) &&
    value.canonicalIdentity.cols === 132 &&
    value.canonicalIdentity.rows === 41
  );
}

function exactCopySequence(value, fence) {
  return (
    value?.beforeCount === 1 &&
    value.afterCount === 2 &&
    value.priorOrdinal === 0 &&
    value.expectedOrdinal === 1 &&
    value.actualOrdinal === 1 &&
    value.actualOrdinal === fence?.copyOrdinal &&
    value.identityExact === true
  );
}

function exactSelectionRequest(delivery, point) {
  const distance = Math.max(
    Math.abs((point?.to?.x ?? -1) - (point?.from?.x ?? -1)),
    Math.abs((point?.to?.y ?? -1) - (point?.from?.y ?? -1)),
  );
  const selectionPhases = Math.max(1, Math.min(24, distance)) + 2;
  return (
    delivery?.requestedSelection?.from?.x === point?.from?.x &&
    delivery.requestedSelection.from.y === point.from.y &&
    delivery.requestedSelection.to?.x === point.to?.x &&
    delivery.requestedSelection.to.y === point.to.y &&
    delivery.requestedSelection.contentRect?.x === point.contentRect?.x &&
    delivery.requestedSelection.contentRect.y === point.contentRect.y &&
    delivery.requestedSelection.contentRect.width === point.contentRect.width &&
    delivery.requestedSelection.contentRect.height === point.contentRect.height &&
    delivery.phases === selectionPhases + 3 &&
    delivery.transportCalls === 5
  );
}

export function assessSelectionCopyAppMouseBoundaries({ expected, actual }) {
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
  return Object.freeze({
    qualified:
      Array.isArray(expected) &&
      Array.isArray(actual) &&
      expected.length === names.length &&
      actual.length === names.length &&
      names.every((name, index) => expected[index] === name && actual[index] === name),
    expectedCount: names.length,
    actualCount: Array.isArray(actual) ? Math.min(actual.length, names.length + 1) : 0,
  });
}

export function assessSelectionCopyAppMouseJourneyBoundaries({
  timeline,
  assessment,
  correlationComplete,
}) {
  const required = [
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
  const phases = new Set(
    Array.isArray(timeline) && timeline.length <= 4_096
      ? timeline.map(({ phase }) => phase).filter((phase) => typeof phase === "string")
      : [],
  );
  const boundaries = required.map((id) =>
    Object.freeze({ id, status: phases.has(id) ? "passed" : "failed" }),
  );
  boundaries.push(
    Object.freeze({
      id: "selection-causal-proof",
      status: assessment?.qualified ? "passed" : "failed",
    }),
    Object.freeze({
      id: "diagnostic-correlation",
      status: correlationComplete === true ? "passed" : "failed",
    }),
  );
  const firstBrokenBoundary = boundaries.find(({ status }) => status !== "passed")?.id ?? null;
  return Object.freeze({
    status: firstBrokenBoundary === null ? "passed" : "failed",
    firstBrokenBoundary,
    firstUnmeasuredBoundary: null,
    boundaries: Object.freeze(boundaries),
  });
}

function exactApplicationMouseDistributionSummary(value, recomputed) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(
        [
          "causalSamples",
          "p95Ms",
          "p99Ms",
          "qualified",
          "sampleCount",
          "samples",
          "uniqueSamples",
        ].sort(),
      ) &&
    value.sampleCount === recomputed.sampleCount &&
    value.uniqueSamples === recomputed.uniqueSamples &&
    value.causalSamples === recomputed.causalSamples &&
    value.p95Ms === recomputed.p95Ms &&
    value.p99Ms === recomputed.p99Ms &&
    value.qualified === recomputed.qualified
  );
}

export function assessProductSelectionCopyAppMouse({ evidence, expected }) {
  const selection = evidence?.selection;
  const copy = evidence?.copy;
  const appMouse = evidence?.appMouse;
  const localMode = evidence?.localMode;
  const appMouseExpectedPoint = Object.freeze({
    column:
      Number.isSafeInteger(evidence?.baseline?.point?.from?.x) &&
      Number.isSafeInteger(evidence?.baseline?.point?.contentRect?.x)
        ? evidence.baseline.point.from.x - evidence.baseline.point.contentRect.x
        : null,
    row:
      Number.isSafeInteger(evidence?.baseline?.point?.from?.y) &&
      Number.isSafeInteger(evidence?.baseline?.point?.contentRect?.y)
        ? evidence.baseline.point.from.y - evidence.baseline.point.contentRect.y
        : null,
  });
  const recomputedAppMouseDistribution = assessApplicationMouseDistribution(
    appMouse?.distribution?.samples,
    appMouseExpectedPoint,
  );
  const predicates = Object.freeze({
    identityExact: exactIdentity(evidence?.baseline, expected),
    mouseModeConditionedExact:
      boundedIdentity(evidence?.baseline?.canonicalIncarnation) &&
      /^[0-9a-f]{16}$/u.test(evidence?.baseline?.canonicalStateHash ?? "") &&
      evidence.baseline.canonicalIncarnation === expected?.canonicalIncarnation &&
      evidence.baseline.canonicalStateHash === expected?.canonicalStateHash &&
      evidence?.baseline?.mouseMode?.protocol === "drag" &&
      evidence.baseline.mouseMode.encoding === "sgr" &&
      Number.isSafeInteger(evidence.baseline.mouseMode.revision) &&
      evidence.baseline.mouseMode.revision > 0 &&
      evidence.baseline.mouseMode.incarnation === evidence.baseline.canonicalIncarnation &&
      /^[0-9a-f]{16}$/u.test(evidence.baseline.mouseMode.stateHash ?? "") &&
      evidence.baseline.conditioning?.kind === "control-key" &&
      evidence.baseline.conditioning.requestedKey === "y" &&
      evidence.baseline.conditioning.applicationMouseReceipts === 0,
    selectionDeliveryExact: exactDelivery(selection?.delivery, "selection-drag", evidence?.host),
    selectionCellsExact:
      Number.isSafeInteger(selection?.style?.cells) &&
      selection.style.cells >= 2 &&
      selection.style.extraChangedCells === 0 &&
      SHA256.test(selection?.presentationHmac ?? "") &&
      exactSelectionRequest(selection.delivery, evidence?.baseline?.point),
    selectionClipboardExact: exactClipboard(selection?.delivery?.clipboard, evidence?.clipboard),
    selectionFenceHealthy: exactCopyFence(
      selection?.copyFence,
      expected,
      evidence?.baseline?.mouseMode,
    ),
    copyDeliveryExact: exactDelivery(copy?.delivery, "copy-capture", evidence?.host),
    copyClipboardExact:
      copy?.delivery?.phases === 1 &&
      copy.delivery.transportCalls === 1 &&
      exactClipboard(copy?.delivery?.clipboard, evidence?.clipboard) &&
      exactCopyFence(copy?.copyFence, expected, evidence?.baseline?.mouseMode) &&
      copy.copyFence.copyOrdinal === selection.copyFence.copyOrdinal + 1 &&
      exactCopySequence(copy?.copySequence, copy?.copyFence),
    appMouseForwardedExact:
      Array.isArray(appMouse?.deliveries) &&
      appMouse.deliveries.length >= 30 &&
      appMouse.deliveries.length <= 64 &&
      appMouse.deliveries.every(
        (delivery, index) =>
          exactDelivery(delivery, "application-mouse", evidence?.host) &&
          delivery.phases === 1 &&
          delivery.transportCalls === 1 &&
          delivery?.requestedAction === ["down", "drag", "up"][index % 3] &&
          delivery?.requestedPoint?.x ===
            evidence?.baseline?.point?.from?.x + (index % 3 === 0 ? 0 : 1) &&
          delivery?.requestedPoint?.y === evidence?.baseline?.point?.from?.y &&
          delivery?.requestedButton === "left" &&
          Array.isArray(delivery?.requestedModifiers) &&
          delivery.requestedModifiers.length === 0,
      ) &&
      appMouse?.terminalInputDelta === appMouse.deliveries.length &&
      appMouse?.localSelectionCopyDelta === 0 &&
      SHA256.test(appMouse?.terminalProofHmac ?? "") &&
      appMouse?.acceptedReceiptsExact === true,
    appMouseDistributionExact:
      exactApplicationMouseDistributionSummary(
        appMouse?.distribution,
        recomputedAppMouseDistribution,
      ) &&
      recomputedAppMouseDistribution.qualified === true &&
      recomputedAppMouseDistribution.sampleCount === appMouse?.deliveries?.length,
    localModeExact:
      exactDelivery(localMode?.delivery, "selection-drag", evidence?.host) &&
      exactSelectionRequest(localMode.delivery, localMode.point) &&
      localMode?.terminalInputDelta === 0 &&
      localMode?.style?.extraChangedCells === 0 &&
      SHA256.test(localMode?.delivery?.selectionStyle?.presentationHmac ?? "") &&
      exactClipboard(localMode?.delivery?.clipboard, evidence?.clipboard) &&
      exactCopyFence(localMode?.copyFence, expected) &&
      localMode.copyFence.copyOrdinal === copy.copyFence.copyOrdinal + 1,
    workspaceClientExact:
      evidence?.workspaceClient?.pendingCount === 0 &&
      evidence.workspaceClient.clientGeneration === expected?.clientGeneration &&
      evidence.workspaceClient.workspaceName === expected?.workspaceName &&
      boundedIdentity(evidence.workspaceClient.authorityWorkspaceName) &&
      evidence.workspaceClient.authorityWorkspaceName ===
        evidence.workspaceClient.derivedWorkspaceName &&
      evidence.workspaceClient.semanticPaneId === expected?.semanticPaneId &&
      evidence.workspaceClient.sameRecordExact === true &&
      evidence.workspaceClient.resourceCount === 1 &&
      evidence.workspaceClient.activeResourceCount === 1 &&
      Number.isSafeInteger(expected?.terminalResourceRevision) &&
      expected.terminalResourceRevision >= 0 &&
      Number.isSafeInteger(evidence.workspaceClient.terminalResourceRevision) &&
      evidence.workspaceClient.terminalResourceRevision >= 0 &&
      evidence.workspaceClient.terminalResourceRevision === expected?.terminalResourceRevision,
    tmuxExact:
      evidence?.tmux?.semanticPaneId === expected?.semanticPaneId &&
      evidence.tmux.geometryStable === true &&
      evidence.tmux.applicationMouseMode === "sgr-drag" &&
      evidence.tmux.snapshotExact === true,
    webExact:
      evidence?.web?.qualified === true &&
      evidence.web.stableExactSamples === 2 &&
      evidence.web.windowGroupCount === 1 &&
      evidence.web.terminalNodeCount === 1 &&
      evidence.web.semanticPaneExact === true,
    correlationExact:
      evidence?.correlation?.daemon === true &&
      evidence.correlation.workspaceClient === true &&
      evidence.correlation.tui === true &&
      evidence.correlation.web === true &&
      evidence.correlation.tmux === true,
    zeroIdleWork:
      evidence?.work?.identicalIdleFrames === 0 &&
      evidence.work.unchangedPaneGridWalks === 0 &&
      evidence.work.terminalPaintsOutsideGestures === 0,
    writerHealthy: exactWriterHealth(evidence?.writerHealth),
  });
  const firstFailedPredicate =
    Object.entries(predicates).find(([, qualified]) => !qualified)?.[0] ?? null;
  return Object.freeze({
    qualified: firstFailedPredicate === null,
    firstFailedPredicate,
    predicates,
    appMouseCausalSamples: recomputedAppMouseDistribution.samples,
    metrics: Object.freeze({
      selectedCells: Number.isSafeInteger(selection?.style?.cells) ? selection.style.cells : null,
      clipboardBytes: Number.isSafeInteger(evidence?.clipboard?.bytes)
        ? evidence.clipboard.bytes
        : null,
      appMouseSampleCount: recomputedAppMouseDistribution.sampleCount,
      appMouseP95Ms: recomputedAppMouseDistribution.p95Ms,
      appMouseP99Ms: recomputedAppMouseDistribution.p99Ms,
    }),
  });
}

export function selectionClipboardEvidence(text, key) {
  if (typeof text !== "string" || !Buffer.isBuffer(key) || key.byteLength < 32) return null;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes < 1 || bytes > 1_000_000) return null;
  return Object.freeze({ bytes, hmac: createHmac("sha256", key).update(text).digest("hex") });
}

function percentile(values, quantile) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

const APPLICATION_MOUSE_SAMPLE_KEYS = Object.freeze(
  [
    "action",
    "causalExact",
    "durationMicros",
    "durationMs",
    "fenceCount",
    "gestureExact",
    "gestureHmac",
    "hostFrameCount",
    "identityExact",
    "inputCount",
    "orderExact",
    "ordinal",
    "paintCount",
    "pointExact",
    "pointerButton",
    "pointerColumn",
    "pointerRow",
    "receiptCode",
    "receiptColumn",
    "receiptExact",
    "receiptOrdinal",
    "receiptRelease",
    "receiptRow",
    "traceHmac",
    "unique",
    "version",
    "writerDroppedRecords",
    "writerExact",
    "writerFailed",
    "writerOversizedRecords",
  ].sort(),
);

function exactApplicationMouseSampleShape(sample) {
  return (
    sample !== null &&
    typeof sample === "object" &&
    !Array.isArray(sample) &&
    JSON.stringify(Object.keys(sample).sort()) === JSON.stringify(APPLICATION_MOUSE_SAMPLE_KEYS)
  );
}

function projectApplicationMouseSample(sample) {
  return Object.freeze(
    Object.fromEntries(APPLICATION_MOUSE_SAMPLE_KEYS.map((key) => [key, sample?.[key] ?? null])),
  );
}

function applicationMousePrivateId(key, kind, value) {
  if (!Buffer.isBuffer(key) || key.byteLength < 32 || !UUID_V4.test(value ?? "")) return null;
  return createHmac("sha256", key).update(`${kind}\0${value}`).digest("hex");
}

function canonicalDurationMs(durationMicros) {
  return Number.isSafeInteger(durationMicros) && durationMicros >= 0
    ? Number((durationMicros / 1_000).toFixed(3))
    : null;
}

function applicationMouseSampleFailureReason({
  sample,
  ordinal,
  samples,
  expected,
  traceHmacCount,
  seenGestureHmacs,
}) {
  if (!exactApplicationMouseSampleShape(sample)) return "sample-shape";
  if (sample.version !== 1 || sample.ordinal !== ordinal) return "ordinal";
  const action = ["down", "drag", "up"][ordinal % 3];
  if (sample.action !== action) return "action";
  if (!SHA256.test(sample.traceHmac) || traceHmacCount !== samples.length)
    return "trace-uniqueness";
  const gestureStart = samples[ordinal - (ordinal % 3)];
  if (
    !SHA256.test(sample.gestureHmac) ||
    sample.gestureHmac !== gestureStart?.gestureHmac ||
    (ordinal % 3 === 0 && seenGestureHmacs.has(sample.gestureHmac)) ||
    sample.gestureExact !== true
  )
    return "gesture-grouping";
  if (ordinal % 3 === 0) seenGestureHmacs.add(sample.gestureHmac);
  if (
    !Number.isSafeInteger(sample.durationMicros) ||
    sample.durationMicros < 0 ||
    sample.durationMicros > 5_000_000 ||
    sample.durationMs !== canonicalDurationMs(sample.durationMicros)
  )
    return "duration";
  if (
    sample.inputCount !== 1 ||
    sample.paintCount !== 1 ||
    sample.hostFrameCount !== 1 ||
    sample.fenceCount !== 1
  )
    return "causal-cardinality";
  if (
    !Number.isSafeInteger(expected?.column) ||
    !Number.isSafeInteger(expected?.row) ||
    sample.pointerColumn !== expected.column + (ordinal % 3 === 0 ? 0 : 1) ||
    sample.pointerRow !== expected.row ||
    sample.pointerButton !== 0 ||
    sample.pointExact !== true
  )
    return "point";
  if (
    sample.receiptOrdinal !== ordinal + 1 ||
    sample.receiptCode !== (ordinal % 3 === 1 ? 32 : 0) ||
    sample.receiptColumn !== expected.column + (ordinal % 3 === 0 ? 1 : 2) ||
    sample.receiptRow !== expected.row + 1 ||
    sample.receiptRelease !== (ordinal % 3 === 2) ||
    sample.receiptExact !== true
  )
    return "receipt";
  if (sample.identityExact !== true || sample.orderExact !== true) return "identity-order";
  if (
    sample.writerDroppedRecords !== 0 ||
    sample.writerOversizedRecords !== 0 ||
    sample.writerFailed !== false ||
    sample.writerExact !== true
  )
    return "writer";
  if (sample.causalExact !== true || sample.unique !== true) return "causal-summary";
  return null;
}

export function assessApplicationMouseDistribution(samples, expected) {
  const bounded = Array.isArray(samples) && samples.length === 30 ? samples : [];
  const projected = Object.freeze(bounded.map(projectApplicationMouseSample));
  const traceHmacs = new Set(bounded.map((sample) => sample?.traceHmac));
  const gestureHmacs = new Set();
  const reasons = bounded.map((sample, ordinal) =>
    applicationMouseSampleFailureReason({
      sample,
      ordinal,
      samples: bounded,
      expected,
      traceHmacCount: traceHmacs.size,
      seenGestureHmacs: gestureHmacs,
    }),
  );
  const valid = bounded.filter((_, ordinal) => reasons[ordinal] === null);
  const durationMicros = valid.map((sample) => sample.durationMicros);
  const p95Micros = percentile(durationMicros, 0.95);
  const p99Micros = percentile(durationMicros, 0.99);
  const p95Ms = canonicalDurationMs(p95Micros);
  const p99Ms = canonicalDurationMs(p99Micros);
  return Object.freeze({
    sampleCount: bounded.length,
    uniqueSamples: traceHmacs.size === bounded.length ? bounded.length : traceHmacs.size,
    causalSamples: valid.length,
    p95Ms,
    p99Ms,
    qualified:
      bounded.length >= 30 &&
      valid.length === bounded.length &&
      p95Ms !== null &&
      p99Ms !== null &&
      p95Ms <= 16.67 &&
      p99Ms <= 33,
    samples: projected,
  });
}

export function applicationMouseDistributionFailureObservation({
  samples,
  distribution,
  expected,
  deliveryCount,
  receiptCount,
}) {
  const bounded = Array.isArray(samples) && samples.length <= 30 ? samples : [];
  const traceHmacCount = new Set(bounded.map((sample) => sample?.traceHmac)).size;
  const seenGestureHmacs = new Set();
  let firstInvalidOrdinal = null;
  let firstInvalidReason =
    Number.isSafeInteger(deliveryCount) &&
    Number.isSafeInteger(receiptCount) &&
    deliveryCount !== receiptCount
      ? "receipt-count"
      : bounded.length === 30
        ? null
        : "sample-count";
  if (firstInvalidReason === null)
    for (let ordinal = 0; ordinal < bounded.length; ordinal += 1) {
      const reason = applicationMouseSampleFailureReason({
        sample: bounded[ordinal],
        ordinal,
        samples: bounded,
        expected,
        traceHmacCount,
        seenGestureHmacs,
      });
      if (reason === null) continue;
      firstInvalidOrdinal = ordinal;
      firstInvalidReason = reason;
      break;
    }
  if (firstInvalidReason === null && distribution?.qualified !== true)
    firstInvalidReason = "distribution-budget";
  return Object.freeze({
    operation: "application-mouse-distribution",
    deliveryCount: Number.isSafeInteger(deliveryCount)
      ? Math.min(Math.max(deliveryCount, 0), 64)
      : 0,
    receiptCount: Number.isSafeInteger(receiptCount) ? Math.min(Math.max(receiptCount, 0), 64) : 0,
    sampleCount: Math.min(bounded.length, 30),
    uniqueSamples: Number.isSafeInteger(distribution?.uniqueSamples)
      ? Math.min(Math.max(distribution.uniqueSamples, 0), 30)
      : 0,
    causalSamples: Number.isSafeInteger(distribution?.causalSamples)
      ? Math.min(Math.max(distribution.causalSamples, 0), 30)
      : 0,
    firstInvalidOrdinal,
    firstInvalidReason,
    samples: Object.freeze(bounded.map(projectApplicationMouseSample)),
  });
}

export function applicationMouseCausalSamples({ records, expected, receipts, evidenceKey }) {
  if (!Array.isArray(records) || records.length > 100_000 || !Array.isArray(receipts)) return null;
  const origins = records.filter(
    (record) =>
      record?.type === "performance.input-origin" &&
      record.origin === "application-mouse" &&
      record.semanticPaneId === expected?.semanticPaneId &&
      record.generation === expected?.daemonGeneration,
  );
  if (origins.length !== receipts.length || origins.length < 30 || origins.length > 64) return null;
  const samples = [];
  const traceCounts = new Map();
  const gestureIds = new Set();
  for (const origin of origins)
    traceCounts.set(origin.traceId, (traceCounts.get(origin.traceId) ?? 0) + 1);
  for (let ordinal = 0; ordinal < origins.length; ordinal += 1) {
    const origin = origins[ordinal];
    const input = records.filter(
      (record) =>
        record?.type === "performance.stage" &&
        record.stage === "input" &&
        record.traceId === origin.traceId,
    );
    const paint = records.filter(
      (record) =>
        record?.type === "performance.stage" &&
        record.stage === "paint" &&
        record.traceId === origin.traceId,
    );
    const painted = paint[0];
    const hostFrames = records.filter(
      (record) =>
        record?.type === "performance.terminal-canonical-host-frame" &&
        record.semanticPaneId === expected.semanticPaneId &&
        record.generation === painted?.generation &&
        record.incarnation === painted?.incarnation &&
        record.revision === painted?.revision &&
        record.stateHash === painted?.stateHash &&
        record.atMicros >= painted?.endedAtMicros,
    );
    const fences = records.filter(
      (record) =>
        record?.type === "performance.terminal-frame-fence" &&
        record.semanticPaneId === expected.semanticPaneId &&
        record.generation === painted?.generation &&
        record.incarnation === painted?.incarnation &&
        record.revision === painted?.revision &&
        record.stateHash === painted?.stateHash &&
        record.atMicros >= hostFrames[0]?.atMicros &&
        record.writerHealth?.droppedRecords === 0 &&
        record.writerHealth?.failed === false,
    );
    const action = ["down", "drag", "up"][ordinal % 3];
    const receipt = receipts[ordinal];
    const gestureStart = origins[ordinal - (ordinal % 3)];
    const gestureExact =
      UUID_V4.test(origin?.gestureId ?? "") &&
      origin.gestureId === gestureStart?.gestureId &&
      (ordinal % 3 !== 0 || !gestureIds.has(origin.gestureId));
    if (ordinal % 3 === 0 && gestureExact) gestureIds.add(origin.gestureId);
    const pointExact =
      origin?.pointerAction === action &&
      origin?.pointerColumn === expected.column + (ordinal % 3 === 0 ? 0 : 1) &&
      origin?.pointerRow === expected.row &&
      origin?.pointerButton === 0;
    const receiptExact =
      receipt?.ordinal === ordinal + 1 &&
      receipt?.code === (ordinal % 3 === 1 ? 32 : 0) &&
      receipt?.column === expected.column + (ordinal % 3 === 0 ? 1 : 2) &&
      receipt?.row === expected.row + 1 &&
      receipt?.release === (ordinal % 3 === 2);
    const identityExact =
      origin?.processId === expected.processId &&
      origin?.clockId === "opentui-performance-now" &&
      origin?.clockKind === "performance-now" &&
      input[0]?.processId === origin?.processId &&
      input[0]?.clockId === origin?.clockId &&
      input[0]?.clockKind === origin?.clockKind &&
      input[0]?.scenario === "terminal-input-to-paint" &&
      painted?.processId === origin?.processId &&
      painted?.clockId === origin?.clockId &&
      painted?.clockKind === origin?.clockKind &&
      painted?.scenario === "terminal-input-to-paint" &&
      painted?.paintStateIdentity === "latest-canonical-state-blitted" &&
      painted?.semanticPaneId === expected.semanticPaneId &&
      painted?.generation === expected.canonicalGeneration &&
      painted?.incarnation === origin?.incarnation &&
      hostFrames[0]?.processId === origin?.processId &&
      hostFrames[0]?.clockId === origin?.clockId &&
      hostFrames[0]?.clockKind === origin?.clockKind &&
      fences[0]?.processId === origin?.processId &&
      fences[0]?.clockId === origin?.clockId &&
      fences[0]?.clockKind === origin?.clockKind &&
      fences[0]?.daemonGeneration === expected.daemonGeneration &&
      Number.isSafeInteger(hostFrames[0]?.rendererEpoch) &&
      hostFrames[0].rendererEpoch >= 0 &&
      fences[0]?.rendererEpoch === hostFrames[0].rendererEpoch;
    const orderExact =
      Number.isSafeInteger(origin?.atMicros) &&
      Number.isSafeInteger(input[0]?.startedAtMicros) &&
      Number.isSafeInteger(input[0]?.endedAtMicros) &&
      input[0].startedAtMicros >= origin.atMicros &&
      input[0].endedAtMicros >= input[0].startedAtMicros &&
      Number.isSafeInteger(origin?.revision) &&
      origin.revision >= 0 &&
      typeof origin?.stateHash === "string" &&
      origin.stateHash.length > 0 &&
      origin.stateHash.length <= 128 &&
      Number.isSafeInteger(painted?.revision) &&
      painted.revision >= origin.revision &&
      Number.isSafeInteger(painted?.startedAtMicros) &&
      painted.startedAtMicros >= input[0].endedAtMicros &&
      Number.isSafeInteger(painted?.endedAtMicros) &&
      painted.endedAtMicros >= origin.atMicros;
    const writerExact =
      fences[0]?.writerHealth?.droppedRecords === 0 &&
      fences[0]?.writerHealth?.oversizedRecords === 0 &&
      fences[0]?.writerHealth?.failed === false;
    const unique = UUID_V4.test(origin?.traceId ?? "") && traceCounts.get(origin.traceId) === 1;
    const causalExact =
      input.length === 1 &&
      paint.length === 1 &&
      hostFrames.length === 1 &&
      fences.length === 1 &&
      gestureExact &&
      identityExact &&
      orderExact &&
      writerExact;
    const durationMicros =
      Number.isSafeInteger(origin?.atMicros) && Number.isSafeInteger(painted?.endedAtMicros)
        ? painted.endedAtMicros - origin.atMicros
        : null;
    samples.push(
      Object.freeze({
        version: 1,
        ordinal,
        action,
        traceHmac: applicationMousePrivateId(evidenceKey, "trace", origin?.traceId),
        gestureHmac: applicationMousePrivateId(evidenceKey, "gesture", origin?.gestureId),
        unique,
        durationMicros,
        durationMs: canonicalDurationMs(durationMicros),
        inputCount: input.length,
        paintCount: paint.length,
        hostFrameCount: hostFrames.length,
        fenceCount: fences.length,
        pointerColumn: origin?.pointerColumn ?? null,
        pointerRow: origin?.pointerRow ?? null,
        pointerButton: origin?.pointerButton ?? null,
        receiptOrdinal: receipt?.ordinal ?? null,
        receiptCode: receipt?.code ?? null,
        receiptColumn: receipt?.column ?? null,
        receiptRow: receipt?.row ?? null,
        receiptRelease: receipt?.release ?? null,
        pointExact,
        receiptExact,
        gestureExact,
        identityExact,
        orderExact,
        writerDroppedRecords: fences[0]?.writerHealth?.droppedRecords ?? null,
        writerOversizedRecords: fences[0]?.writerHealth?.oversizedRecords ?? null,
        writerFailed: fences[0]?.writerHealth?.failed ?? null,
        writerExact,
        causalExact,
      }),
    );
  }
  return Object.freeze(samples);
}
