import stringWidth from "string-width";
import { projectCanonicalFocusPaneRect } from "../../packages/daemon/src/tui/mirror/runtime/focus-framebuffer-projection.ts";
import { assessFocusWebSemantic } from "./product-configless-owner.mjs";

const AUTHORITIES = Object.freeze(["input", "focus", "geometry"]);
const MAX_PREDICATES = 24;
const FOCUS_WEB_DEADLINE_MS = 60_000;
const FOCUS_WEB_POLL_MS = 25;
// This is the bounded ANSI control-sequence grammar used by the testdrive capture protocol.
const ANSI_ESCAPE =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\x2f#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu;

export function normalizeFocusAnsiFrame(ansiFrame) {
  if (typeof ansiFrame !== "string" || ansiFrame.length > 4 * 1024 * 1024)
    throw new Error("focus ANSI frame is unavailable");
  return ansiFrame.replace(ANSI_ESCAPE, "");
}

export const projectFocusFramebufferRect = projectCanonicalFocusPaneRect;

export function decodeFocusFramebufferCapture(envelope) {
  if (
    envelope?.version !== 1 ||
    !Number.isSafeInteger(envelope.cols) ||
    envelope.cols < 1 ||
    !Number.isSafeInteger(envelope.rows) ||
    envelope.rows < 1 ||
    typeof envelope.ansi !== "string" ||
    envelope.ansi.length > 4 * 1024 * 1024
  ) {
    throw new Error("focus capture envelope is invalid");
  }
  const ansiLines = envelope.ansi.split("\n");
  if (ansiLines.length !== envelope.rows) throw new Error("focus capture row count mismatched");
  const plainLines = ansiLines.map((line) => normalizeFocusAnsiFrame(line));
  if (
    plainLines.some(
      // Rectangular captures may contain printable graphemes only after ANSI removal.
      // eslint-disable-next-line no-control-regex
      (line) => /[\u0000-\u001f\u007f-\u009f]/u.test(line),
    )
  )
    throw new Error("focus capture row contained an invalid terminal control");
  const normalizedAnsi = ansiLines.map((line, index) => {
    const width = stringWidth(plainLines[index]);
    if (width > envelope.cols) throw new Error("focus capture row overflowed declared columns");
    return `${line}${" ".repeat(envelope.cols - width)}`;
  });
  return Object.freeze({
    version: 1,
    cols: envelope.cols,
    rows: envelope.rows,
    ansi: normalizedAnsi.join("\n"),
    plain: plainLines
      .map((line) => `${line}${" ".repeat(envelope.cols - stringWidth(line))}`)
      .join("\n"),
  });
}

const focusGraphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export function sliceFocusTerminalCells(line, left, width) {
  if (
    typeof line !== "string" ||
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(width) ||
    width < 0
  )
    return null;
  let column = 0;
  let result = "";
  for (const { segment } of focusGraphemeSegmenter.segment(line)) {
    const segmentWidth = stringWidth(segment);
    const end = column + segmentWidth;
    if (end > left && column < left + width) {
      if (column < left || end > left + width) return null;
      result += segment;
    }
    column = end;
    if (column >= left + width) break;
  }
  return column >= left + width && stringWidth(result) === width ? result : null;
}

export function inspectFocusFramebufferCapture({
  ansiFrame,
  semanticPaneId,
  expectedMarker,
  projectedRect,
  cursorRow,
}) {
  const invalid = (reason) =>
    Object.freeze({
      valid: false,
      reason,
      plain: "",
      lines: Object.freeze([]),
      observation: Object.freeze({
        matchCount: 0,
        positions: Object.freeze([]),
        positionsTruncated: false,
        frameRows: 0,
        frameMaxWidth: 0,
      }),
    });
  if (
    typeof semanticPaneId !== "string" ||
    semanticPaneId.length === 0 ||
    semanticPaneId.length > 128 ||
    (expectedMarker !== "●" && expectedMarker !== "○")
  )
    return invalid("invalid-identity");
  if (typeof ansiFrame !== "string" || ansiFrame.length > 4 * 1024 * 1024)
    return invalid("capture-invalid");
  const plain = normalizeFocusAnsiFrame(ansiFrame);
  const lines = plain.split("\n");
  const positions = [];
  for (let row = 0; row < lines.length; row += 1) {
    let codeUnitLeft = lines[row].indexOf(semanticPaneId);
    while (codeUnitLeft >= 0) {
      const prefix = lines[row].slice(Math.max(0, codeUnitLeft - 3), codeUnitLeft);
      const markerMatch = prefix.match(/([●○]) $/u);
      const marker = markerMatch?.[1] ?? null;
      const markerCodeUnitLeft = markerMatch
        ? codeUnitLeft - markerMatch[0].length
        : Math.max(0, codeUnitLeft - 2);
      positions.push(
        Object.freeze({
          row,
          left: stringWidth(lines[row].slice(0, markerCodeUnitLeft)),
          marker: marker === "●" ? "active" : marker === "○" ? "inactive" : "other",
        }),
      );
      codeUnitLeft = lines[row].indexOf(semanticPaneId, codeUnitLeft + 1);
    }
  }
  const boundedPositions = Object.freeze(positions.slice(0, 8));
  const observation = Object.freeze({
    matchCount: positions.length,
    positions: boundedPositions,
    positionsTruncated: positions.length > boundedPositions.length,
    frameRows: lines.length,
    frameMaxWidth: lines.reduce((maximum, line) => Math.max(maximum, stringWidth(line)), 0),
  });
  let reason = null;
  if (!projectedRect) reason = "projection-unavailable";
  else if (positions.length === 0) reason = "semantic-chrome-missing";
  else if (positions.length !== 1) reason = "semantic-chrome-ambiguous";
  else if (positions[0].row !== projectedRect.chromeRow || positions[0].left !== projectedRect.left)
    reason = "projected-chrome-mismatch";
  else if (positions[0].marker !== (expectedMarker === "●" ? "active" : "inactive"))
    reason = "marker-mismatch";
  else if (
    !Number.isSafeInteger(cursorRow) ||
    cursorRow < 0 ||
    cursorRow >= projectedRect.bodyRows ||
    projectedRect.firstBodyRow + cursorRow >= lines.length
  )
    reason = "cursor-offscreen";
  else if (
    projectedRect.firstBodyRow + projectedRect.bodyRows > lines.length ||
    lines
      .slice(projectedRect.firstBodyRow, projectedRect.firstBodyRow + projectedRect.bodyRows)
      .some((line) => stringWidth(line) < projectedRect.left + projectedRect.width)
  )
    reason = "projected-body-clipped";
  return Object.freeze({
    valid: reason === null,
    reason,
    plain,
    lines,
    observation,
  });
}

