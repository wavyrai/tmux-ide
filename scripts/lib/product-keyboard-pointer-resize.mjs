import { createHash } from "node:crypto";
import stringWidth from "string-width";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_SAMPLES = 512;
const GUIDE_MARKER = Object.freeze({ cols: "╎", rows: "╌" });
export const RESIZE_PREVIEW_P95_BUDGET_MS = 16.67;

/** Exact marker proof for a decoded ProductRig framebuffer after a resize fence. */
export function inspectResizeContentContinuity({ plain, cols, rows, marker }) {
  const unavailable = (reason) =>
    Object.freeze({
      exact: false,
      reason,
      markerCount: 0,
      nonBlankCells: 0,
      markerHash: null,
      frameDigest: null,
    });
  if (
    typeof plain !== "string" ||
    plain.length > 4 * 1024 * 1024 ||
    !boundedIdentity(marker) ||
    !Number.isSafeInteger(cols) ||
    cols < 1 ||
    !Number.isSafeInteger(rows) ||
    rows < 1
  )
    return unavailable("invalid-frame");
  const lines = plain.split("\n");
  if (lines.length !== rows || lines.some((line) => stringWidth(line) !== cols))
    return unavailable("non-rectangular-frame");
  const markerCount = plain.split(marker).length - 1;
  const nonBlankCells = [...plain].filter((value) => value !== " " && value !== "\n").length;
  const exact = markerCount === 1 && nonBlankCells >= marker.length;
  return Object.freeze({
    exact,
    reason: exact ? null : markerCount !== 1 ? "marker-cardinality" : "blank-frame",
    markerCount,
    nonBlankCells: Math.min(nonBlankCells, 4 * 1024 * 1024),
    markerHash: createHash("sha256").update(marker).digest("hex"),
    frameDigest: createHash("sha256").update(plain).digest("hex"),
  });
}

export function assessResizePostPromotionCommands(commands) {
  if (!Array.isArray(commands) || commands.length < 6 || commands.length > 64) return false;
  const names = commands.map((command) => (Array.isArray(command) ? command[0] : null));
  return (
    names.every((name) => name === "list-panes" || name === "capture-pane") &&
    names.filter((name) => name === "list-panes").length >= 2 &&
    names.filter((name) => name === "capture-pane").length >= 4
  );
}

export function assessExactResizeTmuxBaseline(snapshot) {
  const panes = Array.isArray(snapshot?.panes) ? snapshot.panes : [];
  const leaves = Array.isArray(snapshot?.layout?.leaves) ? snapshot.layout.leaves : [];
  const orderedLeaves = leaves.slice().sort((left, right) => left.left - right.left);
  const leafGeometryExact =
    orderedLeaves.length === 2 &&
    orderedLeaves[0]?.left === 0 &&
    orderedLeaves[0]?.top === 0 &&
    orderedLeaves[0]?.height === 41 &&
    orderedLeaves[1]?.left === orderedLeaves[0].width + 1 &&
    orderedLeaves[1]?.top === 0 &&
    orderedLeaves[1]?.height === 41 &&
    [orderedLeaves[0]?.width, orderedLeaves[1]?.width]
      .sort((left, right) => left - right)
      .join(",") === "65,66";
  const orderedPanes = panes.slice().sort((left, right) => left.left - right.left);
  const paneGeometryExact =
    orderedPanes.length === 2 &&
    orderedPanes.every(
      (pane, index) =>
        pane.left === orderedLeaves[index]?.left &&
        pane.width === orderedLeaves[index]?.width &&
        pane.paneId === orderedLeaves[index]?.id,
    );
  const semanticIdentityExact =
    snapshot?.requireSemanticPaneIds === false ||
    (panes.every((pane) => boundedIdentity(pane.semanticPaneId)) &&
      new Set(panes.map(({ semanticPaneId }) => semanticPaneId)).size === 2);
  const exact =
    typeof snapshot?.visibleLayout === "string" &&
    snapshot.visibleLayout.length > 0 &&
    snapshot.visibleLayout.length <= 8_192 &&
    snapshot?.layout?.width === 132 &&
    snapshot.layout.height === 41 &&
    leafGeometryExact &&
    paneGeometryExact &&
    panes.length === 2 &&
    panes.every(
      (pane) =>
        pane.visibleLayout === snapshot.visibleLayout &&
        pane.paneBorderStatus === "top" &&
        /^%\d+$/u.test(pane.paneId ?? "") &&
        pane.top === 1 &&
        pane.height === 40,
    ) &&
    panes.every(
      (pane) =>
        Number.isSafeInteger(pane.processId) &&
        pane.processId > 1 &&
        pane.currentCommand === snapshot.expectedCommand,
    ) &&
    new Set(panes.map(({ processId }) => processId)).size === 2 &&
    new Set(panes.map(({ paneId }) => paneId)).size === 2 &&
    semanticIdentityExact &&
    panes.some(({ paneId }) => paneId === snapshot.seedPaneId) &&
    snapshot.targetMarkerCount === 1 &&
    snapshot.otherMarkerCount === 0;
  return Object.freeze({
    exact,
    paneCount: Math.min(panes.length, 513),
    leafCount: Math.min(leaves.length, 513),
  });
}

function boundedIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function positiveCell(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 4_096;
}

function exactIdentity(value, expected) {
  return (
    value?.processId === expected?.processId &&
    value?.daemonGeneration === expected?.daemonGeneration &&
    value?.clientGeneration === expected?.clientGeneration &&
    value?.workspaceName === expected?.workspaceName &&
    value?.sessionName === expected?.sessionName &&
    boundedIdentity(value?.processId) &&
    UUID_V4.test(value?.daemonGeneration ?? "") &&
    Number.isSafeInteger(value?.clientGeneration) &&
    value.clientGeneration >= 0 &&
    boundedIdentity(value?.workspaceName) &&
    boundedIdentity(value?.sessionName)
  );
}

function exactResizeTarget(value, expected) {
  return (
    exactIdentity(value, expected) &&
    value?.semanticPaneId === expected?.semanticPaneId &&
    boundedIdentity(value?.semanticPaneId) &&
    ["cols", "rows"].includes(value?.axis) &&
    positiveCell(value?.beforeCells) &&
    positiveCell(value?.requestedCells) &&
    positiveCell(value?.settledCells) &&
    value.beforeCells !== value.requestedCells
  );
}

function percentile95(samples) {
  const sorted = samples.slice().sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
}

export function inspectResizeGuideFramebuffer({ plain, cols, rows, guide, axis }) {
  if (
    typeof plain !== "string" ||
    plain.length > 4 * 1024 * 1024 ||
    !Number.isSafeInteger(cols) ||
    cols < 1 ||
    !Number.isSafeInteger(rows) ||
    rows < 1 ||
    !["cols", "rows"].includes(axis) ||
    !Number.isSafeInteger(guide?.x) ||
    !Number.isSafeInteger(guide?.y) ||
    !Number.isSafeInteger(guide?.width) ||
    !Number.isSafeInteger(guide?.height) ||
    guide.x < 0 ||
    guide.y < 0 ||
    guide.width < 1 ||
    guide.height < 1 ||
    guide.x + guide.width > cols ||
    guide.y + guide.height > rows
  )
    return Object.freeze({
      exact: false,
      reason: "invalid-frame-or-rect",
      matchCount: 0,
      positions: [],
    });
  const lines = plain.split("\n");
  if (lines.length !== rows || lines.some((line) => stringWidth(line) !== cols))
    return Object.freeze({
      exact: false,
      reason: "non-rectangular-frame",
      matchCount: 0,
      positions: [],
    });
  const marker = GUIDE_MARKER[axis];
  const positions = [];
  for (let y = 0; y < lines.length; y += 1) {
    let offset = 0;
    while (offset < lines[y].length) {
      const index = lines[y].indexOf(marker, offset);
      if (index < 0) break;
      positions.push(Object.freeze({ x: stringWidth(lines[y].slice(0, index)), y }));
      offset = index + marker.length;
    }
  }
  const expected = [];
  for (let y = 0; y < guide.height; y += 1)
    for (let x = 0; x < guide.width; x += 1) expected.push(`${guide.x + x}:${guide.y + y}`);
  const actual = positions.map(({ x, y }) => `${x}:${y}`);
  const exact =
    positions.length === expected.length &&
    actual.slice().sort().join("|") === expected.slice().sort().join("|");
  return Object.freeze({
    exact,
    reason: exact ? null : positions.length === 0 ? "missing" : "wrong-cardinality-or-rect",
    marker,
    matchCount: Math.min(positions.length, 4_096),
    expectedCount: expected.length,
    positions: Object.freeze(positions.slice(0, 16)),
    frameDigest: createHash("sha256").update(plain).digest("hex"),
  });
}