export function advanceFocusFramebufferStability(previousDigest, sample) {
  const valid =
    sample?.valid === true && typeof sample?.digest === "string" && sample.digest.length === 64;
  if (!valid) return Object.freeze({ stable: false, nextDigest: null });
  return Object.freeze({
    stable: previousDigest === sample.digest,
    nextDigest: sample.digest,
  });
}

export async function captureFocusWebSemanticDocument(browserGlobal = globalThis) {
  await new Promise((resolve) => browserGlobal.requestAnimationFrame(() => resolve()));
  const document = browserGlobal.document;
  const boundedAttribute = (node, name, maximum = 512) => {
    const value = node.getAttribute(name);
    return value === null || value.length <= maximum ? value : null;
  };
  const windowNodes = document.querySelectorAll(".window-tabs__tab");
  const terminalNodes = document.querySelectorAll(".terminal-surface");
  const windows = [];
  const terminals = [];
  let semanticPaneBytes = 0;
  for (let index = 0; index < Math.min(windowNodes.length, 513); index += 1) {
    const node = windowNodes[index];
    const semanticPaneIds = boundedAttribute(node, "data-semantic-pane-ids", 8_192);
    const nextSemanticPaneBytes = semanticPaneBytes + (semanticPaneIds?.length ?? 0);
    const semanticPaneIdsBounded =
      semanticPaneIds !== null && nextSemanticPaneBytes <= 65_536 ? semanticPaneIds : null;
    if (semanticPaneIdsBounded !== null) semanticPaneBytes = nextSemanticPaneBytes;
    windows.push({
      windowResourceId: boundedAttribute(node, "data-window-resource-id"),
      label: boundedAttribute(node, "data-window-label", 256),
      semanticPaneIds: semanticPaneIdsBounded,
      paneCount: boundedAttribute(node, "data-pane-count"),
      active: boundedAttribute(node, "data-active"),
    });
  }
  for (let index = 0; index < Math.min(terminalNodes.length, 513); index += 1) {
    const node = terminalNodes[index];
    terminals.push({
      phase: boundedAttribute(node, "data-phase"),
      workspaceName: boundedAttribute(node, "data-workspace-name"),
      semanticPaneId: boundedAttribute(node, "data-semantic-pane-id"),
    });
  }
  const app = document.querySelector(".app");
  return {
    shellSource: app ? boundedAttribute(app, "data-shell-source") : null,
    daemonGeneration: app ? boundedAttribute(app, "data-daemon-generation") : null,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    windowContainerCount: Math.min(document.querySelectorAll(".tiled-workspace").length, 513),
    windowNodeCount: Math.min(windowNodes.length, 513),
    terminalNodeCount: Math.min(terminalNodes.length, 513),
    windows,
    terminals,
  };
}

function boundedFocusWebObservation({
  reason,
  attempts,
  startedAt,
  now,
  deadlineMs,
  stableExactSamples,
  assessment,
}) {
  const normalized = assessment?.normalized ?? {};
  const rawElapsed = now() - startedAt;
  return Object.freeze({
    operation: "wait-for-focus-web-semantic",
    reason,
    attempts: Math.min(Math.max(attempts, 0), 4_096),
    attemptsTruncated: attempts > 4_096,
    elapsedMs: Number.isFinite(rawElapsed) ? Math.max(0, Math.round(rawElapsed)) : null,
    deadlineMs,
    firstFailedPredicate: assessment?.firstFailedPredicate ?? "web-snapshot-unavailable",
    stableExactSamples: Math.min(Math.max(stableExactSamples, 0), 2),
    expectedGroupCount: Number.isSafeInteger(normalized.expectedGroupCount)
      ? normalized.expectedGroupCount
      : null,
    latest: Object.freeze({
      runtimeShellExact: normalized.runtimeShellExact === true,
      daemonGenerationExact: normalized.daemonGenerationExact === true,
      visible: normalized.visible === true,
      focused: normalized.focused === true,
      workspaceCount: normalized.workspaceCount ?? null,
      observedWindowCount: normalized.observedWindowCount ?? null,
      activeWindowCount: normalized.activeWindowCount ?? null,
      availableResourceCount: normalized.availableResourceCount ?? null,
      observedTerminalCount: normalized.observedTerminalCount ?? null,
      connectedTerminalCount: normalized.connectedTerminalCount ?? null,
      windowMembershipExact: normalized.windowMembershipExact === true,
      terminalExact: normalized.terminalExact === true,
      strictQualified: normalized.strictQualified === true,
      digest:
        typeof assessment?.digest === "string" && /^[0-9a-f]{64}$/u.test(assessment.digest)
          ? assessment.digest
          : null,
    }),
    predicates: Object.freeze(
      (assessment?.predicates ?? []).slice(0, 16).map(({ id, passed }) =>
        Object.freeze({
          id: typeof id === "string" && id.length <= 64 ? id : "invalid",
          passed: passed === true,
        }),
      ),
    ),
  });
}

function focusWebFailure(observation) {
  const error = new Error(`focus Web semantic readiness failed: ${observation.reason}`);
  error.boundary = "focus-web-correlation";
  error.observation = observation;
  return error;
}