function exactWriterHealth(value) {
  return (
    value?.droppedRecords === 0 && value?.failed === false && value?.pendingCriticalRecords === 0
  );
}

function exactContentContinuity(value) {
  return (
    value?.exact === true &&
    value.reason === null &&
    value.markerCount === 1 &&
    Number.isSafeInteger(value.nonBlankCells) &&
    value.nonBlankCells > 0 &&
    /^[0-9a-f]{64}$/u.test(value.markerHash ?? "") &&
    /^[0-9a-f]{64}$/u.test(value.frameDigest ?? "")
  );
}

function exactHostedDelivery(value, kind, action, anchor = value) {
  return (
    value?.version === 1 &&
    value.kind === kind &&
    value.delivery === "exact-bytes-to-immutable-host-pane-pty" &&
    /^%\d+$/u.test(value.paneId ?? "") &&
    /^\$\d+$/u.test(value.sessionId ?? "") &&
    value.target === value.paneId &&
    value.paneId === anchor?.paneId &&
    value.sessionId === anchor?.sessionId &&
    value.geometry?.cols === 160 &&
    value.geometry?.rows === 44 &&
    Number.isSafeInteger(value.bytesInjected) &&
    value.bytesInjected > 0 &&
    (kind !== "application-mouse" || value.requestedAction === action)
  );
}

function qualifyPreviewSample(sample, expected, ordinal, deliveryAnchor) {
  const ingress = sample?.pointerIngress;
  const pointExact =
    ingress?.action === "drag" &&
    sample.delivery?.requestedPoint?.x === ingress.x &&
    sample.delivery?.requestedPoint?.y === ingress.y &&
    (sample.axis === "cols"
      ? ingress.x === sample.guide?.x &&
        ingress.y >= sample.guide?.y &&
        ingress.y < sample.guide.y + sample.guide.height
      : ingress.y === sample.guide?.y &&
        ingress.x >= sample.guide?.x &&
        ingress.x < sample.guide.x + sample.guide.width);
  return (
    sample?.ordinal === ordinal &&
    UUID_V4.test(sample?.traceId ?? "") &&
    exactIdentity(sample, expected) &&
    sample.semanticPaneId === expected.semanticPaneId &&
    ["cols", "rows"].includes(sample.axis) &&
    positiveCell(sample.cells) &&
    Number.isFinite(sample.durationMs) &&
    sample.durationMs >= 0 &&
    sample.durationMs <= 1_000 &&
    Number.isSafeInteger(sample.guide?.x) &&
    sample.guide.x >= 0 &&
    Number.isSafeInteger(sample.guide?.y) &&
    sample.guide.y >= 0 &&
    positiveCell(sample.guide?.width) &&
    positiveCell(sample.guide?.height) &&
    UUID_V4.test(ingress?.gestureId ?? "") &&
    ingress?.traceId === sample.traceId &&
    Number.isSafeInteger(ingress?.atMicros) &&
    ingress.atMicros >= 0 &&
    pointExact &&
    exactHostedDelivery(sample.delivery, "application-mouse", "drag", deliveryAnchor) &&
    sample.actualFrame?.traceId === sample.traceId &&
    sample.actualFrame?.guideDigest === sample.guide?.digest &&
    /^[0-9a-f]{64}$/u.test(sample.actualFrame?.presentationDigest ?? "") &&
    typeof sample.guide?.digest === "string" &&
    /^[0-9a-f]{64}$/u.test(sample.guide.digest) &&
    sample.actualFrame?.presentationChanged === true &&
    sample.actualFrame?.identityExact === true &&
    sample.actualFrame?.framebuffer?.exact === true &&
    exactContentContinuity(sample.actualFrame?.contentContinuity) &&
    sample.actualFrame.framebuffer.matchCount === sample.guide.width * sample.guide.height &&
    /^[0-9a-f]{64}$/u.test(sample.actualFrame.framebuffer.frameDigest ?? "") &&
    exactWriterHealth(sample.fence?.writerHealth)
  );
}