async function focusWebSampleWithinDeadline(sample, { remainingMs, signal }) {
  if (signal?.aborted)
    throw Object.assign(new Error("aborted"), {
      code: "ABORTED",
    });
  let timer = null;
  let abort = null;
  try {
    return await Promise.race([
      Promise.resolve().then(sample),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error("deadline"), { code: "DEADLINE" })),
          remainingMs,
        );
        abort = () => reject(Object.assign(new Error("aborted"), { code: "ABORTED" }));
        signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (abort !== null) signal?.removeEventListener("abort", abort);
  }
}

async function defaultFocusWebWaitTurn({ delayMs, signal }) {
  await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const complete = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(complete, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function waitForFocusWebSemantic({
  sample,
  health = () => null,
  derivedResources,
  expectedWorkspaceName,
  expectedSemanticPaneId,
  expectedDaemonGeneration,
  signal,
  deadlineMs = FOCUS_WEB_DEADLINE_MS,
  pollMs = FOCUS_WEB_POLL_MS,
  now = () => performance.now(),
  waitTurn = defaultFocusWebWaitTurn,
}) {
  if (
    typeof sample !== "function" ||
    typeof health !== "function" ||
    typeof waitTurn !== "function" ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 1
  )
    throw new TypeError("focus Web semantic waiter options are invalid");
  const startedAt = now();
  let attempts = 0;
  let stableExactSamples = 0;
  let priorExactDigest = null;
  let assessment = null;
  const fail = (reason) => {
    throw focusWebFailure(
      boundedFocusWebObservation({
        reason,
        attempts,
        startedAt,
        now,
        deadlineMs,
        stableExactSamples,
        assessment,
      }),
    );
  };
  const readHealth = async () => {
    try {
      const reason = await health();
      return ["aborted", "page-closed", "browser-disconnected", "dev-server-dead"].includes(reason)
        ? reason
        : reason === null
          ? null
          : "health-invalid";
    } catch {
      return "health-failed";
    }
  };
  for (;;) {
    if (signal?.aborted) fail("aborted");
    const unhealthy = await readHealth();
    if (unhealthy !== null) fail(unhealthy);
    let semantic;
    const elapsedBeforeSample = now() - startedAt;
    if (!Number.isFinite(elapsedBeforeSample) || elapsedBeforeSample >= deadlineMs)
      fail("deadline");
    try {
      semantic = await focusWebSampleWithinDeadline(sample, {
        remainingMs: Math.max(1, Math.floor(deadlineMs - elapsedBeforeSample)),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) fail("aborted");
      if (error?.code === "DEADLINE") fail("deadline");
      const afterFailureHealth = await readHealth();
      fail(afterFailureHealth ?? "snapshot-failed");
    }
    if (signal?.aborted) fail("aborted");
    const postSampleHealth = await readHealth();
    if (postSampleHealth !== null) fail(postSampleHealth);
    attempts += 1;
    assessment = assessFocusWebSemantic({
      web: semantic,
      derivedResources,
      expectedWorkspaceName,
      expectedSemanticPaneId,
      expectedDaemonGeneration,
    });
    if (assessment.qualified) {
      stableExactSamples = assessment.digest === priorExactDigest ? stableExactSamples + 1 : 1;
      priorExactDigest = assessment.digest;
      if (stableExactSamples >= 2)
        return Object.freeze({ semantic, assessment, attempts, stableExactSamples });
    } else {
      stableExactSamples = 0;
      priorExactDigest = null;
    }
    const elapsed = now() - startedAt;
    if (!Number.isFinite(elapsed) || elapsed >= deadlineMs) fail("deadline");
    try {
      await waitTurn({
        delayMs: Math.max(1, Math.min(pollMs, Math.floor(deadlineMs - elapsed))),
        signal,
      });
    } catch {
      if (signal?.aborted) fail("aborted");
      fail("wait-failed");
    }
  }
}

export function assessFocusFramebufferAttempt({
  inspected,
  geometryBeforeDigest,
  geometryAfterDigest,
  pane,
  canonicalLayout,
  expected,
}) {
  const geometryStable =
    typeof geometryBeforeDigest === "string" &&
    geometryBeforeDigest.length > 0 &&
    geometryBeforeDigest === geometryAfterDigest;
  const nativeGeometryExact =
    pane?.windowActive === true &&
    pane.semanticPaneId === expected?.semanticPaneId &&
    pane.width === expected?.viewportCols &&
    pane.height === expected?.viewportRows;
  const canonicalPanes = Array.isArray(canonicalLayout?.panes)
    ? canonicalLayout.panes.filter(
        ({ pane: semanticPaneId }) => semanticPaneId === expected?.semanticPaneId,
      )
    : [];
  const canonicalPane = canonicalPanes[0];
  const canonicalGeometryExact =
    canonicalLayout?.cols === expected?.canonicalCols &&
    canonicalLayout?.rows === expected?.canonicalRows &&
    canonicalPanes.length === 1 &&
    canonicalPane?.active === true &&
    canonicalPane.left === 0 &&
    canonicalPane.top === 0 &&
    canonicalPane.width === expected?.canonicalCols &&
    canonicalPane.height === expected?.canonicalRows;
  return Object.freeze({
    valid:
      inspected?.valid === true && geometryStable && nativeGeometryExact && canonicalGeometryExact,
    geometryStable,
    nativeGeometryExact,
    canonicalGeometryExact,
    reason: !geometryStable
      ? "geometry-drift"
      : !nativeGeometryExact
        ? "native-geometry-mismatch"
        : !canonicalGeometryExact
          ? "canonical-geometry-mismatch"
          : inspected?.reason,
  });
}

export function selectFocusCursorPresentationRow(ansiFrame, bodyRect, cursorRow) {
  if (
    typeof ansiFrame !== "string" ||
    ansiFrame.length > 4 * 1024 * 1024 ||
    bodyRect?.valid !== true ||
    !Number.isSafeInteger(bodyRect.firstBodyRow) ||
    !Number.isSafeInteger(bodyRect.bodyRows) ||
    !Number.isSafeInteger(cursorRow) ||
    cursorRow < 0 ||
    cursorRow >= bodyRect.bodyRows
  )
    throw new Error("focus cursor presentation row is unavailable");
  const row = ansiFrame.split("\n")[bodyRect.firstBodyRow + cursorRow];
  if (typeof row !== "string" || row.length > 64 * 1024)
    throw new Error("focus cursor presentation row is unavailable");
  return row;
}

function boundedString(value, max = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function safeMicros(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function exactOwners(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return AUTHORITIES.every((authority) => value[authority] === expected[authority]);
}

function exactReceipts(value, expected, focused) {
  if (!Array.isArray(value) || value.length !== AUTHORITIES.length) return false;
  const byAuthority = new Map(value.map((receipt) => [receipt?.authority, receipt]));
  if (byAuthority.size !== AUTHORITIES.length) return false;
  return AUTHORITIES.every((authority) => {
    const receipt = byAuthority.get(authority);
    return (
      receipt?.generation === expected.daemonGeneration &&
      receipt?.status === "fulfilled" &&
      receipt?.session === expected.sessionName &&
      Number.isSafeInteger(receipt?.revision) &&
      receipt.revision >= 0 &&
      (focused
        ? receipt.granted === true && receipt.clientId === expected.clientId
        : receipt?.owners?.[authority] === null)
    );
  });
}

function recordIdentity(record, expected, owners, presence) {
  return (
    record.processId === expected.processId &&
    record.clockId === expected.clockId &&
    record.daemonInstanceId === expected.daemonGeneration &&
    record.workspaceName === expected.workspaceName &&
    record.clientGeneration === expected.clientGeneration &&
    record.clientPhase === "live" &&
    record.authorityGeneration === expected.daemonGeneration &&
    Number.isSafeInteger(record.authorityRevision) &&
    record.authorityRevision >= 0 &&
    record.rendererEpoch === expected.rendererEpoch &&
    exactOwners(record.authorityOwners, owners) &&
    record.opentuiPresence?.clientId === expected.clientId &&
    record.opentuiPresence?.state === presence &&
    Number.isSafeInteger(record.opentuiPresence?.connectedRevision) &&
    Number.isSafeInteger(record.opentuiPresence?.activityRevision) &&
    safeMicros(record.monotonicMicros) !== null
  );
}

function settledIdentity(record, expected, owners, presence) {
  return (
    record?.clientGeneration === expected.clientGeneration &&
    record?.clientPhase === "live" &&
    record?.authorityGeneration === expected.daemonGeneration &&
    record?.daemonInstanceId === expected.daemonGeneration &&
    record?.workspaceName === expected.workspaceName &&
    exactOwners(record?.authorityOwners, owners) &&
    record?.opentuiPresence?.clientId === expected.clientId &&
    (presence === null || record?.opentuiPresence?.state === presence) &&
    Number.isSafeInteger(record?.authorityRevision) &&
    record.authorityRevision >= 0
  );
}

function canonicalIdentity(record, expected) {
  return (
    record.processId === expected.processId &&
    record.clockId === expected.clockId &&
    record.clockKind === "performance-now" &&
    record.semanticPaneId === expected.semanticPaneId &&
    record.generation === expected.canonicalGeneration &&
    record.incarnation === expected.incarnation &&
    record.revision === expected.revision &&
    record.stateHash === expected.stateHash &&
    record.cols === expected.canonicalCols &&
    record.rows === expected.canonicalRows &&
    record.sourceEpoch === expected.sourceEpoch &&
    record.rendererEpoch === expected.rendererEpoch &&
    record.viewportCols === expected.viewportCols &&
    record.viewportRows === expected.viewportRows &&
    safeMicros(record.atMicros) !== null
  );
}

function exactPhase(records, phase, epoch) {
  const matching = records.filter(
    (record) => record?.phase === `terminal-host-${phase}` && record.diagnosticEpoch === epoch,
  );
  return matching.length === 1 ? matching[0] : null;
}

function predicate(id, passed, actual) {
  return Object.freeze({ id, passed, actual });
}

export function qualifyProductFocusEvidence({
  lifecycleRecords,
  traceRecords,
  expected,
  snapshots,
  inputs,
  stage = "complete",
}) {
  const predicates = [];
  const add = (id, passed, actual) => {
    if (predicates.length < MAX_PREDICATES) predicates.push(predicate(id, passed, actual));
    return passed;
  };
  const expectedValid =
    expected &&
    boundedString(expected.processId) &&
    boundedString(expected.clockId) &&
    boundedString(expected.daemonGeneration) &&
    boundedString(expected.workspaceName) &&
    boundedString(expected.sessionName) &&
    boundedString(expected.clientId) &&
    boundedString(expected.semanticPaneId) &&
    boundedString(expected.hostPaneId) &&
    boundedString(expected.hostSessionId) &&
    boundedString(expected.canonicalGeneration) &&
    boundedString(expected.incarnation) &&
    boundedString(expected.stateHash) &&
    Number.isSafeInteger(expected.clientGeneration) &&
    expected.clientGeneration >= 0 &&
    Number.isSafeInteger(expected.revision) &&
    expected.revision >= 0 &&
    [
      expected.canonicalCols,
      expected.canonicalRows,
      expected.viewportCols,
      expected.viewportRows,
    ].every((value) => Number.isSafeInteger(value) && value > 0) &&
    Number.isSafeInteger(expected.rendererEpoch) &&
    expected.rendererEpoch >= 0 &&
    Number.isSafeInteger(expected.sourceEpoch) &&
    expected.sourceEpoch >= 0 &&
    Number.isSafeInteger(expected.hostCols) &&
    expected.hostCols > 0 &&
    Number.isSafeInteger(expected.hostRows) &&
    expected.hostRows > 0 &&
    Number.isSafeInteger(expected.baselineAuthorityRevision) &&
    expected.baselineAuthorityRevision >= 0 &&
    Number.isSafeInteger(expected.blurAuthorityRevision) &&
    expected.blurAuthorityRevision > expected.baselineAuthorityRevision &&
    (stage === "blur" ||
      (Number.isSafeInteger(expected.focusAuthorityRevision) &&
        expected.focusAuthorityRevision > expected.blurAuthorityRevision));
  add("expected-identity", Boolean(expectedValid), expectedValid ? "exact" : "malformed");
  if (!expectedValid)
    return Object.freeze({
      qualified: null,
      firstFailedPredicate: "expected-identity",
      predicates,
    });

  const blurOnly = stage === "blur";
  if (!blurOnly && stage !== "complete")
    return Object.freeze({
      qualified: null,
      firstFailedPredicate: "focus-stage",
      predicates: Object.freeze([predicate("focus-stage", false, "malformed")]),
    });
  const exactInput = (input) =>
    input?.kind === "focus" &&
    boundedString(input?.target) !== null &&
    input?.paneId === input.target &&
    boundedString(input?.sessionId) !== null &&
    input?.delivery === "exact-bytes-to-immutable-host-pane-pty" &&
    input?.bytesInjected === 3 &&
    input?.phases === 1 &&
    input?.target === expected.hostPaneId &&
    input?.sessionId === expected.hostSessionId &&
    input?.geometry?.cols === expected.hostCols &&
    input?.geometry?.rows === expected.hostRows &&
    Number.isSafeInteger(input?.geometry?.cols) &&
    Number.isSafeInteger(input?.geometry?.rows);
  add(
    "focus-input-receipts",
    exactInput(inputs?.blur) &&
      inputs.blur.requestedState === "blur" &&
      (blurOnly ||
        (exactInput(inputs?.focus) &&
          inputs.focus.requestedState === "focus" &&
          inputs.blur.target === inputs.focus.target &&
          inputs.blur.sessionId === inputs.focus.sessionId)),
    [inputs?.blur?.bytesInjected ?? null, inputs?.focus?.bytesInjected ?? null],
  );

  const phases = [
    ["renderer-blur-event", 1],
    ["blur-presence", 1],
    ["blur-authority-settled", 1],
    ...(blurOnly
      ? []
      : [
          ["renderer-focus-event", 2],
          ["focus-presence", 2],
          ["focus-activity", 2],
          ["focus-authority-settled", 2],
        ]),
  ];
  const relevantLifecycle = lifecycleRecords.filter(
    (record) =>
      typeof record?.phase === "string" &&
      (record.phase === "terminal-host-focus-fence" ||
        phases.some(([phase]) => record.phase === `terminal-host-${phase}`) ||
        /^terminal-host-(?:renderer-(?:blur|focus)-event|blur-|focus-)/u.test(record.phase)),
  );
  add(
    "focus-lifecycle-record-set",
    relevantLifecycle.length === (blurOnly ? 4 : 9),
    relevantLifecycle.length,
  );
  const selected = phases.map(([phase, epoch]) => exactPhase(lifecycleRecords, phase, epoch));
  add("focus-phase-cardinality", selected.every(Boolean), selected.map(Boolean));
  const ordered =
    selected.every(Boolean) &&
    selected.every((record, index) => {
      if (index === 0) return true;
      const previous = selected[index - 1];
      return (
        lifecycleRecords.indexOf(record) > lifecycleRecords.indexOf(previous) &&
        record.monotonicMicros >= previous.monotonicMicros
      );
    });
  add(
    "focus-phase-order",
    ordered,
    selected.map((record) => record?.monotonicMicros ?? null),
  );
  const owned = { input: expected.clientId, focus: expected.clientId, geometry: expected.clientId };
  const released = { input: null, focus: null, geometry: null };
  const initiationIdentity = selected.every((record) =>
    recordIdentity(
      record ?? {},
      expected,
      record?.diagnosticEpoch === 1 ? owned : released,
      record?.diagnosticEpoch === 1 ? "foreground" : "background",
    ),
  );
  const settlementIdentity =
    selected[2]?.bindingCurrent === true &&
    settledIdentity(selected[2]?.settledIdentity, expected, released, null) &&
    (blurOnly ||
      (selected[6]?.bindingCurrent === true &&
        settledIdentity(selected[6]?.settledIdentity, expected, owned, null)));
  add("focus-phase-identity", initiationIdentity && settlementIdentity, selected.length);
  add(
    "blur-state",
    selected[0]?.state === "background" && selected[1]?.state === "background",
    selected[1]?.state ?? null,
  );
  add(
    "blur-receipts",
    selected[2]?.status === "fulfilled" && exactReceipts(selected[2]?.receipts, expected, false),
    selected[2]?.status ?? null,
  );
  if (!blurOnly) {
    add(
      "focus-state",
      selected[3]?.state === "foreground" &&
        selected[4]?.state === "foreground" &&
        selected[5]?.activity === "focus",
      selected[5]?.activity ?? null,
    );
    add(
      "focus-receipts",
      selected[6]?.status === "fulfilled" && exactReceipts(selected[6]?.receipts, expected, true),
      selected[6]?.status ?? null,
    );
  }
  const releaseRevisions = selected[2]?.receipts?.map((receipt) => receipt?.revision) ?? [];
  const claimRevisions = selected[6]?.receipts?.map((receipt) => receipt?.revision) ?? [];
  const revisionChain =
    releaseRevisions.length === AUTHORITIES.length &&
    releaseRevisions.every(
      (revision, index) =>
        Number.isSafeInteger(revision) &&
        revision > expected.baselineAuthorityRevision &&
        revision <= expected.blurAuthorityRevision &&
        (index === 0 || revision >= releaseRevisions[index - 1]),
    ) &&
    selected[2]?.settledIdentity?.authorityRevision <= expected.blurAuthorityRevision &&
    (blurOnly ||
      (selected[3]?.authorityRevision >= expected.blurAuthorityRevision &&
        claimRevisions.length === AUTHORITIES.length &&
        new Set(claimRevisions).size === AUTHORITIES.length &&
        claimRevisions.every(
          (revision) =>
            Number.isSafeInteger(revision) &&
            revision > selected[3].authorityRevision &&
            revision <= expected.focusAuthorityRevision,
        ) &&
        selected[6]?.settledIdentity?.authorityRevision <= expected.focusAuthorityRevision));
  add("focus-authority-revision-chain", Boolean(revisionChain), [
    expected.baselineAuthorityRevision,
    expected.blurAuthorityRevision,
    blurOnly ? null : expected.focusAuthorityRevision,
  ]);
  const lifecycleFences = lifecycleRecords.filter(
    (record) => record?.phase === "terminal-host-focus-fence",
  );
  const lifecycleFenceHealth = lifecycleFences.slice(0, 2).map((record) => ({
    diagnosticEpoch: Number.isSafeInteger(record?.diagnosticEpoch) ? record.diagnosticEpoch : null,
    failed: typeof record?.writerHealth?.failed === "boolean" ? record.writerHealth.failed : null,
    droppedRecords: Number.isSafeInteger(record?.writerHealth?.droppedRecords)
      ? record.writerHealth.droppedRecords
      : null,
    pendingCriticalRecords: Number.isSafeInteger(record?.writerHealth?.pendingCriticalRecords)
      ? record.writerHealth.pendingCriticalRecords
      : null,
  }));
  const fenceExact = (blurOnly ? [1] : [1, 2]).every((epoch) => {
    const matches = lifecycleFences.filter((record) => record.diagnosticEpoch === epoch);
    const health = matches[0]?.writerHealth;
    const settlement = epoch === 1 ? selected[2] : selected[6];
    return (
      settlement &&
      matches.length === 1 &&
      matches[0].rendererEpoch === expected.rendererEpoch &&
      matches[0].processId === expected.processId &&
      matches[0].clockId === expected.clockId &&
      matches[0].daemonGeneration === expected.daemonGeneration &&
      matches[0].workspaceName === expected.workspaceName &&
      matches[0].clientGeneration === expected.clientGeneration &&
      safeMicros(matches[0].monotonicMicros) !== null &&
      lifecycleRecords.indexOf(matches[0]) > lifecycleRecords.indexOf(settlement) &&
      matches[0].monotonicMicros >= settlement.monotonicMicros &&
      health?.failed === false &&
      health?.droppedRecords === 0 &&
      health?.pendingCriticalRecords === 0
    );
  });
  add("focus-lifecycle-fences", fenceExact, {
    count: lifecycleFences.length,
    health: lifecycleFenceHealth,
  });

  const paints = traceRecords.filter(
    (record) => record?.type === "performance.terminal-focus-paint",
  );
  const focusTraceRecords = traceRecords.filter(
    (record) =>
      record?.type === "performance.terminal-focus-paint" ||
      record?.type === "performance.terminal-focus-fence",
  );
  add(
    "focus-trace-record-set",
    focusTraceRecords.length === (blurOnly ? 2 : 4),
    focusTraceRecords.length,
  );
  const blurPaints = paints.filter(
    (record) =>
      record.diagnosticEpoch === 1 &&
      record.focused === false &&
      canonicalIdentity(record, expected),
  );
  const focusPaints = paints.filter(
    (record) =>
      record.diagnosticEpoch === 2 &&
      record.focused === true &&
      canonicalIdentity(record, expected),
  );
  add(
    "focus-paint-cardinality",
    blurPaints.length === 1 && (blurOnly || focusPaints.length === 1),
    [blurPaints.length, focusPaints.length],
  );
  const paintOrder =
    blurPaints[0]?.atMicros >= selected[0]?.monotonicMicros &&
    (blurOnly ||
      (blurPaints[0]?.atMicros <= selected[3]?.monotonicMicros &&
        focusPaints[0]?.atMicros >= selected[3]?.monotonicMicros));
  add("focus-paint-causal-order", Boolean(paintOrder), [
    blurPaints[0]?.atMicros ?? null,
    focusPaints[0]?.atMicros ?? null,
  ]);
  const cursorRow = snapshots?.before?.cursorRow;
  const allowedRows = Number.isSafeInteger(cursorRow) && cursorRow >= 0 ? [cursorRow] : [];
  const paintRowsExact = [...blurPaints, ...(blurOnly ? [] : focusPaints)].every(
    (paint) =>
      paint.full === false &&
      Array.isArray(paint.writtenRows) &&
      paint.writtenRows.length === allowedRows.length &&
      paint.writtenRows.every((row, index) => row === allowedRows[index]),
  );
  add(
    "focus-paint-rows",
    paintRowsExact,
    [...blurPaints, ...(blurOnly ? [] : focusPaints)].map((paint) => paint.writtenRows),
  );
  const paintFences = traceRecords.filter(
    (record) => record?.type === "performance.terminal-focus-fence",
  );
  const exactPaintFences = paintFences.filter(
    (record) =>
      (blurOnly ? record.diagnosticEpoch === 1 : [1, 2].includes(record.diagnosticEpoch)) &&
      canonicalIdentity(record, expected),
  );
  const paintFenceHealthy =
    exactPaintFences.length === (blurOnly ? 1 : 2) &&
    exactPaintFences.some((record) => record.focused === false) &&
    (blurOnly || exactPaintFences.some((record) => record.focused === true)) &&
    exactPaintFences.every((record) => {
      const health = record.writerHealth;
      return (
        health?.failed === false && health.droppedRecords === 0 && health.oversizedRecords === 0
      );
    }) &&
    (blurOnly ? [1] : [1, 2]).every((epoch) => {
      const paint = epoch === 1 ? blurPaints[0] : focusPaints[0];
      const fence = exactPaintFences.find((record) => record.diagnosticEpoch === epoch);
      return (
        paint &&
        fence &&
        traceRecords.indexOf(fence) > traceRecords.indexOf(paint) &&
        fence.atMicros >= paint.atMicros
      );
    }) &&
    (blurOnly ||
      traceRecords.indexOf(focusPaints[0]) >
        traceRecords.indexOf(exactPaintFences.find((record) => record.diagnosticEpoch === 1)));
  add("focus-paint-fences", paintFenceHealthy, exactPaintFences.length);
  const bodyStable =
    snapshots?.before?.nativeBodyHash === snapshots?.blur?.nativeBodyHash &&
    (blurOnly || snapshots?.before?.nativeBodyHash === snapshots?.focus?.nativeBodyHash) &&
    snapshots?.before?.renderedBodyWithoutCursorHash ===
      snapshots?.blur?.renderedBodyWithoutCursorHash &&
    (blurOnly ||
      snapshots?.before?.renderedBodyWithoutCursorHash ===
        snapshots?.focus?.renderedBodyWithoutCursorHash) &&
    snapshots?.before?.cursorTextRowHash === snapshots?.blur?.cursorTextRowHash &&
    (blurOnly || snapshots?.before?.cursorTextRowHash === snapshots?.focus?.cursorTextRowHash) &&
    snapshots?.before?.cursorPresentationRowHash !== snapshots?.blur?.cursorPresentationRowHash &&
    (blurOnly ||
      snapshots?.before?.cursorPresentationRowHash ===
        snapshots?.focus?.cursorPresentationRowHash) &&
    snapshots?.before?.geometryHash === snapshots?.blur?.geometryHash &&
    (blurOnly || snapshots?.before?.geometryHash === snapshots?.focus?.geometryHash) &&
    snapshots?.before?.canonicalGeometryHash === snapshots?.blur?.canonicalGeometryHash &&
    (blurOnly ||
      snapshots?.before?.canonicalGeometryHash === snapshots?.focus?.canonicalGeometryHash);
  add("focus-body-stable", Boolean(bodyStable), bodyStable ? "stable" : "changed");
  const canonicalProgress = traceRecords.filter(
    (record) =>
      (record?.type === "performance.terminal-canonical-update" ||
        record?.type === "performance.terminal-canonical-publication") &&
      record.semanticPaneId === expected.semanticPaneId &&
      safeMicros(record.atMicros) !== null &&
      selected[0] &&
      record.atMicros >= selected[0].monotonicMicros,
  );
  const noCanonicalProgress = canonicalProgress.length === 0;
  add("focus-canonical-stable", noCanonicalProgress, {
    count: canonicalProgress.length,
    updates: canonicalProgress.filter(
      (record) => record.type === "performance.terminal-canonical-update",
    ).length,
    publications: canonicalProgress.filter(
      (record) => record.type === "performance.terminal-canonical-publication",
    ).length,
  });

  const failed = predicates.find(({ passed }) => !passed)?.id ?? null;
  return Object.freeze({
    qualified: failed
      ? null
      : Object.freeze({
          blurEpoch: 1,
          focusEpoch: 2,
          semanticPaneId: expected.semanticPaneId,
          revision: expected.revision,
          stateHash: expected.stateHash,
          cursorRow,
          blurAtMicros: selected[0].monotonicMicros,
          focusSettledAtMicros: blurOnly ? null : selected[6].monotonicMicros,
        }),
    firstFailedPredicate: failed,
    predicates: Object.freeze(predicates),
  });
}

export function assessFocusJourneyBoundaries({ timeline, evidence, correlationComplete }) {
  const ids = timeline.map((entry) => entry?.phase).filter((entry) => typeof entry === "string");
  const expected = [
    "focus-namespace-ready",
    "focus-daemon-ready",
    "focus-tui-build",
    "focus-tui-started",
    "focus-host-ready",
    "focus-tui-coherent",
    "focus-blur-proved",
    "focus-reclaim-proved",
    "focus-web-correlation",
  ];
  const boundaries = [];
  let cursor = -1;
  let failed = null;
  for (const id of expected) {
    const matches = ids
      .map((value, index) => (value === id ? index : -1))
      .filter((index) => index >= 0);
    const passed = matches.length === 1 && matches[0] > cursor;
    boundaries.push(Object.freeze({ id, status: passed ? "passed" : "failed" }));
    if (!passed && failed === null) failed = id;
    if (passed) cursor = matches[0];
  }
  if (!evidence?.qualified && failed === null) failed = "focus-causal-proof";
  boundaries.push(
    Object.freeze({ id: "focus-causal-proof", status: evidence?.qualified ? "passed" : "failed" }),
  );
  if (!correlationComplete && failed === null) failed = "diagnostic-correlation";
  boundaries.push(
    Object.freeze({
      id: "diagnostic-correlation",
      status: correlationComplete ? "passed" : "failed",
    }),
  );
  return Object.freeze({
    status: failed === null ? "passed" : "failed",
    firstBrokenBoundary: failed,
    firstUnmeasuredBoundary: null,
    boundaries: Object.freeze(boundaries),
  });
}

function boundedWorkspaceIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function exactFocusResourceProjection(committedResources, derivedResources) {
  if (
    !Array.isArray(committedResources) ||
    committedResources.length < 1 ||
    committedResources.length > 512 ||
    !Array.isArray(derivedResources) ||
    derivedResources.length < 1 ||
    derivedResources.length > 512
  )
    return null;
  const normalize = (resources, kind) => {
    const resourceIds = new Set();
    const paneIds = new Set();
    const tuples = [];
    for (const resource of resources) {
      const resourceId = kind === "committed" ? resource?.resourceId : resource?.id;
      const windowResourceId = resource?.windowResourceId ?? resourceId;
      const semanticPaneId =
        kind === "committed"
          ? (resource?.semanticPaneId ?? null)
          : resource?.attachability?.status === "available"
            ? resource.attachability.semanticPaneId
            : resource?.attachability?.status === "unavailable"
              ? null
              : undefined;
      if (
        !boundedWorkspaceIdentity(resourceId) ||
        !boundedWorkspaceIdentity(windowResourceId) ||
        typeof resource?.active !== "boolean" ||
        (semanticPaneId !== null && !boundedWorkspaceIdentity(semanticPaneId)) ||
        resourceIds.has(resourceId) ||
        (semanticPaneId !== null && paneIds.has(semanticPaneId))
      )
        return null;
      resourceIds.add(resourceId);
      if (semanticPaneId !== null) paneIds.add(semanticPaneId);
      tuples.push([resourceId, windowResourceId, resource.active, semanticPaneId]);
    }
    return tuples.sort(([left], [right]) => left.localeCompare(right));
  };
  const committed = normalize(committedResources, "committed");
  const derived = normalize(derivedResources, "derived");
  if (!committed || !derived) return null;
  return Object.freeze({
    committed,
    derived,
    exact: JSON.stringify(committed) === JSON.stringify(derived),
  });
}

export function qualifyFocusWorkspaceState(records, expected) {
  const boundary = [
    "focus-baseline",
    "focus-blur-proved",
    "focus-reclaim-proved",
    "focus-web-correlation",
  ].includes(expected.boundary)
    ? expected.boundary
    : null;
  const matches = records.filter(
    (record) =>
      record?.phase === "generation-workspace-client-state" &&
      record.processId === expected.processId &&
      record.daemonGeneration === expected.daemonGeneration &&
      safeMicros(record.monotonicMicros) !== null &&
      record.monotonicMicros >= expected.afterMicros,
  );
  const record = matches.at(-1);
  const committed = record?.workspaceClient?.committed;
  const pending = record?.workspaceClient?.pending;
  const derived = record?.workspaceClient?.derived;
  const authority = committed?.authority;
  const authorityClients = Array.isArray(authority?.clients) ? authority.clients : [];
  const clients = authority?.clients?.filter((client) => client.clientId === expected.clientId);
  const webClients = authority?.clients?.filter((client) => client?.surface === "web") ?? [];
  const resources = exactFocusResourceProjection(
    committed?.terminalResources,
    derived?.terminalInventory?.resources,
  );
  const activeDerived = Array.isArray(derived?.terminalInventory?.resources)
    ? derived.terminalInventory.resources.filter((resource) => resource?.active === true)
    : [];
  const activeResource = activeDerived[0];
  const workspaceExact =
    boundedWorkspaceIdentity(committed?.authorityWorkspaceId) &&
    committed.authorityWorkspaceId === derived?.workspace?.id &&
    boundedWorkspaceIdentity(committed?.authorityWorkspaceName) &&
    committed.authorityWorkspaceName === derived?.workspace?.name;
  const activeResourceExact =
    activeDerived.length === 1 &&
    activeResource?.attachability?.status === "available" &&
    activeResource.attachability.semanticPaneId === expected.semanticPaneId &&
    derived?.terminalInventory?.activeResourceId === activeResource.id;
  const postWebClientExact =
    boundary !== "focus-web-correlation" ||
    (authorityClients.length === 2 &&
      clients?.length === 1 &&
      webClients.length === 1 &&
      boundedWorkspaceIdentity(webClients[0]?.clientId) &&
      webClients[0].clientId !== expected.clientId &&
      webClients[0].state === "foreground" &&
      Number.isSafeInteger(webClients[0].connectedRevision) &&
      webClients[0].connectedRevision >= 0 &&
      Number.isSafeInteger(webClients[0].activityRevision) &&
      webClients[0].activityRevision >= webClients[0].connectedRevision);
  const passed =
    boundary !== null &&
    matches.length > 0 &&
    committed?.generation === expected.clientGeneration &&
    committed?.phase === "live" &&
    committed?.target?.daemon?.instanceId === expected.daemonGeneration &&
    committed?.target?.workspaceName === expected.workspaceName &&
    authority?.generation === expected.daemonGeneration &&
    authority?.session === expected.sessionName &&
    exactOwners(authority?.owners, expected.owners) &&
    clients?.length === 1 &&
    clients[0].surface === "opentui" &&
    clients[0].state === expected.presence &&
    Number.isSafeInteger(authority.revision) &&
    authority.revision >= 0 &&
    Array.isArray(pending) &&
    pending.length === 0 &&
    workspaceExact &&
    resources?.exact === true &&
    activeResourceExact &&
    postWebClientExact;
  if (passed) return Object.freeze({ record, committed, pending, derived });
  const error = new Error("exact focus WorkspaceClient authority state is unavailable");
  error.boundary = boundary ?? "focus-baseline";
  error.observation = Object.freeze({
    operation: "qualify-focus-workspace-client",
    expectedPresence: expected.presence,
    boundaryExact: boundary !== null,
    matchingRecords: matches.length,
    ownersMatched: exactOwners(authority?.owners, expected.owners),
    pendingExact: Array.isArray(pending) && pending.length === 0,
    workspaceExact,
    committedResourceCount: Array.isArray(committed?.terminalResources)
      ? Math.min(committed.terminalResources.length, 513)
      : null,
    derivedResourceCount: Array.isArray(derived?.terminalInventory?.resources)
      ? Math.min(derived.terminalInventory.resources.length, 513)
      : null,
    resourceSetsExact: resources?.exact === true,
    clientGenerationExact: committed?.generation === expected.clientGeneration,
    activeResourceExact,
    postWebClientExact,
    webClientCount: Math.min(webClients.length, 2),
    authorityClientCount: Math.min(authorityClients.length, 3),
  });
  throw error;
}