/** Pure fail-closed assessment for the ProductRig keyboard/pointer resize journey. */
export function assessProductKeyboardPointerResize({ evidence, expected }) {
  const samples = Array.isArray(evidence?.pointerPreviews) ? evidence.pointerPreviews : [];
  const sampleCountExact = samples.length >= 30 && samples.length <= MAX_SAMPLES;
  const samplesExact =
    sampleCountExact &&
    samples.every((sample, ordinal) =>
      qualifyPreviewSample(sample, expected, ordinal, evidence?.keyboard?.delivery),
    );
  const uniqueTraces =
    samplesExact && new Set(samples.map(({ traceId }) => traceId)).size === samples.length;
  const oneGesture =
    samplesExact &&
    new Set(samples.map(({ pointerIngress }) => pointerIngress.gestureId)).size === 1;
  const p95Ms =
    samplesExact && uniqueTraces && oneGesture
      ? percentile95(samples.map(({ durationMs }) => durationMs))
      : null;
  const keyboard = evidence?.keyboard;
  const pointerRelease = evidence?.pointerRelease;
  const keyboardExact =
    exactResizeTarget(keyboard, expected) &&
    UUID_V4.test(keyboard?.operationId ?? "") &&
    keyboard?.source === "keyboard" &&
    keyboard.axis === "cols" &&
    keyboard.requestedCells === keyboard.beforeCells + 1 &&
    exactHostedDelivery(keyboard?.delivery, "modified-key", "right") &&
    keyboard.delivery?.requestedKey === "right" &&
    keyboard.delivery?.requestedModifiers?.length === 1 &&
    keyboard.delivery.requestedModifiers[0] === "meta" &&
    keyboard?.receipt?.operationId === keyboard.operationId &&
    keyboard.receipt?.verb === "workspace.pane.resize" &&
    keyboard.receipt?.axis === keyboard.axis &&
    keyboard.receipt?.requestedCells === keyboard.requestedCells &&
    ["applied", "unchanged"].includes(keyboard.receipt?.outcome) &&
    keyboard.receipt?.cells === keyboard.settledCells &&
    keyboard?.layout?.cells === keyboard.settledCells &&
    keyboard?.layout?.operationId === keyboard.operationId &&
    keyboard?.frame?.operationId === keyboard.operationId &&
    keyboard.frame?.identityExact === true &&
    /^[0-9a-f]{64}$/u.test(keyboard.frame?.presentationDigest ?? "") &&
    keyboard.frame?.presentationChanged === true &&
    exactContentContinuity(keyboard.frame?.contentContinuity) &&
    exactWriterHealth(keyboard?.fence?.writerHealth);
  const pointerReleaseExact =
    exactResizeTarget(pointerRelease, expected) &&
    UUID_V4.test(pointerRelease?.operationId ?? "") &&
    pointerRelease?.source === "pointer" &&
    exactHostedDelivery(pointerRelease?.delivery, "application-mouse", "up", keyboard?.delivery) &&
    pointerRelease.pointerIngress?.action === "up" &&
    pointerRelease.pointerIngress?.gestureId === samples[0]?.pointerIngress?.gestureId &&
    pointerRelease.delivery?.requestedPoint?.x === pointerRelease.pointerIngress?.x &&
    pointerRelease.delivery?.requestedPoint?.y === pointerRelease.pointerIngress?.y &&
    pointerRelease?.receipt?.operationId === pointerRelease.operationId &&
    pointerRelease.receipt?.verb === "workspace.pane.resize" &&
    pointerRelease.receipt?.axis === pointerRelease.axis &&
    pointerRelease.receipt?.requestedCells === pointerRelease.requestedCells &&
    ["applied", "unchanged"].includes(pointerRelease.receipt?.outcome) &&
    pointerRelease.receipt?.cells === pointerRelease.settledCells &&
    pointerRelease?.layout?.cells === pointerRelease.settledCells &&
    pointerRelease?.layout?.operationId === pointerRelease.operationId &&
    pointerRelease?.frame?.operationId === pointerRelease.operationId &&
    pointerRelease.frame?.identityExact === true &&
    /^[0-9a-f]{64}$/u.test(pointerRelease.frame?.presentationDigest ?? "") &&
    pointerRelease.frame?.presentationChanged === true &&
    exactContentContinuity(pointerRelease.frame?.contentContinuity) &&
    exactWriterHealth(pointerRelease?.fence?.writerHealth);
  const tmuxExact =
    evidence?.tmux?.semanticPaneId === expected?.semanticPaneId &&
    evidence?.tmux?.[pointerRelease?.axis] === pointerRelease?.settledCells &&
    evidence?.tmux?.geometryStable === true;
  const workspaceClientExact =
    evidence?.workspaceClient?.pendingCount === 0 &&
    evidence?.workspaceClient?.semanticPaneId === expected?.semanticPaneId &&
    evidence?.workspaceClient?.lastReceiptOperationId === pointerRelease?.operationId &&
    evidence?.workspaceClient?.lastReceiptPhase === "observed";
  const correlationExact = ["daemon", "workspaceClient", "tui", "web", "tmux"].every(
    (key) => evidence?.correlation?.[key] === true,
  );
  const contentContinuityExact =
    exactContentContinuity(keyboard?.frame?.contentContinuity) &&
    exactContentContinuity(pointerRelease?.frame?.contentContinuity) &&
    samples.length >= 30 &&
    samples.every((sample) => exactContentContinuity(sample.actualFrame?.contentContinuity));
  const predicates = Object.freeze([
    Object.freeze({
      id: "resize-baseline-identity",
      passed: exactIdentity(evidence?.baseline, expected),
    }),
    Object.freeze({ id: "resize-keyboard-causal", passed: keyboardExact }),
    Object.freeze({
      id: "resize-preview-samples",
      passed: Boolean(samplesExact && uniqueTraces && oneGesture),
      actual: samples.length,
    }),
    Object.freeze({
      id: "resize-preview-p95-budget",
      passed: p95Ms !== null && p95Ms <= RESIZE_PREVIEW_P95_BUDGET_MS,
      actual: p95Ms,
    }),
    Object.freeze({ id: "resize-pointer-release-causal", passed: pointerReleaseExact }),
    Object.freeze({ id: "resize-content-continuity", passed: contentContinuityExact }),
    Object.freeze({ id: "resize-tmux-geometry", passed: tmuxExact }),
    Object.freeze({ id: "resize-workspace-client", passed: workspaceClientExact }),
    Object.freeze({ id: "resize-correlation", passed: correlationExact }),
  ]);
  const firstFailedPredicate = predicates.find(({ passed }) => !passed)?.id ?? null;
  return Object.freeze({
    qualified: firstFailedPredicate === null,
    firstFailedPredicate,
    predicates,
    metrics: Object.freeze({ sampleCount: samples.length, previewP95Ms: p95Ms }),
  });
}

export function assessKeyboardPointerResizeJourneyBoundaries({
  timeline,
  assessment,
  correlationComplete,
}) {
  const required = [
    "resize-namespace-ready",
    "resize-daemon-ready",
    "resize-tui-build",
    "resize-tui-started",
    "resize-host-ready",
    "resize-tui-coherent",
    "resize-baseline",
    "resize-keyboard-proved",
    "resize-pointer-preview-distribution",
    "resize-pointer-release-proved",
    "resize-web-correlation",
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
      id: "resize-causal-proof",
      status: assessment?.qualified ? "passed" : "failed",
    }),
  );
  boundaries.push(
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
