import { createHmac } from "node:crypto";

const CANONICAL_STATE_HASH = /^[0-9a-f]{16}$/u;
const HMAC = /^[0-9a-f]{64}$/u;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CLIENTS = new Set(["opentui", "web-a", "web-b"]);
const HOSTS = new Set(["opentui", "chromium", "electron"]);
const CLOCK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u;

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function exactAuthorityOwners(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).sort().join("\0") === "focus\0geometry\0input" &&
    [value.input, value.focus, value.geometry].every(
      (owner) => owner === null || (typeof owner === "string" && owner.length > 0),
    )
  );
}

function boundedInteger(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : null;
}

export function createCard5DiagnosticEvidenceBinding({
  journeyEvidence,
  journeyEvidenceKey,
  privateEvidenceKey,
}) {
  if (
    !["crossClientHandoff", "daemonRestart"].includes(journeyEvidenceKey) ||
    !HMAC.test(privateEvidenceKey ?? "") ||
    journeyEvidence === null ||
    typeof journeyEvidence !== "object" ||
    !Object.hasOwn(journeyEvidence, journeyEvidenceKey)
  )
    throw new Error("Card5 diagnostic evidence binding was invalid");
  const evidence = journeyEvidence[journeyEvidenceKey];
  return Object.freeze({
    evidence,
    correlate: (project) => project(evidence, privateEvidenceKey),
    assess: (project) => project(evidence, privateEvidenceKey),
  });
}

const TUI_FENCE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function validTuiFrameFence(record) {
  return (
    record?.type === "performance.terminal-frame-fence" &&
    TUI_FENCE_TEXT.test(record.generation ?? "") &&
    TUI_FENCE_TEXT.test(record.semanticPaneId ?? "") &&
    TUI_FENCE_TEXT.test(record.incarnation ?? "") &&
    TUI_FENCE_TEXT.test(record.processId ?? "") &&
    CLOCK_ID.test(record.clockId ?? "") &&
    CANONICAL_STATE_HASH.test(record.stateHash ?? "") &&
    Number.isSafeInteger(record.atMicros) &&
    record.atMicros >= 0 &&
    Number.isSafeInteger(record.revision) &&
    record.revision >= 0 &&
    record.acceptedRevision === record.revision &&
    Number.isSafeInteger(record.cols) &&
    record.cols > 0 &&
    record.cols <= 65_535 &&
    Number.isSafeInteger(record.rows) &&
    record.rows > 0 &&
    record.rows <= 65_535
  );
}

/** Fail-closed, per-pane projection of accepted OpenTUI host frame fences. */
export function createCard5TuiFrameFenceTracker() {
  const byPane = new Map();
  let valid = true;
  return Object.freeze({
    ingest(record) {
      if (!validTuiFrameFence(record)) {
        valid = false;
        byPane.clear();
        return false;
      }
      const previous = byPane.get(record.semanticPaneId);
      if (
        previous &&
        previous.generation === record.generation &&
        previous.incarnation === record.incarnation &&
        (record.revision <= previous.revision || record.atMicros <= previous.atMicros)
      ) {
        valid = false;
        byPane.clear();
        return false;
      }
      byPane.set(
        record.semanticPaneId,
        Object.freeze({
          generation: record.generation,
          revision: record.revision,
          canonicalStateHash: record.stateHash,
          connected: true,
          processId: record.processId,
          clockId: record.clockId,
          atMicros: record.atMicros,
          semanticPaneId: record.semanticPaneId,
          incarnation: record.incarnation,
          cols: record.cols,
          rows: record.rows,
          deliveryFence: record.acceptedRevision,
        }),
      );
      return true;
    },
    latest(semanticPaneId) {
      return valid && TUI_FENCE_TEXT.test(semanticPaneId ?? "")
        ? (byPane.get(semanticPaneId) ?? null)
        : null;
    },
    valid: () => valid,
  });
}

function card5CandidateSummary(observations) {
  return Object.freeze({
    clients: Object.freeze(
      observations.map((entry) =>
        Object.freeze({
          client: entry.client,
          correlationHmac: HMAC.test(entry.correlationHmac ?? "") ? entry.correlationHmac : null,
          workspaceHmac: HMAC.test(entry.workspaceHmac ?? "") ? entry.workspaceHmac : null,
          paneHmac: HMAC.test(entry.paneHmac ?? "") ? entry.paneHmac : null,
          incarnationHmac: HMAC.test(entry.incarnationHmac ?? "") ? entry.incarnationHmac : null,
          renditionHmac: HMAC.test(entry.renditionHmac ?? "") ? entry.renditionHmac : null,
          revision: boundedInteger(entry.revision, 0xffff_ffff),
          cols: boundedInteger(entry.cols, 65_535),
          rows: boundedInteger(entry.rows, 65_535),
          deliveryFence: boundedInteger(entry.deliveryFence, 0xffff_ffff),
        }),
      ),
    ),
  });
}

/** Bound one potentially wedged browser observation to the shared deadline. */
export async function observeCard5WithinDeadline(
  observe,
  {
    deadline,
    now = () => performance.now(),
    scheduleDeadline = (callback, delayMs) => setTimeout(callback, delayMs),
    cancelDeadline = (timer) => clearTimeout(timer),
  },
) {
  if (typeof observe !== "function" || !Number.isFinite(deadline)) {
    throw new TypeError("Card5 observation deadline is malformed");
  }
  let before;
  try {
    before = now();
  } catch {
    return Object.freeze({ status: "clock-invalid", value: null });
  }
  if (!Number.isFinite(before)) return Object.freeze({ status: "clock-invalid", value: null });
  const remaining = deadline - before;
  if (remaining <= 0) return Object.freeze({ status: "deadline", value: null });
  const controller = new AbortController();
  const operation = Promise.resolve().then(() =>
    observe(Object.freeze({ signal: controller.signal, deadline })),
  );
  const settled = operation.then(
    (value) => ({ status: "ok", value }),
    () => ({ status: "source-unavailable", value: null }),
  );
  let timer;
  const timeout = new Promise((resolveTimeout) => {
    timer = scheduleDeadline(() => {
      controller.abort("card5-convergence-deadline");
      resolveTimeout({ status: "deadline", value: null });
    }, remaining);
  });
  const result = await Promise.race([settled, timeout]);
  cancelDeadline(timer);
  if (result.status === "deadline") void settled;
  let after;
  try {
    after = now();
  } catch {
    return Object.freeze({ status: "clock-invalid", value: null });
  }
  if (!Number.isFinite(after) || after < before)
    return Object.freeze({ status: "clock-invalid", value: null });
  return after >= deadline
    ? Object.freeze({ status: "deadline", value: null })
    : Object.freeze(result);
}

/** Resolve one exact raw pane identity only when both qualified Web hosts agree. */
export function exactSharedCard5WebPane(observations) {
  if (!Array.isArray(observations) || observations.length !== 2) return null;
  const [webA, webB] = observations;
  const pane = webA?.semanticPaneId;
  return typeof pane === "string" && pane.length > 0 && pane.length <= 256
    ? pane === webB?.semanticPaneId
      ? pane
      : null
    : null;
}

/** Keep every later phase on the pane accepted by the initial convergence. */
export function matchesExpectedCard5WebPane(observations, expectedPane) {
  return (
    typeof expectedPane === "string" &&
    expectedPane.length > 0 &&
    expectedPane.length <= 256 &&
    exactSharedCard5WebPane(observations) === expectedPane
  );
}

/** Select one native geometry row by semantic identity, never by row order. */
export function selectExactCard5PaneGeometry(rows, expectedPane) {
  if (!Array.isArray(rows) || typeof expectedPane !== "string" || expectedPane.length < 1) {
    return null;
  }
  const matching = rows.filter((row) => row?.semanticPaneId === expectedPane);
  return matching.length === 1 ? matching[0] : null;
}

/** Resolve one semantic pane to an immutable private-socket tmux target. */
export function selectExactCard5TmuxPaneBinding(rows, expectedPane, expectedSession) {
  if (
    !Array.isArray(rows) ||
    typeof expectedPane !== "string" ||
    expectedPane.length < 1 ||
    expectedPane.length > 256 ||
    typeof expectedSession !== "string" ||
    expectedSession.length < 1 ||
    expectedSession.length > 128
  )
    return null;
  const matching = rows.filter(
    (row) => row?.semanticPaneId === expectedPane && row?.sessionName === expectedSession,
  );
  if (matching.length !== 1) return null;
  const row = matching[0];
  if (
    !/^%[0-9]+$/u.test(row.paneId ?? "") ||
    !/^\$[0-9]+$/u.test(row.sessionId ?? "") ||
    !Number.isSafeInteger(row.paneCreated) ||
    row.paneCreated < 0 ||
    ![row.left, row.top, row.width, row.height].every(Number.isSafeInteger) ||
    row.left < 0 ||
    row.top < 0 ||
    row.width < 1 ||
    row.height < 1 ||
    row.windowActive !== true
  )
    return null;
  return Object.freeze({
    paneId: row.paneId,
    semanticPaneId: row.semanticPaneId,
    sessionName: row.sessionName,
    sessionId: row.sessionId,
    paneCreated: row.paneCreated,
    left: row.left,
    top: row.top,
    width: row.width,
    height: row.height,
  });
}

export function sameExactCard5TmuxPaneBinding(left, right) {
  return (
    left !== null &&
    right !== null &&
    Object.keys(left).sort().join("\0") ===
      [
        "paneId",
        "semanticPaneId",
        "sessionName",
        "sessionId",
        "paneCreated",
        "left",
        "top",
        "width",
        "height",
      ]
        .sort()
        .join("\0") &&
    Object.keys(right).sort().join("\0") === Object.keys(left).sort().join("\0") &&
    Object.entries(left).every(([key, value]) => right[key] === value)
  );
}

export function card5TmuxCapturePaneArgv(binding) {
  if (!/^%[0-9]+$/u.test(binding?.paneId ?? "")) return null;
  return Object.freeze(["capture-pane", "-p", "-J", "-t", binding.paneId]);
}

export function runExactCard5TmuxPaneCapture({ latchedBinding, observeBinding, capture }) {
  if (typeof observeBinding !== "function" || typeof capture !== "function")
    return Object.freeze({ status: "topology-changed", value: null });
  const before = observeBinding();
  if (!sameExactCard5TmuxPaneBinding(latchedBinding, before))
    return Object.freeze({ status: "topology-changed", value: null });
  const argv = card5TmuxCapturePaneArgv(before);
  if (argv === null) return Object.freeze({ status: "topology-changed", value: null });
  let value = null;
  let captureError = null;
  try {
    value = capture(argv);
  } catch (error) {
    captureError = error;
  }
  const after = observeBinding();
  if (!sameExactCard5TmuxPaneBinding(latchedBinding, after))
    return Object.freeze({ status: "topology-changed", value: null });
  if (captureError !== null) throw captureError;
  return Object.freeze({ status: "ok", value });
}

/**
 * Join one outer-host paste to the exact inner semantic input/paint/fence chain.
 * Raw pane, trace, marker, and payload identities never leave this projection.
 */
export function isExactCard5TuiHostInputReceipt(hostReceipt, payload) {
  if (typeof payload !== "string") return false;
  const injected = `\x1b[200~${payload}\x1b[201~`;
  return (
    hostReceipt?.version === 1 &&
    hostReceipt.kind === "paste" &&
    hostReceipt.delivery === "exact-bytes-to-immutable-host-pane-pty" &&
    /^%\d+$/u.test(hostReceipt.paneId ?? "") &&
    hostReceipt.target === hostReceipt.paneId &&
    /^\$\d+$/u.test(hostReceipt.sessionId ?? "") &&
    hostReceipt.phases === 1 &&
    hostReceipt.transportCalls === 1 &&
    hostReceipt.physicalTransportCalls === 1 &&
    hostReceipt.bytesInjected === Buffer.byteLength(injected)
  );
}

function exactCard5TuiFocusControlReceipt(receipt, action, status) {
  return (
    exactKeys(receipt, [
      "version",
      "status",
      "action",
      "nonceHmac",
      "diagnosticEpoch",
      "state",
      "bindingHmac",
      "receiptHmac",
    ]) &&
    receipt?.version === 1 &&
    receipt.status === status &&
    receipt.action === action &&
    receipt.state === (action === "focus" ? "foreground" : "background") &&
    HMAC.test(receipt.nonceHmac ?? "") &&
    HMAC.test(receipt.bindingHmac ?? "") &&
    HMAC.test(receipt.receiptHmac ?? "") &&
    (status === "changed"
      ? Number.isSafeInteger(receipt.diagnosticEpoch) && receipt.diagnosticEpoch >= 1
      : receipt.diagnosticEpoch === null)
  );
}

/**
 * Qualify one explicit OpenTUI blur -> focus epoch after a passive authority
 * loss. The outer PTY receipts and inner renderer lifecycle are separate
 * identity domains and are joined only by the immutable host target and the
 * exact post-baseline transition cardinality.
 */
export function assessCard5TuiFocusTransition({
  records,
  priorBlurRecords = [],
  receipts,
  expectedCanonical,
  expectedBindingHmac,
  expectedWorkspaceName,
  expectedRendererEpoch,
  expectedClientGeneration,
  expectedRuntimeSession,
  expectedAuthorityOwners,
  expectedTuiClientId,
  minimumBlurAuthorityRevision,
  minimumFocusAuthorityRevision,
  baselineClaimOrdinal,
  evidenceKey,
  stage = "complete",
}) {
  const fail = (reason) => Object.freeze({ passed: false, reason, evidence: null });
  if (
    !Array.isArray(records) ||
    !["blur", "focus", "complete"].includes(stage) ||
    !Number.isSafeInteger(baselineClaimOrdinal) ||
    baselineClaimOrdinal < 0 ||
    !/^opentui:[1-9]\d*$/u.test(expectedCanonical?.processId ?? "") ||
    expectedCanonical?.clockId !== "opentui-performance-now" ||
    !GENERATION.test(expectedCanonical?.generation ?? "") ||
    !Array.isArray(priorBlurRecords) ||
    !HMAC.test(expectedBindingHmac ?? "") ||
    typeof expectedWorkspaceName !== "string" ||
    expectedWorkspaceName.length < 1 ||
    expectedWorkspaceName.length > 256 ||
    !Number.isSafeInteger(expectedRendererEpoch) ||
    expectedRendererEpoch < 0 ||
    !Number.isSafeInteger(expectedClientGeneration) ||
    expectedClientGeneration < 0 ||
    !GENERATION.test(expectedRuntimeSession ?? "") ||
    !exactAuthorityOwners(expectedAuthorityOwners) ||
    typeof expectedTuiClientId !== "string" ||
    expectedTuiClientId.length === 0 ||
    !Number.isSafeInteger(minimumBlurAuthorityRevision) ||
    minimumBlurAuthorityRevision < 0 ||
    !Number.isSafeInteger(minimumFocusAuthorityRevision) ||
    minimumFocusAuthorityRevision < minimumBlurAuthorityRevision ||
    !HMAC.test(evidenceKey ?? "")
  )
    return fail("focus-transition-contract-invalid");
  const receiptKeys =
    stage === "blur"
      ? ["blur"]
      : stage === "focus"
        ? ["blur", "focus"]
        : ["blur", "focus", "duplicateFocus"];
  if (!exactKeys(receipts, receiptKeys))
    return fail(stage === "blur" ? "focus-blur-receipt-invalid" : "focus-focus-receipt-invalid");
  if (
    !["changed", "no-op"].some((status) =>
      exactCard5TuiFocusControlReceipt(receipts?.blur, "blur", status),
    ) ||
    receipts.blur.bindingHmac !== expectedBindingHmac
  )
    return fail("focus-blur-receipt-invalid");
  if (stage !== "blur") {
    if (
      !exactCard5TuiFocusControlReceipt(receipts?.focus, "focus", "changed") ||
      receipts.focus.bindingHmac !== expectedBindingHmac ||
      (stage === "complete" &&
        (!exactCard5TuiFocusControlReceipt(receipts?.duplicateFocus, "focus", "no-op") ||
          receipts.duplicateFocus.bindingHmac !== expectedBindingHmac))
    )
      return fail("focus-focus-receipt-invalid");
  }
  const postLifecycle = records.filter(
    (record) => typeof record?.phase === "string" && record.phase.startsWith("terminal-host-"),
  );
  const priorLifecycle = priorBlurRecords.filter(
    (record) => typeof record?.phase === "string" && record.phase.startsWith("terminal-host-"),
  );
  const blurLifecycle = receipts.blur.status === "no-op" ? priorLifecycle : postLifecycle;
  const blurEpoch =
    receipts.blur.status === "changed"
      ? receipts.blur.diagnosticEpoch
      : blurLifecycle.findLast((record) => record.phase === "terminal-host-renderer-blur-event")
          ?.diagnosticEpoch;
  const blurEvents = blurLifecycle.filter(
    (record) =>
      record.phase === "terminal-host-renderer-blur-event" && record.diagnosticEpoch === blurEpoch,
  );
  const blurSettlements = blurLifecycle.filter(
    (record) =>
      record.phase === "terminal-host-blur-authority-settled" &&
      record.diagnosticEpoch === blurEpoch,
  );
  const blurFences = blurLifecycle.filter(
    (record) =>
      record.phase === "terminal-host-focus-fence" && record.diagnosticEpoch === blurEpoch,
  );
  const focusEpoch = receipts?.focus?.diagnosticEpoch;
  const focusEvents = postLifecycle.filter(
    (record) =>
      record.phase === "terminal-host-renderer-focus-event" &&
      record.diagnosticEpoch === focusEpoch,
  );
  const claims = postLifecycle.filter(
    (record) => record.phase === "terminal-host-focus-claim-attempt",
  );
  const focusSettlements = postLifecycle.filter(
    (record) =>
      record.phase === "terminal-host-focus-authority-settled" &&
      record.diagnosticEpoch === focusEpoch,
  );
  const focusFences = postLifecycle.filter(
    (record) =>
      record.phase === "terminal-host-focus-fence" && record.diagnosticEpoch === focusEpoch,
  );
  if (
    blurEvents.length !== 1 ||
    blurSettlements.length !== 1 ||
    blurFences.length !== 1 ||
    (receipts.blur.status === "no-op" &&
      priorLifecycle.findLast((record) =>
        ["terminal-host-renderer-blur-event", "terminal-host-renderer-focus-event"].includes(
          record.phase,
        ),
      ) !== blurEvents[0])
  )
    return fail("focus-blur-lifecycle-invalid");
  const blurEvent = blurEvents[0];
  const blurSettlement = blurSettlements[0];
  const blurFence = blurFences[0];
  const safePoint = (record) =>
    Number.isSafeInteger(record?.monotonicMicros) && record.monotonicMicros >= 0;
  const sameProcess = (record) =>
    record?.processId === expectedCanonical.processId &&
    record?.clockId === expectedCanonical.clockId &&
    record?.daemonInstanceId === expectedCanonical.generation &&
    record?.workspaceName === expectedWorkspaceName &&
    record?.rendererEpoch === expectedRendererEpoch &&
    record?.clientGeneration === expectedClientGeneration;
  const healthyFence = (record, settlement) =>
    record?.settledPhase === settlement?.phase?.slice("terminal-host-".length) &&
    record?.writerHealth?.failed === false &&
    record.writerHealth.droppedRecords === 0 &&
    record.writerHealth.pendingCriticalRecords === 0;
  const authorities = ["input", "focus", "geometry"];
  const expectedOwnersAfterBlur = Object.fromEntries(
    authorities.map((authority) => [
      authority,
      expectedAuthorityOwners[authority] === expectedTuiClientId
        ? null
        : expectedAuthorityOwners[authority],
    ]),
  );
  const blurReceipts = blurSettlement.receipts;
  const blurReceiptsExact =
    Array.isArray(blurReceipts) &&
    blurReceipts.length === authorities.length &&
    authorities.every((authority) => {
      const matching = blurReceipts.filter((receipt) => receipt?.authority === authority);
      const receipt = matching[0];
      return (
        matching.length === 1 &&
        exactKeys(receipt, [
          "authority",
          "status",
          "generation",
          "owners",
          "revision",
          "session",
        ]) &&
        receipt.status === "fulfilled" &&
        receipt.generation === expectedCanonical.generation &&
        receipt.session === expectedRuntimeSession &&
        Number.isSafeInteger(receipt.revision) &&
        receipt.revision > minimumBlurAuthorityRevision &&
        exactKeys(receipt.owners, ["input", "focus", "geometry"]) &&
        receipt.owners[authority] === expectedOwnersAfterBlur[authority] &&
        authorities.every((kind) =>
          expectedAuthorityOwners[kind] === expectedTuiClientId
            ? [expectedTuiClientId, null].includes(receipt.owners[kind])
            : receipt.owners[kind] === expectedAuthorityOwners[kind],
        )
      );
    });
  if (
    !Number.isSafeInteger(blurEvent.diagnosticEpoch) ||
    blurEvent.diagnosticEpoch < 1 ||
    blurEvent.state !== "background" ||
    blurSettlement.diagnosticEpoch !== blurEvent.diagnosticEpoch ||
    blurSettlement.status !== "fulfilled" ||
    blurSettlement.bindingCurrent !== true ||
    !blurReceiptsExact ||
    !sameProcess(blurEvent) ||
    !sameProcess(blurSettlement) ||
    !safePoint(blurEvent) ||
    !safePoint(blurSettlement) ||
    !safePoint(blurFence) ||
    blurLifecycle.indexOf(blurSettlement) <= blurLifecycle.indexOf(blurEvent) ||
    blurLifecycle.indexOf(blurFence) <= blurLifecycle.indexOf(blurSettlement) ||
    blurSettlement.monotonicMicros < blurEvent.monotonicMicros ||
    blurFence.monotonicMicros < blurSettlement.monotonicMicros ||
    !healthyFence(blurFence, blurSettlement)
  )
    return fail("focus-blur-lifecycle-invalid");
  const blurRevision = blurSettlement.settledIdentity?.authorityRevision;
  const blurReceiptRevision = Math.max(...blurReceipts.map(({ revision }) => revision));
  if (
    !exactKeys(blurSettlement.settledIdentity?.authorityOwners, authorities) ||
    !authorities.every((authority) =>
      expectedAuthorityOwners[authority] === expectedTuiClientId
        ? [expectedTuiClientId, null].includes(
            blurSettlement.settledIdentity.authorityOwners[authority],
          )
        : blurSettlement.settledIdentity.authorityOwners[authority] ===
          expectedOwnersAfterBlur[authority],
    ) ||
    !Number.isSafeInteger(blurRevision) ||
    blurRevision <= minimumBlurAuthorityRevision ||
    !Number.isSafeInteger(blurReceiptRevision) ||
    blurReceiptRevision <= minimumBlurAuthorityRevision
  )
    return fail("focus-blur-lifecycle-invalid");
  const hmac = (domain, value) =>
    createHmac("sha256", Buffer.from(evidenceKey, "hex"))
      .update(`${domain}\0${value}`)
      .digest("hex");
  if (stage === "blur")
    return Object.freeze({
      passed: true,
      reason: null,
      evidence: Object.freeze({
        blurRevision,
        blurReceiptRevision,
        blurSettlementHmac: hmac("tui-focus-blur-settlement", JSON.stringify(blurSettlement)),
        clientHmac: hmac("authority-client", expectedTuiClientId),
        settledOwnersHmac: hmac(
          "tui-focus-blur-settled-owners",
          JSON.stringify(blurSettlement.settledIdentity.authorityOwners),
        ),
      }),
    });
  if (
    focusEvents.length !== 1 ||
    claims.length !== 1 ||
    focusSettlements.length !== 1 ||
    focusFences.length !== 1
  )
    return fail("focus-claim-cardinality");
  const focusEvent = focusEvents[0];
  const claim = claims[0];
  const focusSettlement = focusSettlements[0];
  const focusFence = focusFences[0];
  const settlementReceipts = focusSettlement.receipts;
  const exactReceipts =
    Array.isArray(settlementReceipts) &&
    settlementReceipts.length === authorities.length &&
    authorities.every((authority) => {
      const matching = settlementReceipts.filter((receipt) => receipt?.authority === authority);
      return (
        matching.length === 1 &&
        exactKeys(matching[0], [
          "authority",
          "status",
          "generation",
          "granted",
          "revision",
          "session",
          "clientId",
        ]) &&
        matching[0].status === "fulfilled" &&
        matching[0].granted === true &&
        matching[0].generation === expectedCanonical.generation &&
        matching[0].session === expectedRuntimeSession &&
        typeof matching[0].clientId === "string" &&
        matching[0].clientId.length > 0 &&
        Number.isSafeInteger(matching[0].revision) &&
        matching[0].revision > minimumFocusAuthorityRevision
      );
    });
  const clientIds = new Set(settlementReceipts?.map((receipt) => receipt?.clientId) ?? []);
  const revisions = settlementReceipts?.map((receipt) => receipt?.revision) ?? [];
  const focusRevision = focusSettlement.settledIdentity?.authorityRevision;
  if (
    !Number.isSafeInteger(focusEvent.diagnosticEpoch) ||
    focusEvent.diagnosticEpoch !== blurEvent.diagnosticEpoch + 1 ||
    focusEvent.state !== "foreground" ||
    claim.diagnosticEpoch !== focusEvent.diagnosticEpoch ||
    claim.claimOrdinal !== baselineClaimOrdinal + 1 ||
    focusSettlement.diagnosticEpoch !== focusEvent.diagnosticEpoch ||
    focusSettlement.status !== "fulfilled" ||
    focusSettlement.bindingCurrent !== true ||
    ![focusEvent, claim, focusSettlement].every(sameProcess) ||
    ![focusEvent, claim, focusSettlement, focusFence].every(safePoint) ||
    !(postLifecycle.indexOf(focusEvent) < postLifecycle.indexOf(claim)) ||
    !(postLifecycle.indexOf(claim) < postLifecycle.indexOf(focusSettlement)) ||
    !(postLifecycle.indexOf(focusSettlement) < postLifecycle.indexOf(focusFence)) ||
    (receipts.blur.status === "changed" &&
      !(postLifecycle.indexOf(blurFence) < postLifecycle.indexOf(focusEvent))) ||
    focusEvent.monotonicMicros < blurFence.monotonicMicros ||
    claim.monotonicMicros < focusEvent.monotonicMicros ||
    focusSettlement.monotonicMicros < claim.monotonicMicros ||
    focusFence.monotonicMicros < focusSettlement.monotonicMicros ||
    !healthyFence(focusFence, focusSettlement) ||
    !exactReceipts ||
    clientIds.size !== 1 ||
    new Set(revisions).size !== revisions.length ||
    !Number.isSafeInteger(blurRevision) ||
    blurRevision < minimumBlurAuthorityRevision ||
    !Number.isSafeInteger(focusRevision) ||
    focusRevision <= Math.max(blurRevision, minimumFocusAuthorityRevision) ||
    focusRevision !== Math.max(...revisions)
  )
    return fail("focus-claim-lifecycle-invalid");
  return Object.freeze({
    passed: true,
    reason: null,
    evidence: Object.freeze({
      hostPaneHmac: expectedBindingHmac,
      blurReceiptHmac: receipts.blur.receiptHmac,
      focusReceiptHmac: receipts.focus.receiptHmac,
      duplicateFocusReceiptHmac: stage === "complete" ? receipts.duplicateFocus.receiptHmac : null,
      blurSettlementHmac: hmac("tui-focus-blur-settlement", JSON.stringify(blurSettlement)),
      focusSettlementHmac: hmac("tui-focus-focus-settlement", JSON.stringify(focusSettlement)),
      lifecycleHmac: hmac(
        "tui-focus-lifecycle",
        [
          ...(receipts.blur.status === "no-op" ? [blurEvent, blurSettlement, blurFence] : []),
          ...postLifecycle,
        ]
          .map((record) => `${record.phase}:${record.diagnosticEpoch ?? ""}`)
          .join("\0"),
      ),
      blurEpoch: blurEvent.diagnosticEpoch,
      focusEpoch: focusEvent.diagnosticEpoch,
      claimOrdinal: claim.claimOrdinal,
      blurRevision,
      focusRevision,
      clientHmac: hmac("authority-client", [...clientIds][0]),
      claimCount: claims.length,
      duplicateClaimCount: 0,
    }),
  });
}

export function boundedCard5TuiBlurTransitionObservation({
  assessment,
  records,
  receipt = null,
  evidenceKey,
}) {
  const lifecycle = Array.isArray(records)
    ? records.filter(
        (record) => typeof record?.phase === "string" && record.phase.startsWith("terminal-host-"),
      )
    : [];
  const phaseCount = (phase) =>
    Math.min(8, lifecycle.filter((record) => record.phase === phase).length);
  const settlement = lifecycle.find(
    (record) => record.phase === "terminal-host-blur-authority-settled",
  );
  const fence = lifecycle.find(
    (record) =>
      record.phase === "terminal-host-focus-fence" &&
      record.diagnosticEpoch === settlement?.diagnosticEpoch,
  );
  const hmac = (domain, value) =>
    HMAC.test(evidenceKey ?? "")
      ? createHmac("sha256", Buffer.from(evidenceKey, "hex"))
          .update(`${domain}\0${value}`)
          .digest("hex")
      : null;
  const revisions = Array.isArray(settlement?.receipts)
    ? settlement.receipts
        .map(({ revision }) => (Number.isSafeInteger(revision) && revision >= 0 ? revision : null))
        .slice(0, 3)
    : [];
  return Object.freeze({
    reason:
      typeof assessment?.reason === "string" && assessment.reason.length <= 64
        ? assessment.reason
        : assessment?.passed === true
          ? "exact"
          : "blur-assessment-unavailable",
    passed: assessment?.passed === true,
    controlStatus: ["changed", "no-op", "stale", "rejected"].includes(receipt?.status)
      ? receipt.status
      : null,
    controlEpoch:
      Number.isSafeInteger(receipt?.diagnosticEpoch) && receipt.diagnosticEpoch >= 1
        ? receipt.diagnosticEpoch
        : null,
    controlBindingHmac: HMAC.test(receipt?.bindingHmac ?? "") ? receipt.bindingHmac : null,
    recordCount: Math.min(lifecycle.length, 64),
    recordOverflow: lifecycle.length > 64,
    blurEventCount: phaseCount("terminal-host-renderer-blur-event"),
    settlementCount: phaseCount("terminal-host-blur-authority-settled"),
    fenceCount: phaseCount("terminal-host-focus-fence"),
    diagnosticEpoch:
      Number.isSafeInteger(settlement?.diagnosticEpoch) && settlement.diagnosticEpoch >= 0
        ? settlement.diagnosticEpoch
        : null,
    receiptCount: Math.min(settlement?.receipts?.length ?? 0, 4),
    receiptOverflow: (settlement?.receipts?.length ?? 0) > 4,
    receiptStatuses: Object.freeze(
      Array.isArray(settlement?.receipts)
        ? settlement.receipts
            .slice(0, 3)
            .map(({ status }) => (["fulfilled", "rejected"].includes(status) ? status : "invalid"))
        : [],
    ),
    receiptRevisions: Object.freeze(revisions),
    settledRevision:
      Number.isSafeInteger(settlement?.settledIdentity?.authorityRevision) &&
      settlement.settledIdentity.authorityRevision >= 0
        ? settlement.settledIdentity.authorityRevision
        : null,
    settledOwnersHmac:
      settlement?.settledIdentity?.authorityOwners === null ||
      typeof settlement?.settledIdentity?.authorityOwners !== "object"
        ? null
        : hmac(
            "tui-blur-observed-owners",
            JSON.stringify(settlement.settledIdentity.authorityOwners),
          ),
    writerHealthy:
      fence?.writerHealth?.failed === false &&
      fence?.writerHealth?.droppedRecords === 0 &&
      fence?.writerHealth?.pendingCriticalRecords === 0,
    tailPosition:
      Number.isSafeInteger(lifecycle.at(-1)?.monotonicMicros) &&
      lifecycle.at(-1).monotonicMicros >= 0
        ? lifecycle.at(-1).monotonicMicros
        : null,
  });
}

/** Select the exact current lifecycle identity used to authenticate host-focus control. */
export function selectCard5TuiHostFocusBinding({
  lifecycleRecords,
  referenceRecords,
  expectedCanonical,
  expectedAuthority,
  expectedWorkspaceName,
  expectedTuiClientId,
  evidenceKey,
}) {
  const relevant = Array.isArray(lifecycleRecords)
    ? lifecycleRecords.filter((record) =>
        [
          "terminal-host-focus-authority-settled",
          "terminal-host-blur-authority-settled",
          "terminal-host-focus-authority-reconcile",
        ].includes(record?.phase),
      )
    : [];
  const bindingRecords = Array.isArray(lifecycleRecords)
    ? lifecycleRecords.filter(
        (record) => record?.phase === "terminal-host-focus-control-binding-ready",
      )
    : [];
  const gateRecords = Array.isArray(lifecycleRecords)
    ? lifecycleRecords.filter(
        (record) => record?.phase === "terminal-host-focus-control-gate-ready",
      )
    : [];
  const bindingFrame = Array.isArray(referenceRecords)
    ? (referenceRecords.findLast(
        (record) =>
          record?.type === "performance.terminal-frame-fence" &&
          record.semanticPaneId === expectedCanonical?.semanticPaneId &&
          record.processId === expectedCanonical?.processId &&
          record.clockId === expectedCanonical?.clockId &&
          record.generation === expectedCanonical?.generation &&
          record.incarnation === expectedCanonical?.incarnation &&
          record.revision === expectedCanonical?.revision &&
          record.stateHash === expectedCanonical?.canonicalStateHash &&
          Number.isSafeInteger(record.rendererEpoch) &&
          record.rendererEpoch >= 0,
      ) ?? null)
    : null;
  const hmac = (domain, value) =>
    HMAC.test(evidenceKey ?? "")
      ? createHmac("sha256", Buffer.from(evidenceKey, "hex"))
          .update(`${domain}\0${value}`)
          .digest("hex")
      : null;
  const authorities = ["input", "focus", "geometry"];
  const currentPresence = expectedAuthority?.clients?.find(
    ({ clientId }) => clientId === expectedTuiClientId,
  );
  const ownersExact = (owners) =>
    exactAuthorityOwners(owners) &&
    authorities.every((authority) => owners[authority] === expectedAuthority?.owners?.[authority]);
  const lifecycleEnvelopeExact = (record, details) =>
    exactKeys(record, [
      "phase",
      "elapsedMs",
      "at",
      ...details,
      "monotonicMicros",
      "processId",
      "clockId",
    ]) &&
    Number.isSafeInteger(record?.elapsedMs) &&
    record.elapsedMs >= 0 &&
    typeof record?.at === "string" &&
    record.at.length <= 40 &&
    Number.isFinite(Date.parse(record.at)) &&
    Number.isSafeInteger(record?.monotonicMicros) &&
    record.monotonicMicros >= 0;
  const bindingReadyExact = (record) =>
    record?.phase === "terminal-host-focus-control-binding-ready" &&
    lifecycleEnvelopeExact(record, [
      "bindingEpoch",
      "rendererEpoch",
      "clientGeneration",
      "clientPhase",
      "authorityGeneration",
      "runtimeSession",
      "daemonInstanceId",
      "workspaceName",
      "clientId",
    ]) &&
    record?.processId === expectedCanonical?.processId &&
    record?.clockId === expectedCanonical?.clockId &&
    record?.daemonInstanceId === expectedAuthority?.generation &&
    record?.authorityGeneration === expectedAuthority?.generation &&
    record?.runtimeSession === expectedAuthority?.session &&
    record?.workspaceName === expectedWorkspaceName &&
    record?.clientId === expectedTuiClientId &&
    record?.clientPhase === "live" &&
    record?.rendererEpoch === bindingFrame?.rendererEpoch &&
    Number.isSafeInteger(record?.rendererEpoch) &&
    record.rendererEpoch >= 0 &&
    Number.isSafeInteger(record?.clientGeneration) &&
    record.clientGeneration >= 0 &&
    Number.isSafeInteger(record?.bindingEpoch) &&
    record.bindingEpoch >= 1;
  const gateDetails = ["capability", "detail", "path", "root", "key", "trace", "enabled"];
  const gateExact = (record) =>
    record?.phase === "terminal-host-focus-control-gate-ready" &&
    lifecycleEnvelopeExact(record, gateDetails) &&
    record?.processId === expectedCanonical?.processId &&
    record?.clockId === expectedCanonical?.clockId &&
    record?.capability === true &&
    record?.detail === true &&
    record?.path === true &&
    record?.root === true &&
    record?.key === true &&
    record?.trace === true &&
    record?.enabled === true;
  const reconcileReceiptExact = (record, authority) => {
    const matches = record.receipts.filter((receipt) => receipt?.authority === authority);
    return (
      matches.length === 1 &&
      exactKeys(matches[0], ["authority", "status", "granted", "exact"]) &&
      matches[0].status === "fulfilled" &&
      matches[0].granted === true &&
      matches[0].exact === true
    );
  };
  const settlementExact = (record) => {
    const settled = record?.settledIdentity;
    if (
      !["terminal-host-focus-authority-settled", "terminal-host-blur-authority-settled"].includes(
        record?.phase,
      ) ||
      !Number.isSafeInteger(record?.diagnosticEpoch) ||
      record.diagnosticEpoch < 1 ||
      record.status !== "fulfilled" ||
      record.bindingCurrent !== true ||
      !exactKeys(settled, [
        "clientGeneration",
        "clientPhase",
        "authorityGeneration",
        "runtimeSession",
        "authorityOwners",
        "authorityRevision",
        "daemonInstanceId",
        "workspaceName",
        "opentuiPresence",
      ]) ||
      settled.clientGeneration !== record.clientGeneration ||
      settled.clientPhase !== "live" ||
      settled.authorityGeneration !== expectedAuthority?.generation ||
      settled.runtimeSession !== expectedAuthority?.session ||
      settled.daemonInstanceId !== expectedAuthority?.generation ||
      settled.workspaceName !== expectedWorkspaceName ||
      !exactAuthorityOwners(settled.authorityOwners) ||
      !Number.isSafeInteger(settled.authorityRevision) ||
      settled.authorityRevision < 0 ||
      !exactKeys(settled.opentuiPresence, [
        "clientId",
        "state",
        "connectedRevision",
        "activityRevision",
      ]) ||
      settled.opentuiPresence.clientId !== expectedTuiClientId ||
      !Array.isArray(record.receipts) ||
      record.receipts.length !== 3
    )
      return false;
    const receiptsExact = authorities.every((authority) => {
      const matches = record.receipts.filter((receipt) => receipt?.authority === authority);
      const receipt = matches[0];
      return (
        matches.length === 1 &&
        exactKeys(
          receipt,
          record.phase === "terminal-host-focus-authority-settled"
            ? ["authority", "status", "generation", "granted", "revision", "session", "clientId"]
            : ["authority", "status", "generation", "owners", "revision", "session"],
        ) &&
        receipt?.status === "fulfilled" &&
        receipt.generation === expectedAuthority?.generation &&
        receipt.session === expectedAuthority?.session &&
        (record.phase === "terminal-host-focus-authority-settled"
          ? receipt.granted === true && receipt.clientId === expectedTuiClientId
          : exactAuthorityOwners(receipt.owners))
      );
    });
    if (!receiptsExact) return false;
    const receiptRevisions = record.receipts.map(({ revision }) => revision);
    if (
      receiptRevisions.some((revision) => !Number.isSafeInteger(revision) || revision < 0) ||
      settled.authorityRevision < Math.max(...receiptRevisions)
    )
      return false;
    return record.phase === "terminal-host-focus-authority-settled"
      ? settled.opentuiPresence.state === "foreground" &&
          authorities.every(
            (authority) => settled.authorityOwners[authority] === expectedTuiClientId,
          )
      : settled.opentuiPresence.state === "background" &&
          authorities.every(
            (authority) => settled.authorityOwners[authority] !== expectedTuiClientId,
          );
  };
  const valid = bindingRecords.filter(bindingReadyExact);
  const selected = valid.at(-1) ?? null;
  const latestRelevant = bindingRecords.at(-1) ?? null;
  const validGates = gateRecords.filter(gateExact);
  const selectedGate = validGates.at(-1) ?? null;
  const latestGate = gateRecords.at(-1) ?? null;
  const gatePassed =
    gateRecords.length <= 64 && selectedGate !== null && selectedGate === latestGate;
  const passed =
    gatePassed && bindingRecords.length <= 64 && selected !== null && selected === latestRelevant;
  const source = passed ? "binding-ready" : null;
  const reason =
    gateRecords.length > 64
      ? "binding-gate-overflow"
      : selectedGate === null
        ? "binding-gate-invalid"
        : selectedGate !== latestGate
          ? "binding-gate-stale"
          : bindingRecords.length > 64
            ? "binding-record-overflow"
            : selected === null
              ? "binding-record-invalid"
              : selected !== latestRelevant
                ? "binding-record-stale"
                : "binding-record-ambiguous";
  const latestReconcile = relevant.findLast(
    (record) => record?.phase === "terminal-host-focus-authority-reconcile",
  );
  const authorityOutcome = (authority) => {
    if (!latestReconcile) return "missing-record";
    if (!Array.isArray(latestReconcile.receipts)) return "receipts-invalid";
    const matches = latestReconcile.receipts.filter((receipt) => receipt?.authority === authority);
    if (matches.length === 0) return "receipt-missing";
    if (matches.length !== 1) return "receipt-duplicate";
    const receipt = matches[0];
    if (!exactKeys(receipt, ["authority", "status", "granted", "exact"])) return "receipt-invalid";
    if (receipt.status !== "fulfilled") return "not-fulfilled";
    if (receipt.granted !== true) return "not-granted";
    return receipt.exact === true ? "granted-exact" : "granted-inexact";
  };
  const allTuiOwners = latestReconcile
    ? exactAuthorityOwners(latestReconcile.authorityOwners) &&
      authorities.every(
        (authority) => latestReconcile.authorityOwners[authority] === expectedTuiClientId,
      )
    : null;
  return Object.freeze({
    passed,
    reason: passed ? null : reason,
    source,
    binding: passed
      ? Object.freeze({
          rendererEpoch: selected.rendererEpoch,
          clientGeneration: selected.clientGeneration,
          bindingEpoch: selected.bindingEpoch,
        })
      : null,
    observation: Object.freeze({
      bindingSource: source,
      reason: passed ? "exact" : reason,
      gateCount: Math.min(gateRecords.length, 64),
      gateOverflow: gateRecords.length > 64,
      gateSchemaMismatch: latestGate !== null && !lifecycleEnvelopeExact(latestGate, gateDetails),
      gateProcessMismatch:
        latestGate !== null && latestGate?.processId !== expectedCanonical?.processId,
      gateClockMismatch: latestGate !== null && latestGate?.clockId !== expectedCanonical?.clockId,
      gateCapability: latestGate?.capability === true,
      gateDetail: latestGate?.detail === true,
      gatePath: latestGate?.path === true,
      gateRoot: latestGate?.root === true,
      gateKey: latestGate?.key === true,
      gateTrace: latestGate?.trace === true,
      gateEnabled: latestGate?.enabled === true,
      relevantCount: Math.min(bindingRecords.length, 64),
      overflow: bindingRecords.length > 64,
      processMismatch: bindingRecords.some(
        (record) => record?.processId !== expectedCanonical?.processId,
      ),
      clockMismatch: bindingRecords.some(
        (record) => record?.clockId !== expectedCanonical?.clockId,
      ),
      generationMismatch: bindingRecords.some(
        (record) => record?.daemonInstanceId !== expectedAuthority?.generation,
      ),
      sessionMismatch: bindingRecords.some(
        (record) => record?.runtimeSession !== expectedAuthority?.session,
      ),
      workspaceMismatch: bindingRecords.some(
        (record) => record?.workspaceName !== expectedWorkspaceName,
      ),
      clientMismatch: bindingRecords.some((record) => record?.clientId !== expectedTuiClientId),
      epochMismatch:
        bindingFrame === null ||
        bindingRecords.some((record) => record?.rendererEpoch !== bindingFrame.rendererEpoch),
      clientGenerationMismatch: bindingRecords.some(
        (record) => !Number.isSafeInteger(record?.clientGeneration) || record.clientGeneration < 0,
      ),
      diagnosticEpochMismatch: relevant.some(
        (record) =>
          record?.phase === "terminal-host-focus-authority-reconcile" &&
          record?.diagnosticEpoch !== null,
      ),
      statusMismatch: relevant.some(
        (record) =>
          record?.phase === "terminal-host-focus-authority-reconcile" &&
          record?.status !== "applied",
      ),
      presenceMismatch: relevant.some(
        (record) =>
          record?.phase === "terminal-host-focus-authority-reconcile" &&
          (record?.opentuiPresence?.state !== "foreground" ||
            currentPresence?.state !== "foreground"),
      ),
      revisionRelationMismatch: relevant.some(
        (record) =>
          record?.phase === "terminal-host-focus-authority-reconcile" &&
          (!Number.isSafeInteger(record?.authorityRevision) ||
            !Number.isSafeInteger(expectedAuthority?.revision) ||
            record.authorityRevision < 0 ||
            record.authorityRevision > expectedAuthority.revision ||
            !Number.isSafeInteger(record?.opentuiPresence?.connectedRevision) ||
            !Number.isSafeInteger(record?.opentuiPresence?.activityRevision) ||
            record.opentuiPresence.connectedRevision < 0 ||
            record.opentuiPresence.activityRevision < record.opentuiPresence.connectedRevision ||
            record.opentuiPresence.activityRevision > record.authorityRevision ||
            !Number.isSafeInteger(currentPresence?.connectedRevision) ||
            !Number.isSafeInteger(currentPresence?.activityRevision) ||
            record.opentuiPresence.connectedRevision > currentPresence.connectedRevision ||
            record.opentuiPresence.activityRevision > currentPresence.activityRevision),
      ),
      receiptMismatch: relevant.some(
        (record) =>
          record?.phase === "terminal-host-focus-authority-reconcile" &&
          (!Array.isArray(record?.receipts) ||
            record.receipts.length !== 3 ||
            !authorities.every((authority) => reconcileReceiptExact(record, authority))),
      ),
      ownerMismatch: relevant.some((record) =>
        record?.phase === "terminal-host-focus-authority-reconcile"
          ? !ownersExact(record?.authorityOwners)
          : !settlementExact(record),
      ),
      authorityOutcome: Object.freeze({
        input: authorityOutcome("input"),
        focus: authorityOutcome("focus"),
        geometry: authorityOutcome("geometry"),
      }),
      allTuiOwners,
      recordHmac: selected ? hmac("host-focus-binding-record", JSON.stringify(selected)) : null,
    }),
  });
}

export function advanceCard5AuthorityReleaseStability(previous, candidate, qualified) {
  if (typeof candidate !== "string" || candidate.length > 16_384 || qualified !== true)
    return Object.freeze({ candidate: null, samples: 0, passed: false });
  const samples = previous?.candidate === candidate ? (previous.samples ?? 0) + 1 : 1;
  return Object.freeze({ candidate, samples, passed: samples >= 2 });
}

export function advanceCard5RetainedFocusStability(previous, candidate, qualified) {
  return advanceCard5AuthorityReleaseStability(previous, candidate, qualified);
}

export function assessCard5TuiFocusedPane({
  records,
  expectedPane,
  expectedCanonical,
  expectedAuthority = undefined,
  evidenceKey,
}) {
  const hmac = (domain, value) =>
    createHmac("sha256", Buffer.from(evidenceKey, "hex"))
      .update(`${domain}\0${value}`)
      .digest("hex");
  const emptyAxes = () => ({
    pane: true,
    generation: true,
    incarnation: true,
    revision: true,
    canonicalHash: true,
    process: true,
    clock: true,
    canonicalDimensions: true,
    viewportDimensions: true,
    presentationCount: true,
    followingFrame: true,
    frameHealth: true,
    authority: true,
  });
  const safeHmac = (domain, value) =>
    typeof value === "string" && value.length > 0 ? hmac(domain, value) : null;
  const candidateFor = (presentation, frame, axes) =>
    Object.freeze({
      paneHmac: safeHmac("focused-pane-candidate", presentation?.semanticPaneId),
      generationHmac: safeHmac("focused-generation-candidate", presentation?.generation),
      incarnationHmac: safeHmac("focused-incarnation-candidate", presentation?.incarnation),
      processHmac: safeHmac("focused-process-candidate", presentation?.processId),
      clockHmac: safeHmac("focused-clock-candidate", presentation?.clockId),
      canonicalHashHmac: safeHmac("focused-canonical-candidate", presentation?.stateHash),
      revision: boundedInteger(presentation?.revision, 0xffff_ffff),
      cols: boundedInteger(presentation?.cols, 65_535),
      rows: boundedInteger(presentation?.rows, 65_535),
      viewportCols: boundedInteger(presentation?.viewportCols, 65_535),
      viewportRows: boundedInteger(presentation?.viewportRows, 65_535),
      presentationCount: boundedInteger(presentation?.presentationCount, 0xffff_ffff),
      presentationHmac:
        Number.isSafeInteger(presentation?.atMicros) && presentation.atMicros >= 0
          ? hmac(
              "focused-cursor-presentation",
              [presentation.atMicros, presentation.presentationCount].join("\0"),
            )
          : null,
      frameHmac:
        Number.isSafeInteger(frame?.atMicros) && frame.atMicros >= 0
          ? hmac(
              "focused-frame-fence",
              [frame.atMicros, frame.revision, frame.stateHash].join("\0"),
            )
          : null,
      axes: Object.freeze({ ...axes }),
    });
  const fail = (reason, presentation = null, frame = null, axes = emptyAxes()) =>
    Object.freeze({
      passed: false,
      reason,
      evidence: null,
      axes: Object.freeze({ ...axes }),
      candidate: candidateFor(presentation, frame, axes),
    });
  if (
    !Array.isArray(records) ||
    !TUI_FENCE_TEXT.test(expectedPane ?? "") ||
    !expectedCanonical ||
    !GENERATION.test(expectedCanonical.generation ?? "") ||
    !TUI_FENCE_TEXT.test(expectedCanonical.incarnation ?? "") ||
    !Number.isSafeInteger(expectedCanonical.revision) ||
    !CANONICAL_STATE_HASH.test(expectedCanonical.canonicalStateHash ?? "") ||
    !/^opentui:[1-9]\d*$/u.test(expectedCanonical.processId ?? "") ||
    expectedCanonical.clockId !== "opentui-performance-now" ||
    !Number.isSafeInteger(expectedCanonical.cols) ||
    expectedCanonical.cols < 1 ||
    !Number.isSafeInteger(expectedCanonical.rows) ||
    expectedCanonical.rows < 1 ||
    !HMAC.test(evidenceKey ?? "")
  )
    return fail("focus-contract-invalid");
  const presentations = records.filter(
    (record) => record?.type === "performance.terminal-cursor-presentation",
  );
  if (presentations.length === 0) return fail("focus-presentation-missing");
  if (presentations.some(({ atMicros }) => !Number.isSafeInteger(atMicros) || atMicros < 0))
    return fail("focus-presentation-invalid");
  if (
    presentations.some(
      ({ atMicros }, index) => index > 0 && atMicros <= presentations[index - 1].atMicros,
    )
  )
    return fail("focus-presentation-ambiguous");
  const presentation = presentations.at(-1);
  const authorityEvidence =
    expectedAuthority === undefined
      ? null
      : sealCard5TuiFocusAuthority(expectedAuthority, expectedCanonical.generation, evidenceKey);
  const axes = {
    pane: presentation.semanticPaneId !== expectedPane,
    generation: presentation.generation !== expectedCanonical.generation,
    incarnation: presentation.incarnation !== expectedCanonical.incarnation,
    revision: presentation.revision !== expectedCanonical.revision,
    canonicalHash: presentation.stateHash !== expectedCanonical.canonicalStateHash,
    process: presentation.processId !== expectedCanonical.processId,
    clock:
      presentation.clockId !== expectedCanonical.clockId ||
      presentation.clockKind !== "performance-now",
    canonicalDimensions:
      presentation.cols !== expectedCanonical.cols || presentation.rows !== expectedCanonical.rows,
    viewportDimensions:
      !Number.isSafeInteger(presentation.viewportCols) ||
      presentation.viewportCols < 1 ||
      presentation.viewportCols > 65_535 ||
      !Number.isSafeInteger(presentation.viewportRows) ||
      presentation.viewportRows < 1 ||
      presentation.viewportRows > 65_535,
    presentationCount:
      !Number.isSafeInteger(presentation.presentationCount) || presentation.presentationCount < 1,
    followingFrame: true,
    frameHealth: true,
    authority: expectedAuthority !== undefined && authorityEvidence === null,
  };
  const presentationOrdinal = records.indexOf(presentation);
  const frame = records
    .filter(
      (record, ordinal) =>
        ordinal > presentationOrdinal &&
        record?.type === "performance.terminal-frame-fence" &&
        record.semanticPaneId === presentation.semanticPaneId &&
        record.generation === presentation.generation &&
        record.incarnation === presentation.incarnation &&
        record.revision === presentation.revision &&
        record.stateHash === presentation.stateHash &&
        record.processId === presentation.processId &&
        record.clockId === presentation.clockId &&
        record.clockKind === presentation.clockKind &&
        record.cols === presentation.cols &&
        record.rows === presentation.rows &&
        record.viewportCols === presentation.viewportCols &&
        record.viewportRows === presentation.viewportRows,
    )
    .at(-1);
  axes.followingFrame = frame === undefined;
  const frameOrdinal = frame === undefined ? -1 : records.indexOf(frame);
  const laterCursorPresentation = records.some(
    (record, ordinal) =>
      ordinal > frameOrdinal && record?.type === "performance.terminal-cursor-presentation",
  );
  const laterChangedSamePaneFrame = records.some(
    (record, ordinal) =>
      ordinal > frameOrdinal &&
      record?.type === "performance.terminal-frame-fence" &&
      record.semanticPaneId === presentation.semanticPaneId,
  );
  axes.frameHealth =
    frame === undefined ||
    laterCursorPresentation ||
    laterChangedSamePaneFrame ||
    !Number.isSafeInteger(frame.atMicros) ||
    frame.atMicros <= presentation.atMicros ||
    frame.acceptedRevision !== frame.revision ||
    frame.identityDrops !== 0 ||
    frame.writerHealth?.droppedRecords !== 0 ||
    frame.writerHealth?.oversizedRecords !== 0 ||
    frame.writerHealth?.failed !== false ||
    frame.writerHealth?.pendingCriticalRecords !== 0;
  if (Object.values(axes).some(Boolean))
    return fail("focus-presentation-mismatch", presentation, frame ?? null, axes);
  return Object.freeze({
    passed: true,
    reason: null,
    evidence: Object.freeze({
      paneHmac: hmac("pane", expectedPane),
      processHmac: hmac("process", expectedCanonical.processId),
      clockHmac: hmac("clock", expectedCanonical.clockId),
      authorityHmac: authorityEvidence?.authorityHmac ?? null,
      authorityOwnerHmac: authorityEvidence?.authorityOwnerHmac ?? null,
      authorityRevision: authorityEvidence?.authorityRevision ?? null,
      authorityTopologyHmac: authorityEvidence?.authorityTopologyHmac ?? null,
      authorityMutationHmac: authorityEvidence?.authorityMutationHmac ?? null,
      canonicalHmac: hmac(
        "focused-canonical-identity",
        [
          expectedCanonical.generation,
          expectedCanonical.incarnation,
          expectedCanonical.revision,
          expectedCanonical.canonicalStateHash,
          expectedCanonical.cols,
          expectedCanonical.rows,
        ].join("\0"),
      ),
      presentationHmac: hmac(
        "focused-cursor-presentation",
        [presentation.atMicros, presentation.presentationCount].join("\0"),
      ),
      frameHmac: hmac(
        "focused-frame-fence",
        [frame.atMicros, frame.revision, frame.stateHash].join("\0"),
      ),
      focusStateHmac: hmac(
        "focused-state",
        [
          expectedPane,
          expectedCanonical.processId,
          expectedCanonical.clockId,
          expectedCanonical.generation,
          expectedCanonical.incarnation,
          frame.revision,
          frame.stateHash,
          frame.cols,
          frame.rows,
          frame.viewportCols,
          frame.viewportRows,
        ].join("\0"),
      ),
      revision: frame.revision,
      cols: frame.cols,
      rows: frame.rows,
      viewportCols: frame.viewportCols,
      viewportRows: frame.viewportRows,
    }),
    axes: Object.freeze({ ...axes }),
    candidate: candidateFor(presentation, frame, axes),
  });
}

export function assessCard5TuiRetainedFocus({
  records,
  expectedPane,
  expectedCanonical,
  acceptedFocusEvidence,
  expectedDiagnosticEpoch,
  expectedRendererEpoch,
  evidenceKey,
}) {
  const hmac = (domain, value) =>
    createHmac("sha256", Buffer.from(evidenceKey, "hex"))
      .update(`${domain}\0${value}`)
      .digest("hex");
  const axes = {
    pane: false,
    generation: false,
    incarnation: false,
    revision: false,
    canonicalHash: false,
    process: false,
    clock: false,
    canonicalDimensions: false,
    viewportDimensions: false,
    presentationCount: false,
    followingFrame: false,
    frameHealth: false,
    authority: false,
  };
  const fail = (reason, presentation = null, fence = null) =>
    Object.freeze({
      passed: false,
      reason,
      evidence: null,
      axes: Object.freeze({ ...axes }),
      candidate: Object.freeze({
        paneHmac:
          typeof presentation?.semanticPaneId === "string"
            ? hmac("retained-pane-candidate", presentation.semanticPaneId)
            : null,
        generationHmac:
          typeof presentation?.generation === "string"
            ? hmac("retained-generation-candidate", presentation.generation)
            : null,
        incarnationHmac:
          typeof presentation?.incarnation === "string"
            ? hmac("retained-incarnation-candidate", presentation.incarnation)
            : null,
        processHmac:
          typeof presentation?.processId === "string"
            ? hmac("retained-process-candidate", presentation.processId)
            : null,
        clockHmac:
          typeof presentation?.clockId === "string"
            ? hmac("retained-clock-candidate", presentation.clockId)
            : null,
        rendererEpoch: boundedInteger(presentation?.rendererEpoch, 0xffff_ffff),
        rendererEpochHmac:
          Number.isSafeInteger(presentation?.rendererEpoch) && presentation.rendererEpoch >= 1
            ? hmac("retained-renderer-epoch", String(presentation.rendererEpoch))
            : null,
        canonicalHashHmac:
          typeof presentation?.stateHash === "string"
            ? hmac("retained-canonical-candidate", presentation.stateHash)
            : null,
        revision: boundedInteger(presentation?.revision, 0xffff_ffff),
        cols: boundedInteger(presentation?.cols, 65_535),
        rows: boundedInteger(presentation?.rows, 65_535),
        viewportCols: boundedInteger(presentation?.viewportCols, 65_535),
        viewportRows: boundedInteger(presentation?.viewportRows, 65_535),
        presentationCount: boundedInteger(presentation?.presentationCount, 0xffff_ffff),
        presentationHmac:
          Number.isSafeInteger(presentation?.atMicros) && presentation.atMicros >= 0
            ? hmac(
                "retained-cursor-presentation",
                `${presentation.atMicros}\0${presentation.presentationCount}`,
              )
            : null,
        frameHmac:
          Number.isSafeInteger(fence?.atMicros) && fence.atMicros >= 0
            ? hmac(
                "retained-focus-fence",
                `${fence.atMicros}\0${fence.diagnosticEpoch}\0${fence.revision}\0${fence.stateHash}`,
              )
            : null,
        axes: Object.freeze({ ...axes }),
      }),
    });
  if (
    !Array.isArray(records) ||
    !TUI_FENCE_TEXT.test(expectedPane ?? "") ||
    !expectedCanonical ||
    !GENERATION.test(expectedCanonical.generation ?? "") ||
    !TUI_FENCE_TEXT.test(expectedCanonical.incarnation ?? "") ||
    !Number.isSafeInteger(expectedCanonical.revision) ||
    !CANONICAL_STATE_HASH.test(expectedCanonical.canonicalStateHash ?? "") ||
    !/^opentui:[1-9]\d*$/u.test(expectedCanonical.processId ?? "") ||
    expectedCanonical.clockId !== "opentui-performance-now" ||
    !Number.isSafeInteger(expectedDiagnosticEpoch) ||
    expectedDiagnosticEpoch < 1 ||
    !Number.isSafeInteger(expectedRendererEpoch) ||
    expectedRendererEpoch < 1 ||
    !HMAC.test(evidenceKey ?? "") ||
    !HMAC.test(acceptedFocusEvidence?.focusStateHmac ?? "")
  ) {
    Object.keys(axes).forEach((key) => (axes[key] = true));
    return fail("focus-contract-invalid");
  }
  const presentations = records.filter(
    (record) => record?.type === "performance.terminal-cursor-presentation",
  );
  if (presentations.length === 0) {
    axes.presentationCount = true;
    axes.followingFrame = true;
    return fail("focus-presentation-missing");
  }
  if (
    presentations.some(
      ({ atMicros }, index) =>
        !Number.isSafeInteger(atMicros) ||
        atMicros < 0 ||
        (index > 0 && atMicros <= presentations[index - 1].atMicros),
    )
  ) {
    axes.presentationCount = true;
    return fail("focus-presentation-ambiguous", presentations.at(-1));
  }
  const presentation = presentations.at(-1);
  axes.pane = presentation.semanticPaneId !== expectedPane;
  axes.generation = presentation.generation !== expectedCanonical.generation;
  axes.incarnation = presentation.incarnation !== expectedCanonical.incarnation;
  axes.revision = presentation.revision !== expectedCanonical.revision;
  axes.canonicalHash = presentation.stateHash !== expectedCanonical.canonicalStateHash;
  axes.process = presentation.processId !== expectedCanonical.processId;
  axes.clock =
    presentation.clockId !== expectedCanonical.clockId ||
    presentation.clockKind !== "performance-now";
  axes.authority =
    !Number.isSafeInteger(presentation.rendererEpoch) ||
    presentation.rendererEpoch < 1 ||
    presentation.rendererEpoch !== expectedRendererEpoch;
  axes.canonicalDimensions =
    presentation.cols !== acceptedFocusEvidence.cols ||
    presentation.rows !== acceptedFocusEvidence.rows;
  axes.viewportDimensions =
    presentation.viewportCols !== acceptedFocusEvidence.viewportCols ||
    presentation.viewportRows !== acceptedFocusEvidence.viewportRows;
  axes.presentationCount =
    !Number.isSafeInteger(presentation.presentationCount) || presentation.presentationCount < 1;
  const presentationOrdinal = records.indexOf(presentation);
  const fences = records.filter(
    (record, ordinal) =>
      ordinal > presentationOrdinal &&
      record?.type === "performance.terminal-focus-fence" &&
      record.diagnosticEpoch === expectedDiagnosticEpoch &&
      record.focused === true &&
      record.rendererEpoch === expectedRendererEpoch &&
      record.semanticPaneId === presentation.semanticPaneId &&
      record.processId === presentation.processId &&
      record.clockId === presentation.clockId &&
      record.clockKind === presentation.clockKind &&
      record.generation === presentation.generation &&
      record.incarnation === presentation.incarnation &&
      record.revision === presentation.revision &&
      record.stateHash === presentation.stateHash &&
      record.cols === presentation.cols &&
      record.rows === presentation.rows &&
      record.viewportCols === presentation.viewportCols &&
      record.viewportRows === presentation.viewportRows &&
      record.sourceEpoch === presentation.sourceEpoch,
  );
  const fence = fences.length === 1 ? fences[0] : undefined;
  axes.followingFrame = fence === undefined;
  const changedCanonical = records.some(
    (record) =>
      record?.semanticPaneId === expectedPane &&
      ((record.type === "performance.terminal-canonical-update" &&
        (record.revision !== expectedCanonical.revision ||
          record.stateHash !== expectedCanonical.canonicalStateHash)) ||
        (record.type === "performance.terminal-frame-fence" &&
          (record.revision !== expectedCanonical.revision ||
            record.stateHash !== expectedCanonical.canonicalStateHash ||
            record.cols !== acceptedFocusEvidence.cols ||
            record.rows !== acceptedFocusEvidence.rows ||
            record.viewportCols !== acceptedFocusEvidence.viewportCols ||
            record.viewportRows !== acceptedFocusEvidence.viewportRows))),
  );
  const focusStateHmac = hmac(
    "focused-state",
    [
      expectedPane,
      expectedCanonical.processId,
      expectedCanonical.clockId,
      expectedCanonical.generation,
      expectedCanonical.incarnation,
      presentation.revision,
      presentation.stateHash,
      presentation.cols,
      presentation.rows,
      presentation.viewportCols,
      presentation.viewportRows,
    ].join("\0"),
  );
  axes.frameHealth =
    fence === undefined ||
    fences.length !== 1 ||
    !Number.isSafeInteger(presentation.sourceEpoch) ||
    presentation.sourceEpoch < 0 ||
    !Number.isSafeInteger(fence.atMicros) ||
    fence.atMicros <= presentation.atMicros ||
    fence.writerHealth?.droppedRecords !== 0 ||
    fence.writerHealth?.oversizedRecords !== 0 ||
    fence.writerHealth?.failed !== false ||
    fence.writerHealth?.pendingCriticalRecords !== 0 ||
    changedCanonical ||
    focusStateHmac !== acceptedFocusEvidence.focusStateHmac;
  if (Object.values(axes).some(Boolean))
    return fail("focus-presentation-mismatch", presentation, fence ?? null);
  return Object.freeze({
    passed: true,
    reason: null,
    axes: Object.freeze({ ...axes }),
    candidate: fail("focus-presentation-mismatch", presentation, fence).candidate,
    evidence: Object.freeze({
      ...acceptedFocusEvidence,
      presentationHmac: hmac(
        "retained-cursor-presentation",
        `${presentation.atMicros}\0${presentation.presentationCount}`,
      ),
      focusFenceHmac: hmac(
        "retained-focus-fence",
        `${fence.atMicros}\0${fence.diagnosticEpoch}\0${fence.revision}\0${fence.stateHash}`,
      ),
      rendererEpoch: presentation.rendererEpoch,
      rendererEpochHmac: hmac("retained-renderer-epoch", String(presentation.rendererEpoch)),
      focusStateHmac,
    }),
  });
}

export function hasExactCard5TuiFocusAuthority(authority, generation) {
  return sealCard5TuiFocusAuthority(authority, generation, "0".repeat(64)) !== null;
}

export function assessCard5TuiFocusAuthority(
  authority,
  generation,
  evidenceKey,
  authorityRecords = [],
) {
  const exactKeys = (value, keys) =>
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
  const validClientId = (value) =>
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 4_096 &&
    !/[\0\r\n]/u.test(value);
  const clients = Array.isArray(authority?.clients) ? authority.clients : [];
  const clientSchemaInvalid = clients.some(
    (client) =>
      !exactKeys(client, [
        "clientId",
        "surface",
        "state",
        "connectedRevision",
        "activityRevision",
      ]) ||
      !validClientId(client?.clientId) ||
      !["web", "opentui", "cli", "sdk", "native-tmux", "unknown"].includes(client?.surface) ||
      !["foreground", "background"].includes(client?.state) ||
      !Number.isSafeInteger(client?.connectedRevision) ||
      client.connectedRevision < 1 ||
      !Number.isSafeInteger(client?.activityRevision) ||
      client.activityRevision < 0,
  );
  const duplicateClients =
    clients.length > 0 && new Set(clients.map(({ clientId }) => clientId)).size !== clients.length;
  const opentui = clients.filter(({ surface }) => surface === "opentui");
  const web = clients.filter(({ surface }) => surface === "web");
  const axes = Object.freeze({
    generation: !GENERATION.test(generation ?? "") || authority?.generation !== generation,
    session: !GENERATION.test(authority?.session ?? ""),
    revision: !Number.isSafeInteger(authority?.revision) || authority.revision < 0,
    nativeYield:
      !Number.isSafeInteger(authority?.nativeGeometryYieldUntilMs) ||
      authority.nativeGeometryYieldUntilMs < 0,
    authorityKeys: !exactKeys(authority, [
      "generation",
      "session",
      "revision",
      "owners",
      "nativeGeometryYieldUntilMs",
      "clients",
    ]),
    ownerKeys: !exactKeys(authority?.owners, ["input", "focus", "geometry"]),
    clientCount: clients.length !== 3,
    clientSchema: clientSchemaInvalid,
    surfaceCardinality: opentui.length !== 1 || web.length !== 2,
    duplicateClients,
    inputOwner: opentui.length !== 1 || authority?.owners?.input !== opentui[0]?.clientId,
    focusOwner: opentui.length !== 1 || authority?.owners?.focus !== opentui[0]?.clientId,
  });
  const reasons = [
    ["generation-mismatch", axes.generation],
    ["session-invalid", axes.session],
    ["revision-invalid", axes.revision],
    ["native-yield-invalid", axes.nativeYield],
    ["authority-keys-invalid", axes.authorityKeys],
    ["owner-keys-invalid", axes.ownerKeys],
    ["client-count-invalid", axes.clientCount],
    ["client-schema-invalid", axes.clientSchema],
    ["surface-cardinality-invalid", axes.surfaceCardinality],
    ["duplicate-client", axes.duplicateClients],
    ["input-owner-invalid", axes.inputOwner],
    ["focus-owner-invalid", axes.focusOwner],
  ];
  const reason = reasons.find(([, failed]) => failed)?.[0] ?? null;
  const hmac = (domain, value) =>
    HMAC.test(evidenceKey ?? "")
      ? createHmac("sha256", Buffer.from(evidenceKey, "hex"))
          .update(`${domain}\0${value}`)
          .digest("hex")
      : null;
  const boundedRecords = Array.isArray(authorityRecords) ? authorityRecords.slice(-2) : [];
  const recordTransitions = boundedRecords.map((record) => {
    const recordClients = Array.isArray(record?.clients) ? record.clients : [];
    return Object.freeze({
      ordinal: boundedInteger(record?.ordinal, 0xffff_ffff),
      revision: boundedInteger(record?.revision, 0xffff_ffff),
      clientCount: Math.min(recordClients.length, 8),
      ownerHmac: hmac(
        "authority-record-owner",
        [record?.inputOwner, record?.focusOwner, record?.geometryOwner].join("\0"),
      ),
      topologyHmac: hmac(
        "authority-record-topology",
        JSON.stringify(
          recordClients
            .map((client) => ({
              clientId: client?.clientId,
              surface: client?.surface,
              state: client?.state,
              connectedRevision: client?.connectedRevision,
            }))
            .sort((left, right) => String(left.clientId).localeCompare(String(right.clientId))),
        ),
      ),
    });
  });
  return Object.freeze({
    valid: reason === null,
    reason,
    axes,
    counts: Object.freeze({
      clients: Math.min(clients.length, 8),
      web: Math.min(web.length, 8),
      opentui: Math.min(opentui.length, 8),
    }),
    ownerHmac: hmac(
      "authority-assessment-owner",
      [authority?.owners?.input, authority?.owners?.focus, authority?.owners?.geometry].join("\0"),
    ),
    clientsHmac: hmac(
      "authority-assessment-clients",
      JSON.stringify(
        clients
          .map((client) => ({
            clientId: client?.clientId,
            surface: client?.surface,
            state: client?.state,
            connectedRevision: client?.connectedRevision,
          }))
          .sort((left, right) => String(left.clientId).localeCompare(String(right.clientId))),
      ),
    ),
    recordTransitions: Object.freeze(recordTransitions),
    evidence:
      reason === null ? sealCard5TuiFocusAuthority(authority, generation, evidenceKey) : null,
  });
}

/** Exact, bounded and opaque authority topology used by Card5 focus proofs. */
export function sealCard5TuiFocusAuthority(authority, generation, evidenceKey) {
  const exactKeys = (value, keys) =>
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
  if (
    !GENERATION.test(generation ?? "") ||
    authority?.generation !== generation ||
    !HMAC.test(evidenceKey ?? "") ||
    !GENERATION.test(authority?.session ?? "") ||
    !Number.isSafeInteger(authority?.revision) ||
    authority.revision < 0 ||
    !Number.isSafeInteger(authority?.nativeGeometryYieldUntilMs) ||
    authority.nativeGeometryYieldUntilMs < 0 ||
    !Array.isArray(authority?.clients) ||
    authority.clients.length !== 3 ||
    !exactKeys(authority, [
      "generation",
      "session",
      "revision",
      "owners",
      "nativeGeometryYieldUntilMs",
      "clients",
    ]) ||
    !exactKeys(authority.owners, ["input", "focus", "geometry"]) ||
    authority.clients.some(
      (client) =>
        !exactKeys(client, [
          "clientId",
          "surface",
          "state",
          "connectedRevision",
          "activityRevision",
        ]),
    )
  )
    return null;
  const ownerValues = [
    authority.owners?.input,
    authority.owners?.focus,
    authority.owners?.geometry,
  ];
  const validClientId = (value) =>
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 4_096 &&
    !/[\0\r\n]/u.test(value);
  if (ownerValues.some((owner) => owner !== null && !validClientId(owner))) return null;
  const clients = authority.clients.map((client) => ({
    clientId: client?.clientId,
    surface: client?.surface,
    state: client?.state,
    connectedRevision: client?.connectedRevision,
    activityRevision: client?.activityRevision,
  }));
  if (
    clients.some(
      (client) =>
        !validClientId(client.clientId) ||
        !["web", "opentui", "cli", "sdk", "native-tmux", "unknown"].includes(client.surface) ||
        !["foreground", "background"].includes(client.state) ||
        !Number.isSafeInteger(client.connectedRevision) ||
        client.connectedRevision < 1 ||
        !Number.isSafeInteger(client.activityRevision) ||
        client.activityRevision < 0,
    ) ||
    new Set(clients.map(({ clientId }) => clientId)).size !== clients.length
  )
    return null;
  const opentui = clients.filter(({ surface }) => surface === "opentui");
  if (
    opentui.length !== 1 ||
    clients.filter(({ surface }) => surface === "web").length !== 2 ||
    authority.owners.input !== opentui[0].clientId ||
    authority.owners.focus !== opentui[0].clientId
  )
    return null;
  const sortedClients = [...clients].sort((left, right) =>
    left.clientId.localeCompare(right.clientId),
  );
  const semanticTopology = JSON.stringify({
    generation: authority.generation,
    session: authority.session,
    owners: authority.owners,
    nativeGeometryYieldUntilMs: authority.nativeGeometryYieldUntilMs,
    clients: sortedClients.map(({ clientId, surface, state, connectedRevision }) => ({
      clientId,
      surface,
      state,
      connectedRevision,
    })),
  });
  const activityTopology = JSON.stringify({
    revision: authority.revision,
    clients: sortedClients.map(({ clientId, surface, activityRevision }) => ({
      clientId,
      surface,
      activityRevision,
    })),
  });
  const hmac = (domain, value) =>
    createHmac("sha256", Buffer.from(evidenceKey, "hex"))
      .update(`${domain}\0${value}`)
      .digest("hex");
  return Object.freeze({
    authorityRevision: authority.revision,
    authorityOwnerHmac: hmac("focused-authority-owner", opentui[0].clientId),
    authorityTopologyHmac: hmac("focused-authority-topology", semanticTopology),
    authorityHmac: hmac("focused-authority", semanticTopology),
    authorityMutationHmac: hmac("focused-authority-mutation", activityTopology),
  });
}

/** Validate current authority as a causal continuation of one completed handoff. */
export function assessCard5PostHandoffAuthority({
  authority,
  authorityRecords,
  generation,
  expectedClientId,
  expectedSurface,
  grantRevision,
  inputProofHmac,
  evidenceKey,
}) {
  const exactKeys = (value, keys) =>
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
  const validClientId = (value) =>
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 4_096 &&
    !/[\0\r\n]/u.test(value);
  const clients = Array.isArray(authority?.clients) ? authority.clients : [];
  const validAuthority =
    GENERATION.test(generation ?? "") &&
    authority?.generation === generation &&
    GENERATION.test(authority?.session ?? "") &&
    HMAC.test(evidenceKey ?? "") &&
    HMAC.test(inputProofHmac ?? "") &&
    Number.isSafeInteger(grantRevision) &&
    grantRevision >= 0 &&
    Number.isSafeInteger(authority?.revision) &&
    authority.revision >= grantRevision &&
    Number.isSafeInteger(authority?.nativeGeometryYieldUntilMs) &&
    authority.nativeGeometryYieldUntilMs >= 0 &&
    exactKeys(authority, [
      "generation",
      "session",
      "revision",
      "owners",
      "nativeGeometryYieldUntilMs",
      "clients",
    ]) &&
    exactKeys(authority?.owners, ["input", "focus", "geometry"]) &&
    clients.length === 3 &&
    clients.every(
      (client) =>
        exactKeys(client, [
          "clientId",
          "surface",
          "state",
          "connectedRevision",
          "activityRevision",
        ]) &&
        validClientId(client.clientId) &&
        ["web", "opentui"].includes(client.surface) &&
        ["foreground", "background"].includes(client.state) &&
        Number.isSafeInteger(client.connectedRevision) &&
        client.connectedRevision >= 1 &&
        Number.isSafeInteger(client.activityRevision) &&
        client.activityRevision >= 0,
    ) &&
    new Set(clients.map(({ clientId }) => clientId)).size === 3 &&
    clients.filter(({ surface }) => surface === "web").length === 2 &&
    clients.filter(({ surface }) => surface === "opentui").length === 1 &&
    validClientId(expectedClientId) &&
    ["web", "opentui"].includes(expectedSurface) &&
    clients.filter(
      ({ clientId, surface }) => clientId === expectedClientId && surface === expectedSurface,
    ).length === 1;
  if (!validAuthority)
    return Object.freeze({ valid: false, reason: "post-handoff-contract-invalid", evidence: null });
  const records = Array.isArray(authorityRecords) ? authorityRecords : [];
  const recordClientExact = (client) =>
    exactKeys(client, ["clientId", "surface", "state", "connectedRevision", "activityRevision"]) &&
    validClientId(client.clientId) &&
    ["web", "opentui"].includes(client.surface) &&
    ["foreground", "background"].includes(client.state) &&
    Number.isSafeInteger(client.connectedRevision) &&
    client.connectedRevision >= 1 &&
    Number.isSafeInteger(client.activityRevision) &&
    client.activityRevision >= 0;
  const recordTopologyExact = (record) =>
    exactKeys(record, [
      "ordinal",
      "generation",
      "session",
      "revision",
      "nativeGeometryYieldUntilMs",
      "inputOwner",
      "focusOwner",
      "geometryOwner",
      "clients",
    ]) &&
    Number.isSafeInteger(record.ordinal) &&
    record.ordinal >= 1 &&
    record.generation === authority.generation &&
    record.session === authority.session &&
    Number.isSafeInteger(record.revision) &&
    record.revision >= grantRevision &&
    record.revision <= authority.revision &&
    Number.isSafeInteger(record.nativeGeometryYieldUntilMs) &&
    record.nativeGeometryYieldUntilMs >= 0 &&
    Array.isArray(record.clients) &&
    record.clients.length === clients.length &&
    record.clients.every(recordClientExact) &&
    new Set(record.clients.map(({ clientId }) => clientId)).size === clients.length &&
    record.clients.every((recordClient) => {
      const current = clients.find(({ clientId }) => clientId === recordClient.clientId);
      return (
        current !== undefined &&
        recordClient.surface === current.surface &&
        recordClient.connectedRevision === current.connectedRevision
      );
    });
  const firstSelectedIndex = records.findIndex(
    (record) => Number.isSafeInteger(record?.revision) && record.revision >= grantRevision,
  );
  const rawSequence = firstSelectedIndex < 0 ? [] : records.slice(firstSelectedIndex);
  const normalizeRecord = (record) =>
    JSON.stringify({
      generation: record.generation,
      session: record.session,
      revision: record.revision,
      nativeGeometryYieldUntilMs: record.nativeGeometryYieldUntilMs,
      owners: [record.inputOwner, record.focusOwner, record.geometryOwner],
      clients: [...record.clients].sort((left, right) =>
        left.clientId.localeCompare(right.clientId),
      ),
    });
  const rawSequenceExact =
    rawSequence.length > 0 &&
    rawSequence.every(recordTopologyExact) &&
    rawSequence.every(
      (record, index) =>
        index === 0 ||
        (record.ordinal === rawSequence[index - 1].ordinal + 1 &&
          record.revision >= rawSequence[index - 1].revision),
    );
  if (!rawSequenceExact)
    return Object.freeze({
      valid: false,
      reason: "post-handoff-contract-invalid",
      evidence: null,
    });
  const sequence = [];
  const duplicateOrdinals = [];
  let duplicateConflict = false;
  for (const record of rawSequence) {
    const previous = sequence.at(-1);
    if (previous?.revision === record.revision) {
      if (normalizeRecord(previous) !== normalizeRecord(record)) duplicateConflict = true;
      else duplicateOrdinals.push(record.ordinal);
    } else {
      sequence.push(record);
    }
  }
  const strictSequence =
    rawSequenceExact &&
    !duplicateConflict &&
    duplicateOrdinals.length <= 8 &&
    sequence.every(
      (record, index) => index === 0 || record.revision > sequence[index - 1].revision,
    ) &&
    sequence.at(-1)?.revision === authority.revision;
  const grants = sequence.filter(
    (record) => record.revision === grantRevision && record.inputOwner === expectedClientId,
  );
  const grant = grants[0];
  if (
    !strictSequence ||
    grants.length !== 1 ||
    sequence[0] !== grant ||
    !grant.clients.some(
      ({ clientId, surface, state }) =>
        clientId === expectedClientId && surface === expectedSurface && state === "foreground",
    )
  )
    return Object.freeze({ valid: false, reason: "post-handoff-grant-missing", evidence: null });
  const grantClients = new Map(grant.clients.map((client) => [client.clientId, client]));
  let release = null;
  let sequenceValid = true;
  for (const record of sequence) {
    const owners = [record.inputOwner, record.focusOwner, record.geometryOwner];
    const allNull = owners.every((owner) => owner === null);
    const expected = record.clients.find(({ clientId }) => clientId === expectedClientId);
    const otherTopologyStable = record.clients.every((client) => {
      const atGrant = grantClients.get(client.clientId);
      return (
        atGrant !== undefined &&
        client.surface === atGrant.surface &&
        client.connectedRevision === atGrant.connectedRevision &&
        (client.clientId === expectedClientId || client.state === atGrant.state)
      );
    });
    if (!otherTopologyStable) {
      sequenceValid = false;
      break;
    }
    if (allNull) {
      if (expected?.state !== "background") {
        sequenceValid = false;
        break;
      }
      release ??= record;
    } else if (
      release !== null ||
      record.inputOwner !== expectedClientId ||
      ![null, expectedClientId].includes(record.focusOwner) ||
      ![null, expectedClientId].includes(record.geometryOwner) ||
      expected?.state !== "foreground"
    ) {
      sequenceValid = false;
      break;
    }
  }
  const currentOwners = [authority.owners.input, authority.owners.focus, authority.owners.geometry];
  const currentExpected = clients.find(({ clientId }) => clientId === expectedClientId);
  const currentMatchesLast =
    sequence.at(-1).inputOwner === authority.owners.input &&
    sequence.at(-1).focusOwner === authority.owners.focus &&
    sequence.at(-1).geometryOwner === authority.owners.geometry &&
    sequence.at(-1).nativeGeometryYieldUntilMs === authority.nativeGeometryYieldUntilMs &&
    sequence.at(-1).clients.every((recordClient) => {
      const current = clients.find(({ clientId }) => clientId === recordClient.clientId);
      return current !== undefined && JSON.stringify(recordClient) === JSON.stringify(current);
    });
  const retained =
    release === null &&
    authority.owners.input === expectedClientId &&
    currentOwners.every((owner) => owner === null || owner === expectedClientId) &&
    currentExpected?.state === "foreground";
  const released =
    release !== null &&
    currentOwners.every((owner) => owner === null) &&
    currentExpected?.state === "background";
  const relation =
    sequenceValid && currentMatchesLast
      ? retained
        ? "retained-owner"
        : released
          ? "released-null"
          : null
      : null;
  if (relation === null)
    return Object.freeze({
      valid: false,
      reason: "post-handoff-owner-unexplained",
      evidence: null,
    });
  const sortedClients = [...clients].sort((left, right) =>
    left.clientId.localeCompare(right.clientId),
  );
  const semanticTopology = JSON.stringify({
    generation: authority.generation,
    session: authority.session,
    owners: authority.owners,
    nativeGeometryYieldUntilMs: authority.nativeGeometryYieldUntilMs,
    clients: sortedClients.map(({ clientId, surface, state, connectedRevision }) => ({
      clientId,
      surface,
      state,
      connectedRevision,
    })),
  });
  const activityTopology = JSON.stringify({
    revision: authority.revision,
    clients: sortedClients.map(({ clientId, surface, activityRevision }) => ({
      clientId,
      surface,
      activityRevision,
    })),
  });
  const hmac = (domain, value) =>
    createHmac("sha256", Buffer.from(evidenceKey, "hex"))
      .update(`${domain}\0${value}`)
      .digest("hex");
  const duplicateOrdinalHmac = hmac(
    "post-handoff-authority-duplicate-ordinals",
    duplicateOrdinals.join("\0"),
  );
  const normalizedSequence = JSON.stringify({
    records: sequence.map((record) => JSON.parse(normalizeRecord(record))),
    duplicateCount: duplicateOrdinals.length,
    duplicateOrdinalHmac,
  });
  const sequenceHmac = hmac("post-handoff-authority-sequence", normalizedSequence);
  return Object.freeze({
    valid: true,
    reason: null,
    relation,
    evidence: Object.freeze({
      authorityRevision: authority.revision,
      authorityOwnerHmac: hmac("post-handoff-expected-owner", expectedClientId),
      authorityTopologyHmac: hmac("post-handoff-authority-topology", semanticTopology),
      authorityHmac: hmac("post-handoff-authority", semanticTopology),
      authorityMutationHmac: hmac("post-handoff-authority-mutation", activityTopology),
      authorityRelationHmac: hmac(
        "post-handoff-authority-relation",
        [
          relation,
          grantRevision,
          release?.revision ?? authority.revision,
          inputProofHmac,
          sequenceHmac,
        ].join("\0"),
      ),
      authoritySequenceHmac: sequenceHmac,
      authorityDuplicateCount: duplicateOrdinals.length,
      inputProofHmac,
      grantRevision,
      releaseRevision: release?.revision ?? null,
      relation,
    }),
  });
}

/** Select one exact null-to-grant join without conflating client identity with focus epoch. */
export function selectCard5PostInputAuthorityJoin({
  records,
  nullRevision,
  expectedNullAuthority,
  expectedNullEvidence,
  expectedClientId,
  expectedSurface,
  expectedGrantRevision = null,
  expectedGrantRecord = null,
  receiptCandidates = [],
  requireReceipt,
  boundary,
  boundaryOverflow = false,
  evidenceKey,
}) {
  const fail = (observation) =>
    Object.freeze({ passed: false, grant: null, receipt: null, observation });
  const exactKeys = (value, keys) =>
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
  const normalizeClients = (clients) => {
    if (!Array.isArray(clients) || clients.length !== 3) return null;
    const normalized = clients.map((client) =>
      exactKeys(client, [
        "clientId",
        "surface",
        "state",
        "connectedRevision",
        "activityRevision",
      ]) &&
      typeof client.clientId === "string" &&
      client.clientId.length >= 1 &&
      client.clientId.length <= 4_096 &&
      !/[\0\r\n]/u.test(client.clientId) &&
      ["web", "opentui", "cli", "sdk", "native-tmux", "unknown"].includes(client.surface) &&
      ["foreground", "background"].includes(client.state) &&
      Number.isSafeInteger(client.connectedRevision) &&
      client.connectedRevision >= 1 &&
      Number.isSafeInteger(client.activityRevision) &&
      client.activityRevision >= 0
        ? { ...client }
        : null,
    );
    if (
      normalized.includes(null) ||
      new Set(normalized.map((client) => client.clientId)).size !== normalized.length
    )
      return null;
    return normalized.sort((left, right) => left.clientId.localeCompare(right.clientId));
  };
  const normalizeSnapshot = (snapshot) => {
    const clients = normalizeClients(snapshot?.clients);
    if (
      clients === null ||
      !exactKeys(snapshot, [
        "generation",
        "session",
        "revision",
        "owners",
        "nativeGeometryYieldUntilMs",
        "clients",
      ]) ||
      !exactKeys(snapshot?.owners, ["input", "focus", "geometry"]) ||
      !GENERATION.test(snapshot.generation ?? "") ||
      !GENERATION.test(snapshot.session ?? "") ||
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 0 ||
      !Number.isSafeInteger(snapshot.nativeGeometryYieldUntilMs) ||
      snapshot.nativeGeometryYieldUntilMs < 0
    )
      return null;
    return JSON.stringify({
      generation: snapshot.generation,
      session: snapshot.session,
      revision: snapshot.revision,
      nativeGeometryYieldUntilMs: snapshot.nativeGeometryYieldUntilMs,
      inputOwner: snapshot.owners.input,
      focusOwner: snapshot.owners.focus,
      geometryOwner: snapshot.owners.geometry,
      clients,
    });
  };
  const normalizeRecord = (record) => {
    const clients = normalizeClients(record?.clients);
    if (
      clients === null ||
      !exactKeys(record, [
        "ordinal",
        "generation",
        "session",
        "revision",
        "nativeGeometryYieldUntilMs",
        "inputOwner",
        "focusOwner",
        "geometryOwner",
        "clients",
      ]) ||
      !Number.isSafeInteger(record.ordinal) ||
      record.ordinal < 1 ||
      !GENERATION.test(record.generation ?? "") ||
      !GENERATION.test(record.session ?? "") ||
      !Number.isSafeInteger(record.revision) ||
      record.revision < 0 ||
      !Number.isSafeInteger(record.nativeGeometryYieldUntilMs) ||
      record.nativeGeometryYieldUntilMs < 0 ||
      ![record.inputOwner, record.focusOwner, record.geometryOwner].every(
        (owner) => owner === null || (typeof owner === "string" && owner.length >= 1),
      )
    )
      return null;
    return JSON.stringify({
      generation: record.generation,
      session: record.session,
      revision: record.revision,
      nativeGeometryYieldUntilMs: record.nativeGeometryYieldUntilMs,
      inputOwner: record.inputOwner,
      focusOwner: record.focusOwner,
      geometryOwner: record.geometryOwner,
      clients,
    });
  };
  const expectedNullNormalized = normalizeSnapshot(expectedNullAuthority);
  const expectedNullSeal = sealCard5NullAuthority(
    expectedNullAuthority,
    expectedNullAuthority?.generation,
    evidenceKey,
  );
  const expectedNullSealExact =
    expectedNullSeal !== null &&
    exactKeys(expectedNullEvidence, [
      "authorityRevision",
      "authorityOwnerHmac",
      "authorityTopologyHmac",
      "authorityHmac",
      "authorityMutationHmac",
    ]) &&
    Object.keys(expectedNullSeal).every(
      (key) => expectedNullSeal[key] === expectedNullEvidence[key],
    );
  const expectedGrantNormalized =
    expectedGrantRecord === null ? null : normalizeRecord(expectedGrantRecord);
  if (
    !Array.isArray(records) ||
    !records.every((record) => normalizeRecord(record) !== null) ||
    !Number.isSafeInteger(nullRevision) ||
    nullRevision < 0 ||
    expectedNullNormalized === null ||
    !expectedNullSealExact ||
    (expectedGrantRecord !== null && expectedGrantNormalized === null) ||
    typeof expectedClientId !== "string" ||
    expectedClientId.length < 1 ||
    expectedClientId.length > 4_096 ||
    !["opentui", "web"].includes(expectedSurface) ||
    (expectedGrantRevision !== null &&
      (!Number.isSafeInteger(expectedGrantRevision) || expectedGrantRevision <= nullRevision)) ||
    !Array.isArray(receiptCandidates) ||
    !receiptCandidates.every(
      (receipt) =>
        receipt !== null &&
        typeof receipt === "object" &&
        typeof receipt.authorityClientId === "string" &&
        receipt.authorityClientId.length >= 1 &&
        receipt.authorityClientId.length <= 4_096,
    ) ||
    typeof requireReceipt !== "boolean" ||
    (requireReceipt && (expectedGrantNormalized === null || expectedGrantRevision === null)) ||
    !Number.isSafeInteger(boundary) ||
    boundary < 0 ||
    typeof boundaryOverflow !== "boolean" ||
    !HMAC.test(evidenceKey ?? "")
  )
    return fail(
      Object.freeze({
        nullCount: 0,
        nullOverflow: false,
        grantCount: 0,
        grantOverflow: false,
        receiptCount: 0,
        nullExact: false,
        grantExact: false,
        receiptExact: false,
        boundary: Number.isSafeInteger(boundary) ? boundary : null,
        boundaryOverflow: boundaryOverflow === true,
        nullReplayCount: 0,
        nullReplayOrdinalHmac: null,
        grantReplayCount: 0,
        grantReplayOrdinalHmac: null,
        stagingCount: 0,
        stagingOverflow: false,
        stagingExact: false,
        stagingOrdinalHmac: null,
        stagingSequenceHmac: null,
        lastRecords: Object.freeze([]),
      }),
    );
  const nullMatches = records.filter(
    ({ inputOwner, focusOwner, geometryOwner, revision }) =>
      inputOwner === null &&
      focusOwner === null &&
      geometryOwner === null &&
      revision === nullRevision,
  );
  const nullIndexes = nullMatches.map((record) => records.indexOf(record));
  const nullOrdinalsExact = nullMatches.every(
    (record, index) =>
      index === 0 ||
      (nullIndexes[index] === nullIndexes[index - 1] + 1 &&
        record.ordinal === nullMatches[index - 1].ordinal + 1),
  );
  const nullRecordsExact =
    nullMatches.length >= 1 &&
    nullMatches.length <= 8 &&
    nullOrdinalsExact &&
    nullMatches.every((record) => normalizeRecord(record) === expectedNullNormalized);
  const nullIndex = records.indexOf(nullMatches[0]);
  const potentialGrantCandidates = records.filter(
    ({ inputOwner, revision, clients }, index) =>
      index > nullIndex &&
      inputOwner === expectedClientId &&
      (expectedGrantRevision === null || revision === expectedGrantRevision) &&
      Array.isArray(clients) &&
      clients.some(
        ({ clientId, surface }) => clientId === inputOwner && surface === expectedSurface,
      ),
  );
  let grantCandidates;
  if (expectedGrantNormalized !== null) {
    grantCandidates = potentialGrantCandidates.filter(
      (candidate) => normalizeRecord(candidate) === expectedGrantNormalized,
    );
  } else {
    const firstCandidate = potentialGrantCandidates[0];
    const firstCandidateIndex = records.indexOf(firstCandidate);
    const firstCandidateNormalized = normalizeRecord(firstCandidate);
    grantCandidates = [];
    for (let index = firstCandidateIndex; index >= 0 && index < records.length; index += 1) {
      const record = records[index];
      if (normalizeRecord(record) !== firstCandidateNormalized) break;
      grantCandidates.push(record);
    }
  }
  const grantBaseline = expectedGrantNormalized ?? normalizeRecord(grantCandidates[0]);
  const grantIndexes = grantCandidates.map((record) => records.indexOf(record));
  const grantOrdinalsExact = grantCandidates.every(
    (record, index) =>
      index === 0 ||
      (grantIndexes[index] === grantIndexes[index - 1] + 1 &&
        record.ordinal === grantCandidates[index - 1].ordinal + 1),
  );
  const grantRecordExact =
    grantCandidates.length >= 1 &&
    grantCandidates.length <= 8 &&
    grantOrdinalsExact &&
    grantBaseline !== null &&
    grantCandidates.every((candidate) => normalizeRecord(candidate) === grantBaseline);
  const matchingReceipts = receiptCandidates.filter(
    ({ authorityClientId }) => authorityClientId === expectedClientId,
  );
  const hmac = (domain, value) =>
    createHmac("sha256", Buffer.from(evidenceKey, "hex"))
      .update(`${domain}\0${value}`)
      .digest("hex");
  const firstNullIndex = nullIndexes[0] ?? -1;
  const lastGrantIndex = grantIndexes.at(-1) ?? -1;
  const stagingRecords =
    firstNullIndex >= 0 && lastGrantIndex >= firstNullIndex
      ? records.slice(firstNullIndex, lastGrantIndex + 1)
      : [];
  const baseClients = [...(expectedNullAuthority?.clients ?? [])].sort((left, right) =>
    left.clientId.localeCompare(right.clientId),
  );
  const targetBaseIndex = baseClients.findIndex(
    ({ clientId, surface }) => clientId === expectedClientId && surface === expectedSurface,
  );
  const acquired = { inputOwner: false, focusOwner: false, geometryOwner: false };
  let targetForeground = baseClients[targetBaseIndex]?.state === "foreground";
  let targetActivityRevision = baseClients[targetBaseIndex]?.activityRevision ?? -1;
  let priorRevision = null;
  let priorNormalized = null;
  let replayCount = 0;
  const stagingExact =
    stagingRecords.length >= 2 &&
    stagingRecords.length <= 16 &&
    targetBaseIndex >= 0 &&
    stagingRecords.every((record, index) => {
      const normalized = normalizeRecord(record);
      const sortedClients = [...record.clients].sort((left, right) =>
        left.clientId.localeCompare(right.clientId),
      );
      const ordinalExact = index === 0 || record.ordinal === stagingRecords[index - 1].ordinal + 1;
      const revisionExact =
        priorRevision === null ||
        record.revision > priorRevision ||
        (record.revision === priorRevision && normalized === priorNormalized && ++replayCount <= 8);
      const identityExact =
        record.generation === expectedNullAuthority.generation &&
        record.session === expectedNullAuthority.session &&
        record.nativeGeometryYieldUntilMs === expectedNullAuthority.nativeGeometryYieldUntilMs &&
        sortedClients.every(
          (client, clientIndex) =>
            client.clientId === baseClients[clientIndex].clientId &&
            client.surface === baseClients[clientIndex].surface &&
            client.connectedRevision === baseClients[clientIndex].connectedRevision,
        );
      let clientsExact = identityExact;
      for (const [clientIndex, client] of sortedClients.entries()) {
        const base = baseClients[clientIndex];
        if (clientIndex !== targetBaseIndex) {
          clientsExact &&=
            client.state === base.state && client.activityRevision === base.activityRevision;
          continue;
        }
        clientsExact &&= client.activityRevision >= targetActivityRevision;
        if (targetForeground && client.state !== "foreground") clientsExact = false;
        if (client.state === "foreground") targetForeground = true;
        targetActivityRevision = client.activityRevision;
      }
      let ownersExact = true;
      for (const key of ["inputOwner", "focusOwner", "geometryOwner"]) {
        const owner = record[key];
        if (owner !== null && owner !== expectedClientId) ownersExact = false;
        if (acquired[key] && owner !== expectedClientId) ownersExact = false;
        if (owner === expectedClientId) acquired[key] = true;
      }
      priorRevision = record.revision;
      priorNormalized = normalized;
      return ordinalExact && revisionExact && clientsExact && ownersExact;
    }) &&
    replayCount <= 8 &&
    grantRecordExact &&
    normalizeRecord(stagingRecords.at(-1)) === grantBaseline;
  const observation = Object.freeze({
    nullCount: Math.min(nullMatches.length, 8),
    nullOverflow: nullMatches.length > 8,
    grantCount: Math.min(grantCandidates.length, 8),
    grantOverflow: grantCandidates.length > 8,
    receiptCount: Math.min(receiptCandidates.length, 8),
    nullExact: nullRecordsExact,
    grantExact: grantRecordExact,
    receiptExact: requireReceipt
      ? receiptCandidates.length === 1 && matchingReceipts.length === 1
      : receiptCandidates.length === 0,
    boundary: Number.isSafeInteger(boundary) ? boundary : null,
    boundaryOverflow,
    nullReplayCount: Math.max(0, Math.min(nullMatches.length - 1, 7)),
    nullReplayOrdinalHmac: hmac(
      "post-input-null-replay-ordinals",
      nullMatches.map(({ ordinal }) => ordinal).join("\0"),
    ),
    grantReplayCount: Math.max(0, Math.min(grantCandidates.length - 1, 7)),
    grantReplayOrdinalHmac: hmac(
      "post-input-grant-replay-ordinals",
      grantCandidates.map(({ ordinal }) => ordinal).join("\0"),
    ),
    stagingCount: Math.min(stagingRecords.length, 16),
    stagingOverflow: stagingRecords.length > 16,
    stagingExact,
    stagingOrdinalHmac: hmac(
      "post-input-staging-ordinals",
      stagingRecords.map(({ ordinal }) => ordinal).join("\0"),
    ),
    stagingSequenceHmac: hmac(
      "post-input-staging-sequence",
      stagingRecords.map((record) => `${record.ordinal}\0${normalizeRecord(record)}`).join("\0"),
    ),
    lastRecords: Object.freeze(
      records.slice(-2).map((record) =>
        Object.freeze({
          ordinal: Number.isSafeInteger(record?.ordinal) ? record.ordinal : null,
          revision: Number.isSafeInteger(record?.revision) ? record.revision : null,
          ownerHmac: hmac(
            "post-input-authority-owner",
            [record?.inputOwner, record?.focusOwner, record?.geometryOwner].join("\0"),
          ),
          topologyHmac: hmac(
            "post-input-authority-topology",
            JSON.stringify(record?.clients ?? null),
          ),
        }),
      ),
    ),
  });
  const passed =
    !boundaryOverflow &&
    observation.nullExact &&
    observation.grantExact &&
    stagingExact &&
    observation.receiptExact &&
    nullIndex >= 0;
  return passed
    ? Object.freeze({
        passed: true,
        grant: grantCandidates[0],
        receipt: requireReceipt ? matchingReceipts[0] : null,
        observation,
      })
    : fail(observation);
}

const CARD5_POST_INPUT_PRECONDITION_REASONS = Object.freeze([
  "receipt-missing",
  "receipt-ambiguous",
  "receipt-invalid",
  "receipt-target-mismatch",
  "web-observation-invalid",
  "web-observation-timeout",
  "web-current-mismatch",
  "target-web-absent",
  "target-web-wrong-surface",
  "input-owner-mismatch",
  "focus-owner-mismatch",
  "geometry-owner-mismatch",
  "current-revision-mismatch",
  "current-generation-mismatch",
  "current-session-mismatch",
  "current-native-yield-mismatch",
  "current-topology-mismatch",
  "terminal-record-missing",
  "terminal-record-mismatch",
  "boundary-overflow",
  "selector-contract-invalid",
]);

/**
 * Project the producer-side prerequisites for the strict post-input selector.
 * This function is diagnostic only: callers must continue to use
 * selectCard5PostInputAuthorityJoin as the acceptance decision.
 */
export function boundedCard5PostInputAuthorityPreconditionObservation({
  webResults,
  receiptPage,
  receiptBoundary,
  rawReceipts,
  receiptCandidates,
  expectedInputSha256,
  expectedRequestHmac,
  requireReceipt,
  expectedPane,
  expectedGeneration,
  expectedBaselineAuthority,
  expectedClientId,
  expectedSurface,
  expectedGrantRecord,
  authorityRecords,
  authorityBoundary,
  boundaryOverflow,
  evidenceKey,
}) {
  const exactKeys = (value, keys) =>
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
  const safeIdentity = (value) =>
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 4_096 &&
    !/[\0\r\n]/u.test(value);
  const hmac = (domain, value) =>
    HMAC.test(evidenceKey ?? "")
      ? createHmac("sha256", Buffer.from(evidenceKey, "hex"))
          .update(`${domain}\0${String(value)}`)
          .digest("hex")
      : null;
  const normalizeClients = (clients) => {
    if (!Array.isArray(clients) || clients.length !== 3) return null;
    const normalized = clients.map((client) =>
      exactKeys(client, [
        "clientId",
        "surface",
        "state",
        "connectedRevision",
        "activityRevision",
      ]) &&
      safeIdentity(client.clientId) &&
      ["web", "opentui", "cli", "sdk", "native-tmux", "unknown"].includes(client.surface) &&
      ["foreground", "background"].includes(client.state) &&
      Number.isSafeInteger(client.connectedRevision) &&
      client.connectedRevision >= 1 &&
      Number.isSafeInteger(client.activityRevision) &&
      client.activityRevision >= 0
        ? { ...client }
        : null,
    );
    if (
      normalized.includes(null) ||
      new Set(normalized.map((client) => client.clientId)).size !== normalized.length
    )
      return null;
    return normalized;
  };
  const normalizeAuthority = (authority) => {
    const clients = normalizeClients(authority?.clients);
    if (
      clients === null ||
      !exactKeys(authority, [
        "generation",
        "session",
        "revision",
        "owners",
        "nativeGeometryYieldUntilMs",
        "clients",
      ]) ||
      !exactKeys(authority?.owners, ["input", "focus", "geometry"]) ||
      !GENERATION.test(authority.generation ?? "") ||
      !GENERATION.test(authority.session ?? "") ||
      !Number.isSafeInteger(authority.revision) ||
      authority.revision < 0 ||
      !Number.isSafeInteger(authority.nativeGeometryYieldUntilMs) ||
      authority.nativeGeometryYieldUntilMs < 0 ||
      ![authority.owners.input, authority.owners.focus, authority.owners.geometry].every(
        (owner) => owner === null || safeIdentity(owner),
      )
    )
      return null;
    return Object.freeze({
      generation: authority.generation,
      session: authority.session,
      revision: authority.revision,
      nativeGeometryYieldUntilMs: authority.nativeGeometryYieldUntilMs,
      owners: Object.freeze({ ...authority.owners }),
      clients: Object.freeze(clients),
    });
  };
  const normalizeRecord = (record) => {
    const authority = normalizeAuthority(
      record && typeof record === "object"
        ? {
            generation: record.generation,
            session: record.session,
            revision: record.revision,
            nativeGeometryYieldUntilMs: record.nativeGeometryYieldUntilMs,
            owners: {
              input: record.inputOwner,
              focus: record.focusOwner,
              geometry: record.geometryOwner,
            },
            clients: record.clients,
          }
        : null,
    );
    return authority !== null &&
      exactKeys(record, [
        "ordinal",
        "generation",
        "session",
        "revision",
        "nativeGeometryYieldUntilMs",
        "inputOwner",
        "focusOwner",
        "geometryOwner",
        "clients",
      ]) &&
      Number.isSafeInteger(record.ordinal) &&
      record.ordinal >= 1
      ? Object.freeze({ ordinal: record.ordinal, authority })
      : null;
  };
  const expectedBaseline = normalizeAuthority(expectedBaselineAuthority);
  const contractValid =
    Array.isArray(webResults) &&
    webResults.length === 2 &&
    ["none", "chromium", "electron"].includes(receiptPage) &&
    Number.isSafeInteger(receiptBoundary) &&
    receiptBoundary >= 0 &&
    Array.isArray(rawReceipts) &&
    Array.isArray(receiptCandidates) &&
    /^[0-9a-f]{64}$/u.test(expectedInputSha256 ?? "") &&
    (expectedRequestHmac === null || HMAC.test(expectedRequestHmac ?? "")) &&
    typeof requireReceipt === "boolean" &&
    safeIdentity(expectedPane) &&
    GENERATION.test(expectedGeneration ?? "") &&
    expectedBaseline !== null &&
    expectedBaseline.generation === expectedGeneration &&
    (expectedClientId === null || safeIdentity(expectedClientId)) &&
    ["opentui", "web"].includes(expectedSurface) &&
    Array.isArray(authorityRecords) &&
    Number.isSafeInteger(authorityBoundary) &&
    authorityBoundary >= 0 &&
    typeof boundaryOverflow === "boolean" &&
    HMAC.test(evidenceKey ?? "");
  const statuses = contractValid
    ? webResults.map((result) =>
        exactKeys(result, ["status", "value"]) &&
        ["ok", "deadline", "source-unavailable", "clock-invalid"].includes(result.status)
          ? result.status
          : "source-unavailable",
      )
    : ["source-unavailable", "source-unavailable"];
  const values = contractValid
    ? webResults.map((result, index) => (statuses[index] === "ok" ? result.value : null))
    : [null, null];
  const authorities = values.map((value) =>
    normalizeAuthority(value?.workspaceEvidence?.authority),
  );
  const normalizedAuthority = authorities.map((authority) =>
    authority === null ? null : JSON.stringify(authority),
  );
  const currentExact =
    authorities.every((authority) => authority !== null) &&
    normalizedAuthority[0] === normalizedAuthority[1];
  const current = currentExact ? authorities[0] : null;
  const expectedGrant = normalizeRecord(expectedGrantRecord);
  const normalizedRecords = contractValid ? authorityRecords.map(normalizeRecord) : [];
  const terminalRecords =
    expectedGrant === null
      ? []
      : normalizedRecords.filter(
          (record) =>
            record !== null &&
            JSON.stringify(record.authority) === JSON.stringify(expectedGrant.authority),
        );
  const receiptExactShape = (receipt) =>
    exactKeys(receipt, [
      "generation",
      "pane",
      "seq",
      "inputSha256",
      "requestId",
      "authorityClientId",
      "ordinal",
    ]) &&
    GENERATION.test(receipt.generation ?? "") &&
    safeIdentity(receipt.pane) &&
    Number.isSafeInteger(receipt.seq) &&
    receipt.seq >= 0 &&
    /^[0-9a-f]{64}$/u.test(receipt.inputSha256 ?? "") &&
    safeIdentity(receipt.requestId) &&
    safeIdentity(receipt.authorityClientId) &&
    Number.isSafeInteger(receipt.ordinal) &&
    receipt.ordinal >= 0;
  const postBoundaryReceipts = contractValid
    ? rawReceipts.filter(
        (receipt) => Number.isSafeInteger(receipt?.ordinal) && receipt.ordinal >= receiptBoundary,
      )
    : [];
  const validPostBoundaryReceipts = postBoundaryReceipts.filter(receiptExactShape);
  const producerFilteredReceipts = validPostBoundaryReceipts.filter(
    (receipt) =>
      receipt.generation === expectedGeneration &&
      receipt.pane === expectedPane &&
      receipt.inputSha256 === expectedInputSha256 &&
      expectedRequestHmac !== null &&
      hmac("request", receipt.requestId) === expectedRequestHmac,
  );
  const receiptCandidatesExact =
    receiptCandidates.every(receiptExactShape) &&
    JSON.stringify(receiptCandidates) === JSON.stringify(producerFilteredReceipts);
  const receiptInputMismatch = validPostBoundaryReceipts.some(
    (receipt) =>
      receipt.generation === expectedGeneration &&
      receipt.pane === expectedPane &&
      receipt.inputSha256 !== expectedInputSha256,
  );
  const receiptRequestMismatch = validPostBoundaryReceipts.some(
    (receipt) =>
      receipt.generation === expectedGeneration &&
      receipt.pane === expectedPane &&
      receipt.inputSha256 === expectedInputSha256 &&
      (expectedRequestHmac === null || hmac("request", receipt.requestId) !== expectedRequestHmac),
  );
  const matchingReceiptCount = receiptCandidates.filter(
    (receipt) => receiptExactShape(receipt) && receipt.authorityClientId === expectedClientId,
  ).length;
  const targetClient =
    current?.clients.find(({ clientId }) => clientId === expectedClientId) ?? null;
  const currentTerminalRecords =
    current === null
      ? []
      : normalizedRecords.filter(
          (record) =>
            record !== null && JSON.stringify(record.authority) === JSON.stringify(current),
        );
  const identityTopology = (authority) =>
    JSON.stringify(
      authority?.clients?.map(({ clientId, surface, connectedRevision }) => ({
        clientId,
        surface,
        connectedRevision,
      })) ?? null,
    );
  const currentAllExpected =
    current !== null &&
    expectedClientId !== null &&
    [current.owners.input, current.owners.focus, current.owners.geometry].every(
      (owner) => owner === expectedClientId,
    );
  const axes = Object.freeze({
    selectorContractInvalid:
      !contractValid ||
      (requireReceipt &&
        currentAllExpected &&
        expectedGrant === null &&
        currentTerminalRecords.length > 0),
    webObservationTimeout: statuses.some((status) => status === "deadline"),
    webObservationInvalid:
      statuses.some((status) => !["ok", "deadline"].includes(status)) ||
      values.some(
        (value, index) =>
          value === null ||
          typeof value !== "object" ||
          value.semanticPaneId !== expectedPane ||
          value.generation !== expectedGeneration ||
          authorities[index] === null,
      ),
    webCurrentMismatch: authorities.every((authority) => authority !== null) && !currentExact,
    receiptMissing: requireReceipt && receiptCandidates.length === 0,
    receiptAmbiguous: requireReceipt && receiptCandidates.length > 1,
    receiptRawInvalid:
      requireReceipt && validPostBoundaryReceipts.length !== postBoundaryReceipts.length,
    receiptInputMismatch: requireReceipt && receiptInputMismatch,
    receiptRequestMismatch: requireReceipt && receiptRequestMismatch,
    receiptCandidateMismatch: requireReceipt && !receiptCandidatesExact,
    receiptInvalid:
      requireReceipt &&
      (expectedRequestHmac === null ||
        validPostBoundaryReceipts.length !== postBoundaryReceipts.length ||
        receiptInputMismatch ||
        receiptRequestMismatch ||
        !receiptCandidatesExact),
    receiptTargetMismatch:
      requireReceipt && receiptCandidates.length === 1 && matchingReceiptCount !== 1,
    targetWebAbsent: expectedSurface === "web" && current !== null && targetClient === null,
    targetWebWrongSurface:
      expectedSurface === "web" && targetClient !== null && targetClient.surface !== "web",
    inputOwnerMismatch:
      current !== null && expectedClientId !== null && current.owners.input !== expectedClientId,
    focusOwnerMismatch:
      current !== null && expectedClientId !== null && current.owners.focus !== expectedClientId,
    geometryOwnerMismatch:
      current !== null && expectedClientId !== null && current.owners.geometry !== expectedClientId,
    currentRevisionMismatch:
      current !== null &&
      (current.revision <= (expectedBaseline?.revision ?? Number.MAX_SAFE_INTEGER) ||
        (expectedGrant !== null && current.revision !== expectedGrant.authority.revision)),
    currentGenerationMismatch:
      current !== null &&
      (current.generation !== expectedGeneration ||
        (expectedGrant !== null && current.generation !== expectedGrant.authority.generation)),
    currentSessionMismatch:
      current !== null &&
      (current.session !== expectedBaseline?.session ||
        (expectedGrant !== null && current.session !== expectedGrant.authority.session)),
    currentNativeYieldMismatch:
      current !== null &&
      (current.nativeGeometryYieldUntilMs !== expectedBaseline?.nativeGeometryYieldUntilMs ||
        (expectedGrant !== null &&
          current.nativeGeometryYieldUntilMs !==
            expectedGrant.authority.nativeGeometryYieldUntilMs)),
    currentTopologyMismatch:
      current !== null &&
      (identityTopology(current) !== identityTopology(expectedBaseline) ||
        (expectedGrant !== null &&
          JSON.stringify(current.clients) !== JSON.stringify(expectedGrant.authority.clients))),
    terminalRecordMissing: currentAllExpected && currentTerminalRecords.length === 0,
    terminalRecordMismatch:
      expectedGrant !== null &&
      terminalRecords.length > 0 &&
      !terminalRecords.some(({ ordinal }) => ordinal === expectedGrant.ordinal),
    boundaryOverflow,
  });
  const reasonByAxis = [
    ["selectorContractInvalid", "selector-contract-invalid"],
    ["webObservationTimeout", "web-observation-timeout"],
    ["webObservationInvalid", "web-observation-invalid"],
    ["webCurrentMismatch", "web-current-mismatch"],
    ["receiptInvalid", "receipt-invalid"],
    ["receiptMissing", "receipt-missing"],
    ["receiptAmbiguous", "receipt-ambiguous"],
    ["receiptTargetMismatch", "receipt-target-mismatch"],
    ["targetWebAbsent", "target-web-absent"],
    ["targetWebWrongSurface", "target-web-wrong-surface"],
    ["inputOwnerMismatch", "input-owner-mismatch"],
    ["focusOwnerMismatch", "focus-owner-mismatch"],
    ["geometryOwnerMismatch", "geometry-owner-mismatch"],
    ["currentRevisionMismatch", "current-revision-mismatch"],
    ["currentGenerationMismatch", "current-generation-mismatch"],
    ["currentSessionMismatch", "current-session-mismatch"],
    ["currentNativeYieldMismatch", "current-native-yield-mismatch"],
    ["currentTopologyMismatch", "current-topology-mismatch"],
    ["terminalRecordMissing", "terminal-record-missing"],
    ["terminalRecordMismatch", "terminal-record-mismatch"],
    ["boundaryOverflow", "boundary-overflow"],
  ];
  const reason = reasonByAxis.find(([axis]) => axes[axis])?.[1] ?? null;
  const authorityProjection = (authority, index) =>
    Object.freeze({
      page: index === 0 ? "chromium" : "electron",
      status: statuses[index],
      valid: authority !== null,
      paneHmac: hmac("post-input-web-pane", values[index]?.semanticPaneId ?? "invalid"),
      generationHmac: hmac("post-input-web-generation", authority?.generation ?? "invalid"),
      sessionHmac: hmac("post-input-web-session", authority?.session ?? "invalid"),
      revision: Number.isSafeInteger(authority?.revision) ? authority.revision : null,
      ownerHmac: hmac("post-input-web-owners", JSON.stringify(authority?.owners ?? null)),
      topologyHmac: hmac("post-input-web-topology", JSON.stringify(authority?.clients ?? null)),
      mutationHmac: hmac(
        "post-input-web-mutation",
        JSON.stringify(
          authority?.clients?.map(({ clientId, state, activityRevision }) => ({
            clientId,
            state,
            activityRevision,
          })) ?? null,
        ),
      ),
    });
  const boundedReceipts = postBoundaryReceipts.slice(-8);
  const safeAuthorityRecords = Array.isArray(authorityRecords) ? authorityRecords : [];
  const boundedRecords = safeAuthorityRecords.slice(-2);
  return Object.freeze({
    reason:
      reason === null || CARD5_POST_INPUT_PRECONDITION_REASONS.includes(reason)
        ? reason
        : "selector-contract-invalid",
    axes,
    web: Object.freeze(authorities.map(authorityProjection)),
    receipt: Object.freeze({
      page: receiptPage,
      count: Math.min(postBoundaryReceipts.length, 8),
      overflow: postBoundaryReceipts.length > 8,
      validCount: Math.min(validPostBoundaryReceipts.length, 8),
      rawInvalidCount: Math.min(postBoundaryReceipts.length - validPostBoundaryReceipts.length, 8),
      unrelatedCount: Math.min(
        validPostBoundaryReceipts.length - producerFilteredReceipts.length,
        8,
      ),
      candidateCount: Math.min(receiptCandidates.length, 8),
      candidateOverflow: receiptCandidates.length > 8,
      candidateExact: receiptCandidatesExact,
      matchingCount: Math.min(matchingReceiptCount, 8),
      pageHmac: hmac("post-input-receipt-page", receiptPage),
      clientHmac: hmac(
        "post-input-receipt-client",
        boundedReceipts.map((receipt) => receipt?.authorityClientId ?? "invalid").join("\0"),
      ),
      requestHmac: hmac(
        "post-input-receipt-request",
        boundedReceipts.map((receipt) => receipt?.requestId ?? "invalid").join("\0"),
      ),
      paneHmac: hmac(
        "post-input-receipt-pane",
        boundedReceipts.map((receipt) => receipt?.pane ?? "invalid").join("\0"),
      ),
      generationHmac: hmac(
        "post-input-receipt-generation",
        boundedReceipts.map((receipt) => receipt?.generation ?? "invalid").join("\0"),
      ),
    }),
    records: Object.freeze({
      count: Math.min(safeAuthorityRecords.length, 16),
      overflow: safeAuthorityRecords.length > 16 || boundaryOverflow === true,
      last: Object.freeze(
        boundedRecords.map((record) =>
          Object.freeze({
            ordinal: Number.isSafeInteger(record?.ordinal) ? record.ordinal : null,
            revision: Number.isSafeInteger(record?.revision) ? record.revision : null,
            ownerHmac: hmac(
              "post-input-precondition-record-owner",
              [record?.inputOwner, record?.focusOwner, record?.geometryOwner].join("\0"),
            ),
            topologyHmac: hmac(
              "post-input-precondition-record-topology",
              JSON.stringify(normalizeClients(record?.clients)),
            ),
            recordHmac: hmac(
              "post-input-precondition-record",
              JSON.stringify(normalizeRecord(record)),
            ),
          }),
        ),
      ),
    }),
  });
}

/** Retains causal post-input samples so a terminal deadline cannot erase them. */
export function advanceCard5PostInputAuthorityPreconditionHistory(
  previous,
  observation,
  webResults,
) {
  const prior = previous ?? {
    firstInformative: null,
    lastSuccessful: null,
    terminal: null,
  };
  const statuses = Array.isArray(webResults) ? webResults.map((result) => result?.status) : [];
  const informative = observation?.reason !== "web-observation-timeout";
  const successful = statuses.length === 2 && statuses.every((status) => status === "ok");
  return Object.freeze({
    firstInformative: prior.firstInformative ?? (informative ? observation : null),
    lastSuccessful: successful ? observation : prior.lastSuccessful,
    terminal: observation,
  });
}

/** Exact null-owner authority snapshot used before an explicit focus epoch. */
export function sealCard5NullAuthority(authority, generation, evidenceKey) {
  const exactKeys = (value, keys) =>
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
  const validClientId = (value) =>
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 4_096 &&
    !/[\0\r\n]/u.test(value);
  if (
    !GENERATION.test(generation ?? "") ||
    authority?.generation !== generation ||
    !HMAC.test(evidenceKey ?? "") ||
    !GENERATION.test(authority?.session ?? "") ||
    !Number.isSafeInteger(authority?.revision) ||
    authority.revision < 0 ||
    !Number.isSafeInteger(authority?.nativeGeometryYieldUntilMs) ||
    authority.nativeGeometryYieldUntilMs < 0 ||
    !exactKeys(authority, [
      "generation",
      "session",
      "revision",
      "owners",
      "nativeGeometryYieldUntilMs",
      "clients",
    ]) ||
    !exactKeys(authority?.owners, ["input", "focus", "geometry"]) ||
    !["input", "focus", "geometry"].every((kind) => authority.owners[kind] === null) ||
    !Array.isArray(authority.clients) ||
    authority.clients.length !== 3
  )
    return null;
  const clients = authority.clients.map((client) => ({
    clientId: client?.clientId,
    surface: client?.surface,
    state: client?.state,
    connectedRevision: client?.connectedRevision,
    activityRevision: client?.activityRevision,
    exact: exactKeys(client, [
      "clientId",
      "surface",
      "state",
      "connectedRevision",
      "activityRevision",
    ]),
  }));
  if (
    clients.some(
      (client) =>
        !client.exact ||
        !validClientId(client.clientId) ||
        !["web", "opentui", "cli", "sdk", "native-tmux", "unknown"].includes(client.surface) ||
        !["foreground", "background"].includes(client.state) ||
        !Number.isSafeInteger(client.connectedRevision) ||
        client.connectedRevision < 1 ||
        !Number.isSafeInteger(client.activityRevision) ||
        client.activityRevision < 0,
    ) ||
    new Set(clients.map(({ clientId }) => clientId)).size !== clients.length ||
    clients.filter(({ surface }) => surface === "opentui").length !== 1 ||
    clients.filter(({ surface }) => surface === "web").length !== 2
  )
    return null;
  const sortedClients = [...clients].sort((left, right) =>
    left.clientId.localeCompare(right.clientId),
  );
  const semanticTopology = JSON.stringify({
    generation: authority.generation,
    session: authority.session,
    owners: authority.owners,
    nativeGeometryYieldUntilMs: authority.nativeGeometryYieldUntilMs,
    clients: sortedClients.map(({ clientId, surface, state, connectedRevision }) => ({
      clientId,
      surface,
      state,
      connectedRevision,
    })),
  });
  const mutationTopology = JSON.stringify({
    revision: authority.revision,
    clients: sortedClients.map(({ clientId, surface, activityRevision }) => ({
      clientId,
      surface,
      activityRevision,
    })),
  });
  const hmac = (domain, value) =>
    createHmac("sha256", Buffer.from(evidenceKey, "hex"))
      .update(`${domain}\0${value}`)
      .digest("hex");
  return Object.freeze({
    authorityRevision: authority.revision,
    authorityOwnerHmac: hmac("null-authority-owner", "none"),
    authorityTopologyHmac: hmac("null-authority-topology", semanticTopology),
    authorityHmac: hmac("null-authority", semanticTopology),
    authorityMutationHmac: hmac("null-authority-mutation", mutationTopology),
  });
}

/** Bounded reason vector for the two-view exact null-authority join. */
export function assessCard5NullAuthorityPair({
  authorities,
  generations,
  minimumRevision,
  releaseRevisions = [],
  evidenceKey,
}) {
  const hmac = (domain, value) =>
    typeof value === "string" && value.length > 0 && HMAC.test(evidenceKey ?? "")
      ? createHmac("sha256", Buffer.from(evidenceKey, "hex"))
          .update(`${domain}\0${value}`)
          .digest("hex")
      : null;
  const exactKeys = (value, keys) =>
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
  const classify = (authority, generation) => {
    let reason = "exact";
    if (authority === null || typeof authority !== "object") reason = "authority-missing";
    else if (!GENERATION.test(generation ?? "") || authority.generation !== generation)
      reason = "generation-mismatch";
    else if (!GENERATION.test(authority.session ?? "")) reason = "session-invalid";
    else if (!Number.isSafeInteger(authority.revision) || authority.revision < 0)
      reason = "revision-invalid";
    else if (
      !exactKeys(authority, [
        "generation",
        "session",
        "revision",
        "owners",
        "nativeGeometryYieldUntilMs",
        "clients",
      ]) ||
      !exactKeys(authority.owners, ["input", "focus", "geometry"])
    )
      reason = "schema-invalid";
    else if (
      ![authority.owners.input, authority.owners.focus, authority.owners.geometry].every(
        (owner) => owner === null,
      )
    )
      reason = "owner-nonnull";
    else if (!Array.isArray(authority.clients) || authority.clients.length !== 3)
      reason = "client-cardinality";
    const sealed =
      reason === "exact" ? sealCard5NullAuthority(authority, generation, evidenceKey) : null;
    if (reason === "exact" && sealed === null) reason = "client-schema-invalid";
    return Object.freeze({
      reason,
      revision:
        Number.isSafeInteger(authority?.revision) && authority.revision >= 0
          ? Math.min(authority.revision, 0xffff_ffff)
          : null,
      generationHmac: hmac("null-view-generation", authority?.generation),
      sessionHmac: hmac("null-view-session", authority?.session),
      ownerState: exactKeys(authority?.owners, ["input", "focus", "geometry"])
        ? Object.freeze({
            input: authority.owners.input === null,
            focus: authority.owners.focus === null,
            geometry: authority.owners.geometry === null,
          })
        : null,
      clientCount: Array.isArray(authority?.clients) ? Math.min(authority.clients.length, 4) : null,
      sealed,
    });
  };
  if (
    !Array.isArray(authorities) ||
    authorities.length !== 2 ||
    !Array.isArray(generations) ||
    generations.length !== 2 ||
    !Number.isSafeInteger(minimumRevision) ||
    minimumRevision < 0 ||
    !Array.isArray(releaseRevisions) ||
    releaseRevisions.length > 4 ||
    releaseRevisions.some((revision) => !Number.isSafeInteger(revision) || revision < 0) ||
    !HMAC.test(evidenceKey ?? "")
  ) {
    return Object.freeze({ passed: false, reason: "contract-invalid", evidence: null });
  }
  const views = authorities.map((authority, index) => classify(authority, generations[index]));
  let reason = views.find((view) => view.reason !== "exact")?.reason ?? null;
  const [left, right] = views.map((view) => view.sealed);
  const requiredReleaseRevision = Math.max(minimumRevision, ...releaseRevisions);
  if (reason === null && left.authorityRevision <= minimumRevision)
    reason = "revision-not-advanced";
  else if (reason === null && left.authorityRevision < requiredReleaseRevision)
    reason = "release-revision-not-settled";
  else if (reason === null && left.authorityRevision !== right.authorityRevision)
    reason = "cross-revision";
  else if (reason === null && left.authorityHmac !== right.authorityHmac)
    reason = "cross-authority";
  else if (reason === null && left.authorityOwnerHmac !== right.authorityOwnerHmac)
    reason = "cross-owner";
  else if (reason === null && left.authorityTopologyHmac !== right.authorityTopologyHmac)
    reason = "cross-topology";
  else if (reason === null && left.authorityMutationHmac !== right.authorityMutationHmac)
    reason = "cross-mutation";
  const observation = Object.freeze({
    reason: reason ?? "exact",
    views: Object.freeze(
      views.map(
        ({ reason: viewReason, revision, generationHmac, sessionHmac, ownerState, clientCount }) =>
          Object.freeze({
            reason: viewReason,
            revision,
            generationHmac,
            sessionHmac,
            ownerState,
            clientCount,
          }),
      ),
    ),
  });
  return reason === null
    ? Object.freeze({ passed: true, reason: null, evidence: left, observation })
    : Object.freeze({ passed: false, reason, evidence: null, observation });
}

export function mergeCard5SemanticAuthorityEvidence(left, right, previousRevision = null) {
  const exact = (value) =>
    HMAC.test(value?.authorityHmac ?? "") &&
    HMAC.test(value?.authorityOwnerHmac ?? "") &&
    HMAC.test(value?.authorityTopologyHmac ?? "") &&
    HMAC.test(value?.authorityMutationHmac ?? "") &&
    Number.isSafeInteger(value?.authorityRevision) &&
    value.authorityRevision >= 0;
  if (!exact(left) || !exact(right)) {
    return Object.freeze({ status: "invalid", evidence: null });
  }
  if (
    left.authorityHmac !== right.authorityHmac ||
    left.authorityOwnerHmac !== right.authorityOwnerHmac ||
    left.authorityTopologyHmac !== right.authorityTopologyHmac
  ) {
    return Object.freeze({ status: "semantic-mismatch", evidence: null });
  }
  const authorityRevision = Math.max(left.authorityRevision, right.authorityRevision);
  if (
    previousRevision !== null &&
    (!Number.isSafeInteger(previousRevision) ||
      previousRevision < 0 ||
      authorityRevision < previousRevision)
  ) {
    return Object.freeze({ status: "revision-regressed", evidence: null });
  }
  const latest = left.authorityRevision >= right.authorityRevision ? left : right;
  return Object.freeze({
    status: "exact",
    evidence: Object.freeze({
      ...left,
      authorityRevision,
      authorityMutationHmac: latest.authorityMutationHmac,
    }),
  });
}

export function card5AuthorityActivityWithinCap(activity, cap = 64) {
  const exactKeys = (value, keys) =>
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
  if (
    !exactKeys(activity, ["count", "overflow", "events", "geometrySettlements"]) ||
    !Number.isSafeInteger(cap) ||
    cap < 1 ||
    cap > 64 ||
    !Number.isSafeInteger(activity?.count) ||
    activity.count < 0 ||
    activity.count > cap ||
    activity?.overflow !== false ||
    !Array.isArray(activity?.events) ||
    activity.events.length !== activity.count
  )
    return false;
  const HMAC = /^[0-9a-f]{64}$/u;
  const geometryOutcomes = new Set([
    "ok",
    "geometry-authority-conflict",
    "authority-timeout",
    "viewport-timeout",
    "stream-closed",
    "lifecycle-retired",
    "failed",
  ]);
  let pendingGeometry = null;
  let geometryOperationOrdinal = 0;
  const successfulGeometry = [];
  for (const [index, event] of activity.events.entries()) {
    if (
      !exactKeys(event, [
        "ordinal",
        "surface",
        "kind",
        "outcome",
        "operationOrdinal",
        "dimensionsHmac",
      ]) ||
      event.ordinal !== index + 1 ||
      !["web", "opentui"].includes(event.surface) ||
      !["focus", "geometry", "input"].includes(event.kind)
    )
      return false;
    if (event.surface === "opentui" && event.kind !== "focus") return false;
    if (event.kind !== "geometry") {
      if (
        pendingGeometry !== null ||
        event.outcome !== "ok" ||
        event.operationOrdinal !== null ||
        event.dimensionsHmac !== null
      )
        return false;
      continue;
    }
    if (
      !HMAC.test(event.dimensionsHmac ?? "") ||
      !Number.isSafeInteger(event.operationOrdinal) ||
      event.operationOrdinal < 1
    )
      return false;
    if (event.outcome === "attempt") {
      if (pendingGeometry !== null) return false;
      geometryOperationOrdinal += 1;
      if (event.operationOrdinal !== geometryOperationOrdinal) return false;
      pendingGeometry = Object.freeze({
        operationOrdinal: event.operationOrdinal,
        dimensionsHmac: event.dimensionsHmac,
      });
      continue;
    }
    if (
      pendingGeometry === null ||
      event.operationOrdinal !== pendingGeometry.operationOrdinal ||
      event.dimensionsHmac !== pendingGeometry.dimensionsHmac ||
      !geometryOutcomes.has(event.outcome)
    )
      return false;
    if (event.outcome === "ok") successfulGeometry.push(event);
    pendingGeometry = null;
  }
  // A single final attempt may still be in flight while the bounded observer
  // samples; every other attempt must have one adjacent terminal outcome.
  const settlements = activity.geometrySettlements;
  if (
    !Array.isArray(settlements) ||
    settlements.length !== successfulGeometry.length ||
    settlements.length > 16
  )
    return false;
  const requestHmacs = new Set();
  for (const [index, receipt] of settlements.entries()) {
    if (
      !exactKeys(receipt, [
        "ordinal",
        "operationOrdinal",
        "requestHmac",
        "clientHmac",
        "dimensionsHmac",
      ]) ||
      receipt.ordinal !== index ||
      receipt.operationOrdinal !== successfulGeometry[index]?.operationOrdinal ||
      receipt.dimensionsHmac !== successfulGeometry[index]?.dimensionsHmac ||
      !HMAC.test(receipt.requestHmac ?? "") ||
      !HMAC.test(receipt.clientHmac ?? "") ||
      requestHmacs.has(receipt.requestHmac)
    )
      return false;
    requestHmacs.add(receipt.requestHmac);
  }
  return true;
}

const CARD5_AUTHORITY_KINDS = Object.freeze(["input", "focus", "geometry"]);

/**
 * Fail-closed validation plus a bounded, identity-free projection of the exact
 * Web authority-release transaction. The `passed` predicate intentionally
 * mirrors the ProductRig acceptance contract; the projection exists only so a
 * terminal failure retains the rejected conjunct.
 */
export function assessCard5WebAuthorityRelease({
  results,
  expectedAuthorities,
  workspaceHmac,
  generationHmac,
  runtimeSessionHmac,
  paneHmac,
  requestHmacs,
  clientHmacs,
}) {
  const expected = Array.isArray(expectedAuthorities)
    ? expectedAuthorities.filter((authority) => CARD5_AUTHORITY_KINDS.includes(authority))
    : [];
  const expectedSet = new Set(expected);
  const expectedValid =
    expected.length === new Set(expected).size &&
    expected.length <= CARD5_AUTHORITY_KINDS.length &&
    HMAC.test(workspaceHmac ?? "") &&
    HMAC.test(generationHmac ?? "") &&
    HMAC.test(runtimeSessionHmac ?? "") &&
    HMAC.test(paneHmac ?? "") &&
    Array.isArray(requestHmacs) &&
    requestHmacs.length > 0 &&
    requestHmacs.length <= 2 &&
    requestHmacs.every((value) => HMAC.test(value ?? "")) &&
    exactKeys(clientHmacs, CARD5_AUTHORITY_KINDS) &&
    CARD5_AUTHORITY_KINDS.every((authority) =>
      expectedSet.has(authority) ? HMAC.test(clientHmacs[authority] ?? "") : true,
    );
  const sourceResults = Array.isArray(results) ? results : [];
  const resultOverflow = !Array.isArray(results) || sourceResults.length > 2;
  const pages = [];
  const receipts = [];
  let receiptOverflow = false;
  for (const [pageOrdinal, result] of sourceResults.slice(0, 2).entries()) {
    const sourceReceipts = Array.isArray(result?.receipts) ? result.receipts : [];
    const remaining = Math.max(0, 3 - receipts.length);
    if (!Array.isArray(result?.receipts) || sourceReceipts.length > remaining)
      receiptOverflow = true;
    const page = Object.freeze({
      pageOrdinal,
      pageHmac: HMAC.test(result?.pageHmac ?? "") ? result.pageHmac : null,
      localClientHmac: HMAC.test(result?.localClientHmac ?? "") ? result.localClientHmac : null,
      preOwnerTupleHmac: HMAC.test(result?.preOwnerTupleHmac ?? "")
        ? result.preOwnerTupleHmac
        : null,
      preRevisionHmac: HMAC.test(result?.preRevisionHmac ?? "") ? result.preRevisionHmac : null,
      statusExact: result?.status === "exact",
      receiptCount: boundedInteger(sourceReceipts.length, 3),
    });
    pages.push(page);
    for (const receipt of sourceReceipts.slice(0, remaining)) {
      const authority = CARD5_AUTHORITY_KINDS.includes(receipt?.authority)
        ? receipt.authority
        : null;
      receipts.push(
        Object.freeze({
          pageOrdinal,
          pageHmac: page.pageHmac,
          localClientHmac: page.localClientHmac,
          authority,
          released: receipt?.status === "released",
          operationOrdinalValid:
            Number.isSafeInteger(receipt?.operationOrdinal) && receipt.operationOrdinal >= 1,
          revisionOrderValid:
            Number.isSafeInteger(receipt?.beforeRevision) &&
            receipt.beforeRevision >= 0 &&
            Number.isSafeInteger(receipt?.afterRevision) &&
            receipt.afterRevision > receipt.beforeRevision,
          workspaceMatch: receipt?.workspaceHmac === workspaceHmac,
          generationMatch: receipt?.generationHmac === generationHmac,
          runtimeSessionMatch: receipt?.runtimeSessionHmac === runtimeSessionHmac,
          paneMatch: receipt?.paneHmac === paneHmac,
          requestMatch:
            HMAC.test(receipt?.requestHmac ?? "") && requestHmacs?.includes(receipt.requestHmac),
          clientMatch:
            authority !== null &&
            HMAC.test(receipt?.clientHmac ?? "") &&
            receipt.clientHmac === clientHmacs?.[authority],
          requestHmac: HMAC.test(receipt?.requestHmac ?? "") ? receipt.requestHmac : null,
          clientHmac: HMAC.test(receipt?.clientHmac ?? "") ? receipt.clientHmac : null,
          operationOrdinal: boundedInteger(receipt?.operationOrdinal, 0xffff_ffff),
          beforeRevision: boundedInteger(receipt?.beforeRevision, 0xffff_ffff),
          afterRevision: boundedInteger(receipt?.afterRevision, 0xffff_ffff),
        }),
      );
    }
  }
  const actualReceiptCount = sourceResults.reduce(
    (count, result) => count + (Array.isArray(result?.receipts) ? result.receipts.length : 0),
    0,
  );
  const authorityCardinality = Object.freeze(
    Object.fromEntries(
      CARD5_AUTHORITY_KINDS.map((authority) => [
        authority,
        receipts.filter((receipt) => receipt.authority === authority).length ===
          (expectedSet.has(authority) ? 1 : 0),
      ]),
    ),
  );
  const axes = Object.freeze({
    inputCardinality: !authorityCardinality.input,
    focusCardinality: !authorityCardinality.focus,
    geometryCardinality: !authorityCardinality.geometry,
    resultStatus: pages.some((page) => !page.statusExact),
    resultCount: sourceResults.length !== 2,
    receiptCount: actualReceiptCount !== expected.length,
    releasedStatus: receipts.some((receipt) => !receipt.released),
    operationOrdinal: receipts.some((receipt) => !receipt.operationOrdinalValid),
    revisionOrder: receipts.some((receipt) => !receipt.revisionOrderValid),
    workspace: receipts.some((receipt) => !receipt.workspaceMatch),
    generation: receipts.some((receipt) => !receipt.generationMatch),
    runtimeSession: receipts.some((receipt) => !receipt.runtimeSessionMatch),
    pane: receipts.some((receipt) => !receipt.paneMatch),
    request: receipts.some((receipt) => !receipt.requestMatch),
    client: receipts.some((receipt) => !receipt.clientMatch),
    overflow: resultOverflow || receiptOverflow,
    contract: !expectedValid,
  });
  const passed =
    expectedValid &&
    sourceResults.length === 2 &&
    !resultOverflow &&
    !receiptOverflow &&
    Object.values(axes).every((value) => value === false);
  return Object.freeze({
    passed,
    observation: Object.freeze({
      version: 1,
      operation: "card5-web-release",
      expectedReceiptCount: boundedInteger(expected.length, 3),
      actualReceiptCount: boundedInteger(actualReceiptCount, 3),
      resultCount: boundedInteger(sourceResults.length, 2),
      resultOverflow,
      receiptOverflow,
      authorityCardinality,
      axes,
      pages: Object.freeze(pages),
      receipts: Object.freeze(receipts),
    }),
  });
}

export function boundedCard5TuiFocusFailureObservation(input) {
  const reasons = new Set([
    "focus-contract-invalid",
    "focus-presentation-missing",
    "focus-presentation-invalid",
    "focus-presentation-ambiguous",
    "focus-presentation-mismatch",
    "focus-convergence-changed",
    "focus-authority-unowned",
    "focus-release-unsettled",
    "focus-transition-contract-invalid",
    "focus-blur-receipt-invalid",
    "focus-focus-receipt-invalid",
    "focus-blur-lifecycle-invalid",
    "focus-claim-cardinality",
    "focus-claim-lifecycle-invalid",
    "focus-web-release-invalid",
  ]);
  const projected = boundedCard5HostFailureObservation({
    reason: "stability-timeout",
    focusDivergenceAxes: input?.axes,
    focusCandidates: input?.candidate ? [input.candidate] : input?.candidates,
  });
  return Object.freeze({
    operation: "card5-tui-focused-pane",
    reason: reasons.has(input?.reason) ? input.reason : "focus-contract-invalid",
    focusDivergenceAxes: projected.focusDivergenceAxes,
    focusCandidates: projected.focusCandidates,
    webRelease:
      input?.webRelease?.version === 1 && input.webRelease?.operation === "card5-web-release"
        ? input.webRelease
        : null,
  });
}

export function assessCard5TuiHandoffInput({
  records,
  hostReceipt,
  payload,
  expectedPane,
  expectedCanonical,
  inputFingerprintKey,
  evidenceKey,
}) {
  const fail = (reason) => Object.freeze({ passed: false, reason, evidence: null });
  if (
    !Array.isArray(records) ||
    typeof payload !== "string" ||
    typeof expectedPane !== "string" ||
    expectedPane.length < 1 ||
    !expectedCanonical ||
    !GENERATION.test(expectedCanonical.generation ?? "") ||
    typeof expectedCanonical.incarnation !== "string" ||
    expectedCanonical.incarnation.length < 1 ||
    !Number.isSafeInteger(expectedCanonical.revision) ||
    !CANONICAL_STATE_HASH.test(expectedCanonical.canonicalStateHash ?? "") ||
    !/^opentui:[1-9]\d*$/u.test(expectedCanonical.processId ?? "") ||
    expectedCanonical.clockId !== "opentui-performance-now" ||
    !/^[0-9a-f]{64}$/u.test(inputFingerprintKey ?? "") ||
    !/^[0-9a-f]{64}$/u.test(evidenceKey ?? "")
  )
    return fail("input-contract-invalid");
  if (!isExactCard5TuiHostInputReceipt(hostReceipt, payload)) return fail("host-receipt-invalid");
  const origins = records.filter((record) => record?.type === "performance.input-origin");
  if (origins.length !== 1)
    return fail(origins.length === 0 ? "input-origin-missing" : "input-origin-duplicate");
  const [origin] = origins;
  const fingerprint = createHmac("sha256", inputFingerprintKey)
    .update(origin.traceId ?? "")
    .update("\0")
    .update(payload)
    .digest("hex");
  if (
    typeof origin.traceId !== "string" ||
    origin.traceId.length < 1 ||
    origin.origin !== "bracketed-paste" ||
    origin.parserConsumption !== "paste-event" ||
    origin.clockKind !== "performance-now" ||
    !Number.isFinite(origin.atMicros) ||
    origin.payloadByteCount !== Buffer.byteLength(payload) ||
    origin.payloadFingerprint !== fingerprint ||
    origin.semanticPaneId !== expectedPane ||
    origin.generation !== expectedCanonical.generation ||
    origin.incarnation !== expectedCanonical.incarnation ||
    origin.revision !== expectedCanonical.revision ||
    origin.stateHash !== expectedCanonical.canonicalStateHash ||
    origin.processId !== expectedCanonical.processId ||
    origin.clockId !== expectedCanonical.clockId
  )
    return fail("input-origin-mismatch");
  const exactTrace = (type, predicate = () => true) =>
    records.filter(
      (record) => record?.type === type && record.traceId === origin.traceId && predicate(record),
    );
  const inputStages = exactTrace("performance.stage", (record) => record.stage === "input");
  const paintStages = exactTrace("performance.stage", (record) => record.stage === "paint");
  const fences = exactTrace("performance.input-fence");
  const projections = exactTrace("performance.terminal-framebuffer-projection");
  if (
    inputStages.length !== 1 ||
    paintStages.length !== 1 ||
    fences.length !== 1 ||
    projections.length !== 1
  )
    return fail("input-trace-cardinality");
  const [inputStage] = inputStages;
  const [paint] = paintStages;
  const [fence] = fences;
  const [projection] = projections;
  const sameCanonical = (record) =>
    record.semanticPaneId === expectedPane &&
    record.generation === expectedCanonical.generation &&
    record.incarnation === expectedCanonical.incarnation &&
    record.revision === fence.revision &&
    record.stateHash === fence.stateHash;
  const frameFences = records.filter(
    (record) => record?.type === "performance.terminal-frame-fence" && sameCanonical(record),
  );
  const sameProcessClock = (record) =>
    record.processId === origin.processId &&
    record.clockId === origin.clockId &&
    record.clockKind === "performance-now";
  const exactStage = (record) =>
    sameProcessClock(record) &&
    Number.isFinite(record.startedAtMicros) &&
    Number.isFinite(record.endedAtMicros) &&
    record.startedAtMicros <= record.endedAtMicros;
  const exactPoint = (record) => sameProcessClock(record) && Number.isFinite(record.atMicros);
  if (
    inputStage.authority?.generation !== expectedCanonical.generation ||
    inputStage.authority?.incarnation !== expectedCanonical.incarnation ||
    inputStage.scenario !== "terminal-input-to-paint" ||
    paint.scenario !== "terminal-input-to-paint" ||
    paint.paintStateIdentity !== "latest-canonical-state-blitted" ||
    inputStage.processId !== origin.processId ||
    inputStage.clockId !== origin.clockId ||
    !exactStage(inputStage) ||
    !exactStage(paint) ||
    !exactPoint(fence) ||
    !exactPoint(projection) ||
    origin.atMicros !== inputStage.startedAtMicros ||
    inputStage.endedAtMicros > paint.startedAtMicros ||
    paint.startedAtMicros > projection.atMicros ||
    projection.atMicros > paint.endedAtMicros ||
    paint.endedAtMicros > fence.atMicros ||
    !(
      records.indexOf(origin) < records.indexOf(projection) &&
      records.indexOf(projection) < records.indexOf(inputStage) &&
      records.indexOf(inputStage) < records.indexOf(paint) &&
      records.indexOf(paint) < records.indexOf(fence) &&
      records.indexOf(fence) < records.indexOf(frameFences[0])
    ) ||
    !sameCanonical(paint) ||
    !sameCanonical(projection) ||
    fence.semanticPaneId !== expectedPane ||
    fence.generation !== expectedCanonical.generation ||
    fence.incarnation !== expectedCanonical.incarnation ||
    !Number.isSafeInteger(fence.revision) ||
    fence.revision <= origin.revision ||
    !CANONICAL_STATE_HASH.test(fence.stateHash ?? "") ||
    !Number.isSafeInteger(projection.cols) ||
    projection.cols < 1 ||
    !Number.isSafeInteger(projection.rows) ||
    projection.rows < 1 ||
    frameFences.length !== 1 ||
    !exactPoint(frameFences[0]) ||
    frameFences[0].atMicros < fence.atMicros ||
    frameFences[0].acceptedRevision !== frameFences[0].revision ||
    frameFences[0].identityDrops !== 0 ||
    frameFences[0].cols !== projection.cols ||
    frameFences[0].rows !== projection.rows ||
    [fence.writerHealth, frameFences[0].writerHealth].some(
      (health) =>
        health?.droppedRecords !== 0 ||
        health?.oversizedRecords !== 0 ||
        health?.failed !== false ||
        (health?.pendingCriticalRecords !== undefined && health.pendingCriticalRecords !== 0),
    )
  )
    return fail("input-trace-mismatch");
  const hmac = (domain, value) =>
    createHmac("sha256", Buffer.from(evidenceKey, "hex"))
      .update(`${domain}\0${value}`)
      .digest("hex");
  return Object.freeze({
    passed: true,
    reason: null,
    evidence: Object.freeze({
      hostReceiptHmac: hmac("tui-host-receipt", JSON.stringify(hostReceipt)),
      hostPaneHmac: hmac("tui-host-pane", hostReceipt.paneId),
      traceHmac: hmac("tui-input-trace", origin.traceId),
      payloadHmac: hmac("tui-input-payload", payload),
      paneHmac: hmac("pane", expectedPane),
      canonicalHmac: hmac(
        "tui-input-canonical",
        [fence.generation, fence.incarnation, fence.revision, fence.stateHash].join("\0"),
      ),
      originRevision: origin.revision,
      fenceRevision: fence.revision,
      cols: projection.cols,
      rows: projection.rows,
    }),
  });
}

/** Privacy-safe projection of one production host's detailed-only observation. */
export function sealCard5ProductionClientObservation(raw, evidenceKey) {
  if (
    !raw ||
    !CLIENTS.has(raw.client) ||
    !HOSTS.has(raw.host) ||
    !GENERATION.test(raw.generation ?? "") ||
    !CANONICAL_STATE_HASH.test(raw.canonicalStateHash ?? "") ||
    (raw.client === "opentui"
      ? raw.contentHmac !== undefined && raw.contentHmac !== null
      : !HMAC.test(raw.contentHmac ?? "")) ||
    !CLOCK_ID.test(raw.clockId ?? "") ||
    !Number.isSafeInteger(raw.atMicros) ||
    raw.atMicros < 0 ||
    !Number.isSafeInteger(raw.cols) ||
    raw.cols < 1 ||
    !Number.isSafeInteger(raw.rows) ||
    raw.rows < 1 ||
    !Number.isSafeInteger(raw.deliveryFence) ||
    raw.deliveryFence < 0 ||
    [raw.workspaceName, raw.semanticPaneId, raw.incarnation, raw.processIdentity].some(
      (value) => typeof value !== "string" || value.length < 1 || value.length > 256,
    ) ||
    !/^[0-9a-f]{64}$/u.test(evidenceKey ?? "")
  ) {
    throw new TypeError("Card5 production client observation is malformed");
  }
  if (!["foreground", "background"].includes(raw.presence)) {
    throw new TypeError("Card5 production client presence is malformed");
  }
  const correlationHmac = createHmac("sha256", Buffer.from(evidenceKey, "hex"))
    .update(
      [raw.client, raw.host, raw.generation, raw.canonicalStateHash, String(raw.revision)].join(
        "\0",
      ),
    )
    .digest("hex");
  const identityHmac = (domain, value) =>
    createHmac("sha256", Buffer.from(evidenceKey, "hex"))
      .update(`${domain}\0${value}`)
      .digest("hex");
  return Object.freeze({
    client: raw.client,
    host: raw.host,
    generation: raw.generation,
    connected: raw.connected === true,
    canonicalStateHash: raw.canonicalStateHash,
    renditionHmac: raw.client === "opentui" ? null : raw.contentHmac,
    correlationHmac,
    workspaceHmac: identityHmac("workspace", raw.workspaceName),
    paneHmac: identityHmac("pane", raw.semanticPaneId),
    incarnationHmac: identityHmac("incarnation", raw.incarnation),
    processHmac: identityHmac("process", raw.processIdentity),
    clockHmac: identityHmac("clock", raw.clockId),
    atMicros: boundedInteger(raw.atMicros, 60_000_000_000),
    revision: boundedInteger(raw.revision, 0xffff_ffff),
    cols: boundedInteger(raw.cols, 65_535),
    rows: boundedInteger(raw.rows, 65_535),
    deliveryFence: boundedInteger(raw.deliveryFence, 0xffff_ffff),
    presence: raw.presence,
    passive: raw.passive === true,
    geometryOwner: raw.geometryOwner === true,
    queueCurrent: boundedInteger(raw.queueCurrent, 65_535),
    queuePeak: boundedInteger(raw.queuePeak, 65_535),
    queueCap: boundedInteger(raw.queueCap, 65_535),
    connectElapsedMs: boundedInteger(Math.round(raw.connectElapsedMs), 60_000),
  });
}

/** Two equal complete samples are required before a cross-host hash is called stable. */
export function advanceCard5CanonicalStability(previousDigest, observations) {
  if (!Array.isArray(observations) || observations.length !== 3) {
    return Object.freeze({
      stable: false,
      digest: null,
      reason: "client-cardinality",
      axes: null,
      candidate: null,
    });
  }
  const clients = observations.map(({ client }) => client);
  if (new Set(clients).size !== 3 || clients.some((client) => !CLIENTS.has(client))) {
    return Object.freeze({
      stable: false,
      digest: null,
      reason: "client-identity",
      axes: null,
      candidate: null,
    });
  }
  const generations = new Set(observations.map(({ generation }) => generation));
  const hashes = new Set(observations.map(({ canonicalStateHash }) => canonicalStateHash));
  const revisions = new Set(observations.map(({ revision }) => revision));
  const dimensions = new Set(observations.map(({ cols, rows }) => `${cols}x${rows}`));
  const workspaces = new Set(observations.map(({ workspaceHmac }) => workspaceHmac));
  const panes = new Set(observations.map(({ paneHmac }) => paneHmac));
  const incarnations = new Set(observations.map(({ incarnationHmac }) => incarnationHmac));
  const webRenditions = new Set(
    observations
      .filter(({ client }) => client !== "opentui")
      .map(({ renditionHmac }) => renditionHmac),
  );
  const fieldsComplete = observations.every(
    ({ connected, revision, deliveryFence, processHmac, clockHmac, atMicros }) =>
      connected === true &&
      revision !== null &&
      deliveryFence !== null &&
      HMAC.test(processHmac ?? "") &&
      HMAC.test(clockHmac ?? "") &&
      atMicros !== null,
  );
  const axes = Object.freeze({
    generation: generations.size === 1,
    canonicalHash: hashes.size === 1,
    revision: revisions.size === 1,
    dimensions: dimensions.size === 1,
    workspace: workspaces.size === 1,
    pane: panes.size === 1,
    incarnation: incarnations.size === 1,
    webRendition: webRenditions.size === 1,
    fieldsComplete,
  });
  const candidate = card5CandidateSummary(observations);
  if (
    generations.size !== 1 ||
    hashes.size !== 1 ||
    revisions.size !== 1 ||
    dimensions.size !== 1 ||
    workspaces.size !== 1 ||
    panes.size !== 1 ||
    incarnations.size !== 1 ||
    webRenditions.size !== 1 ||
    !fieldsComplete
  ) {
    return Object.freeze({
      stable: false,
      digest: null,
      reason: "canonical-divergence",
      axes,
      candidate,
    });
  }
  const digest = observations
    .map(
      ({
        client,
        generation,
        canonicalStateHash,
        revision,
        cols,
        rows,
        deliveryFence,
        workspaceHmac,
        paneHmac,
        incarnationHmac,
        processHmac,
        clockHmac,
        renditionHmac,
      }) =>
        [
          client,
          generation,
          canonicalStateHash,
          revision,
          cols,
          rows,
          deliveryFence,
          workspaceHmac,
          paneHmac,
          incarnationHmac,
          processHmac,
          clockHmac,
          renditionHmac,
        ].join("\0"),
    )
    .sort()
    .join("\n");
  return Object.freeze({
    stable: previousDigest === digest,
    digest,
    reason: previousDigest === digest ? null : "stability-pending",
    axes,
    candidate,
  });
}

/** One exact canonical client tuple plus the exact focused OpenTUI presentation/frame tuple. */
export function advanceCard5FocusedConvergenceStability(
  previousDigest,
  observations,
  focusEvidence,
  evidenceKey,
) {
  const canonical = advanceCard5CanonicalStability(null, observations);
  const tui = Array.isArray(observations)
    ? observations.find(({ client }) => client === "opentui")
    : null;
  const focusExact =
    HMAC.test(evidenceKey ?? "") &&
    HMAC.test(focusEvidence?.paneHmac ?? "") &&
    HMAC.test(focusEvidence?.processHmac ?? "") &&
    HMAC.test(focusEvidence?.clockHmac ?? "") &&
    HMAC.test(focusEvidence?.authorityHmac ?? "") &&
    HMAC.test(focusEvidence?.authorityOwnerHmac ?? "") &&
    Number.isSafeInteger(focusEvidence?.authorityRevision) &&
    focusEvidence.authorityRevision >= 0 &&
    HMAC.test(focusEvidence?.authorityTopologyHmac ?? "") &&
    HMAC.test(focusEvidence?.authorityMutationHmac ?? "") &&
    HMAC.test(focusEvidence?.canonicalHmac ?? "") &&
    HMAC.test(focusEvidence?.presentationHmac ?? "") &&
    HMAC.test(focusEvidence?.frameHmac ?? "") &&
    HMAC.test(focusEvidence?.focusStateHmac ?? "") &&
    Number.isSafeInteger(focusEvidence?.revision) &&
    focusEvidence.revision >= 0 &&
    Number.isSafeInteger(focusEvidence?.cols) &&
    focusEvidence.cols > 0 &&
    Number.isSafeInteger(focusEvidence?.rows) &&
    focusEvidence.rows > 0 &&
    Number.isSafeInteger(focusEvidence?.viewportCols) &&
    focusEvidence.viewportCols > 0 &&
    Number.isSafeInteger(focusEvidence?.viewportRows) &&
    focusEvidence.viewportRows > 0 &&
    focusEvidence.paneHmac === tui?.paneHmac &&
    focusEvidence.processHmac === tui?.processHmac &&
    focusEvidence.clockHmac === tui?.clockHmac &&
    focusEvidence.revision === tui?.revision &&
    focusEvidence.cols === tui?.cols &&
    focusEvidence.rows === tui?.rows;
  const postRelationFields = [
    focusEvidence?.authorityRelationHmac,
    focusEvidence?.authoritySequenceHmac,
    focusEvidence?.authorityDuplicateCount,
    focusEvidence?.inputProofHmac,
    focusEvidence?.grantRevision,
    focusEvidence?.releaseRevision,
    focusEvidence?.relation,
  ];
  const postRelationExact =
    postRelationFields.every((value) => value === undefined) ||
    (HMAC.test(focusEvidence?.authorityRelationHmac ?? "") &&
      HMAC.test(focusEvidence?.authoritySequenceHmac ?? "") &&
      Number.isSafeInteger(focusEvidence?.authorityDuplicateCount) &&
      focusEvidence.authorityDuplicateCount >= 0 &&
      focusEvidence.authorityDuplicateCount <= 8 &&
      HMAC.test(focusEvidence?.inputProofHmac ?? "") &&
      Number.isSafeInteger(focusEvidence?.grantRevision) &&
      focusEvidence.grantRevision >= 0 &&
      ["retained-owner", "released-null"].includes(focusEvidence?.relation) &&
      (focusEvidence.relation === "retained-owner"
        ? focusEvidence.releaseRevision === null
        : Number.isSafeInteger(focusEvidence.releaseRevision) &&
          focusEvidence.releaseRevision > focusEvidence.grantRevision));
  if (canonical.digest === null || !focusExact || !postRelationExact)
    return Object.freeze({
      ...canonical,
      stable: false,
      digest: null,
      reason: canonical.digest === null ? canonical.reason : "focused-pane-incomplete",
    });
  const digest = createHmac("sha256", Buffer.from(evidenceKey, "hex"))
    .update("card5-focused-convergence\0")
    .update(
      [
        canonical.digest,
        focusEvidence.paneHmac,
        focusEvidence.processHmac,
        focusEvidence.clockHmac,
        focusEvidence.authorityHmac,
        focusEvidence.authorityOwnerHmac,
        focusEvidence.authorityTopologyHmac,
        focusEvidence.canonicalHmac,
        focusEvidence.presentationHmac,
        focusEvidence.frameHmac,
        focusEvidence.focusStateHmac,
        focusEvidence.revision,
        focusEvidence.cols,
        focusEvidence.rows,
        focusEvidence.viewportCols,
        focusEvidence.viewportRows,
        focusEvidence.authorityRelationHmac ?? "initial",
        focusEvidence.authoritySequenceHmac ?? "initial",
        focusEvidence.authorityDuplicateCount ?? "initial",
        focusEvidence.inputProofHmac ?? "initial",
        focusEvidence.grantRevision ?? "initial",
        focusEvidence.releaseRevision ?? "initial",
        focusEvidence.relation ?? "initial",
      ].join("\0"),
    )
    .digest("hex");
  return Object.freeze({
    ...canonical,
    stable: previousDigest === digest,
    digest,
    reason: previousDigest === digest ? null : "stability-pending",
  });
}

export function boundedCard5HostFailureObservation(input) {
  const reasons = new Set([
    "host-unavailable",
    "client-cardinality",
    "client-identity",
    "canonical-divergence",
    "stability-timeout",
    "queue-overflow",
    "generation-stale",
    "authority-activity-storm",
  ]);
  return Object.freeze({
    operation: "card5-production-host-observation",
    reason: reasons.has(input?.reason) ? input.reason : "host-unavailable",
    host: HOSTS.has(input?.host) ? input.host : null,
    attempts: boundedInteger(input?.attempts, 4_096),
    elapsedMs: boundedInteger(Math.round(input?.elapsedMs), 60_000),
    observedClients: boundedInteger(input?.observedClients, 3),
    stableSamples: boundedInteger(input?.stableSamples, 2),
    queuePeak: boundedInteger(input?.queuePeak, 65_535),
    divergenceAxes:
      input?.divergenceAxes &&
      [
        "generation",
        "canonicalHash",
        "revision",
        "dimensions",
        "workspace",
        "pane",
        "incarnation",
        "webRendition",
        "fieldsComplete",
      ].every((key) => typeof input.divergenceAxes[key] === "boolean")
        ? Object.freeze({
            generation: input.divergenceAxes.generation,
            canonicalHash: input.divergenceAxes.canonicalHash,
            revision: input.divergenceAxes.revision,
            dimensions: input.divergenceAxes.dimensions,
            workspace: input.divergenceAxes.workspace,
            pane: input.divergenceAxes.pane,
            incarnation: input.divergenceAxes.incarnation,
            webRendition: input.divergenceAxes.webRendition,
            fieldsComplete: input.divergenceAxes.fieldsComplete,
          })
        : null,
    focusDivergenceAxes:
      input?.focusDivergenceAxes &&
      [
        "pane",
        "generation",
        "incarnation",
        "revision",
        "canonicalHash",
        "process",
        "clock",
        "canonicalDimensions",
        "viewportDimensions",
        "presentationCount",
        "followingFrame",
        "frameHealth",
        "authority",
      ].every((key) => typeof input.focusDivergenceAxes[key] === "boolean")
        ? Object.freeze({ ...input.focusDivergenceAxes })
        : null,
    focusCandidates: Object.freeze(
      Array.isArray(input?.focusCandidates)
        ? input.focusCandidates.slice(-2).map((candidate) =>
            Object.freeze({
              paneHmac: HMAC.test(candidate?.paneHmac ?? "") ? candidate.paneHmac : null,
              generationHmac: HMAC.test(candidate?.generationHmac ?? "")
                ? candidate.generationHmac
                : null,
              incarnationHmac: HMAC.test(candidate?.incarnationHmac ?? "")
                ? candidate.incarnationHmac
                : null,
              processHmac: HMAC.test(candidate?.processHmac ?? "") ? candidate.processHmac : null,
              clockHmac: HMAC.test(candidate?.clockHmac ?? "") ? candidate.clockHmac : null,
              canonicalHashHmac: HMAC.test(candidate?.canonicalHashHmac ?? "")
                ? candidate.canonicalHashHmac
                : null,
              revision: boundedInteger(candidate?.revision, 0xffff_ffff),
              cols: boundedInteger(candidate?.cols, 65_535),
              rows: boundedInteger(candidate?.rows, 65_535),
              viewportCols: boundedInteger(candidate?.viewportCols, 65_535),
              viewportRows: boundedInteger(candidate?.viewportRows, 65_535),
              presentationCount: boundedInteger(candidate?.presentationCount, 0xffff_ffff),
              presentationHmac: HMAC.test(candidate?.presentationHmac ?? "")
                ? candidate.presentationHmac
                : null,
              frameHmac: HMAC.test(candidate?.frameHmac ?? "") ? candidate.frameHmac : null,
              authoritySequenceHmac: HMAC.test(candidate?.authoritySequenceHmac ?? "")
                ? candidate.authoritySequenceHmac
                : null,
            }),
          )
        : [],
    ),
    authorityViews: Object.freeze(
      Array.isArray(input?.authorityViews)
        ? input.authorityViews.slice(-2).map((pair) => {
            const project = (view) =>
              Object.freeze(
                (() => {
                  const evidence = view?.evidence ?? view;
                  const reasons = new Set([
                    "generation-mismatch",
                    "session-invalid",
                    "revision-invalid",
                    "native-yield-invalid",
                    "authority-keys-invalid",
                    "owner-keys-invalid",
                    "client-count-invalid",
                    "client-schema-invalid",
                    "surface-cardinality-invalid",
                    "duplicate-client",
                    "input-owner-invalid",
                    "focus-owner-invalid",
                    "post-handoff-contract-invalid",
                    "post-handoff-grant-missing",
                    "post-handoff-owner-unexplained",
                  ]);
                  const axisKeys = [
                    "generation",
                    "session",
                    "revision",
                    "nativeYield",
                    "authorityKeys",
                    "ownerKeys",
                    "clientCount",
                    "clientSchema",
                    "surfaceCardinality",
                    "duplicateClients",
                    "inputOwner",
                    "focusOwner",
                  ];
                  const evidenceValid = Boolean(
                    HMAC.test(evidence?.authorityHmac ?? "") &&
                    HMAC.test(evidence?.authorityTopologyHmac ?? "") &&
                    HMAC.test(evidence?.authorityMutationHmac ?? "") &&
                    Number.isSafeInteger(evidence?.authorityRevision) &&
                    evidence.authorityRevision >= 0,
                  );
                  return {
                    valid: view?.valid !== false && evidenceValid,
                    reason: reasons.has(view?.reason)
                      ? view.reason
                      : evidenceValid
                        ? null
                        : "authority-keys-invalid",
                    axes:
                      view?.axes && axisKeys.every((key) => typeof view.axes[key] === "boolean")
                        ? Object.freeze(
                            Object.fromEntries(axisKeys.map((key) => [key, view.axes[key]])),
                          )
                        : null,
                    counts: Object.freeze({
                      clients: boundedInteger(view?.counts?.clients, 8),
                      web: boundedInteger(view?.counts?.web, 8),
                      opentui: boundedInteger(view?.counts?.opentui, 8),
                    }),
                    ownerHmac: HMAC.test(view?.ownerHmac ?? "") ? view.ownerHmac : null,
                    clientsHmac: HMAC.test(view?.clientsHmac ?? "") ? view.clientsHmac : null,
                    recordTransitions: Object.freeze(
                      Array.isArray(view?.recordTransitions)
                        ? view.recordTransitions.slice(-2).map((record) =>
                            Object.freeze({
                              ordinal: boundedInteger(record?.ordinal, 0xffff_ffff),
                              revision: boundedInteger(record?.revision, 0xffff_ffff),
                              clientCount: boundedInteger(record?.clientCount, 8),
                              ownerHmac: HMAC.test(record?.ownerHmac ?? "")
                                ? record.ownerHmac
                                : null,
                              topologyHmac: HMAC.test(record?.topologyHmac ?? "")
                                ? record.topologyHmac
                                : null,
                            }),
                          )
                        : [],
                    ),
                    revision: boundedInteger(evidence?.authorityRevision, 0xffff_ffff),
                    semanticHmac: HMAC.test(evidence?.authorityHmac ?? "")
                      ? evidence.authorityHmac
                      : null,
                    topologyHmac: HMAC.test(evidence?.authorityTopologyHmac ?? "")
                      ? evidence.authorityTopologyHmac
                      : null,
                    mutationHmac: HMAC.test(evidence?.authorityMutationHmac ?? "")
                      ? evidence.authorityMutationHmac
                      : null,
                    mode: HMAC.test(evidence?.authorityRelationHmac ?? "")
                      ? "post-handoff"
                      : "initial",
                    relation: ["retained-owner", "released-null"].includes(evidence?.relation)
                      ? evidence.relation
                      : null,
                    grantRevision: boundedInteger(evidence?.grantRevision, 0xffff_ffff),
                    releaseRevision: boundedInteger(evidence?.releaseRevision, 0xffff_ffff),
                    relationHmac: HMAC.test(evidence?.authorityRelationHmac ?? "")
                      ? evidence.authorityRelationHmac
                      : null,
                    sequenceHmac: HMAC.test(evidence?.authoritySequenceHmac ?? "")
                      ? evidence.authoritySequenceHmac
                      : null,
                    duplicateCount: boundedInteger(evidence?.authorityDuplicateCount, 8),
                  };
                })(),
              );
            const projectActivity = (activity) => {
              const outcomes = new Set([
                "attempt",
                "ok",
                "geometry-authority-conflict",
                "authority-timeout",
                "viewport-timeout",
                "stream-closed",
                "lifecycle-retired",
                "failed",
              ]);
              const source = Array.isArray(activity?.events) ? activity.events.slice(-64) : [];
              const events = source
                .filter(
                  (event) =>
                    ["web", "opentui"].includes(event?.surface) &&
                    ["focus", "geometry", "input"].includes(event?.kind) &&
                    outcomes.has(event?.outcome) &&
                    Number.isSafeInteger(event?.ordinal) &&
                    event.ordinal >= 1,
                )
                .slice(-8)
                .map(({ ordinal, surface, kind, outcome, operationOrdinal, dimensionsHmac }) =>
                  Object.freeze({
                    ordinal,
                    surface,
                    kind,
                    outcome,
                    operationOrdinal: boundedInteger(operationOrdinal, 0xffff_ffff),
                    dimensionsHmac:
                      kind === "geometry" && HMAC.test(dimensionsHmac ?? "")
                        ? dimensionsHmac
                        : null,
                  }),
                );
              const byKind = { focus: 0, geometry: 0, input: 0 };
              for (const event of source) {
                if (
                  ["web", "opentui"].includes(event?.surface) &&
                  Object.hasOwn(byKind, event?.kind)
                ) {
                  byKind[event.kind] = Math.min(byKind[event.kind] + 1, 64);
                }
              }
              return Object.freeze({
                available:
                  Number.isSafeInteger(activity?.count) &&
                  activity.count >= 0 &&
                  typeof activity?.overflow === "boolean",
                count: boundedInteger(activity?.count, 0xffff_ffff),
                overflow: activity?.overflow === true,
                byKind: Object.freeze(byKind),
                events: Object.freeze(events),
                geometrySettlements: Object.freeze(
                  Array.isArray(activity?.geometrySettlements)
                    ? activity.geometrySettlements.slice(-16).map((receipt) =>
                        Object.freeze({
                          ordinal: boundedInteger(receipt?.ordinal, 0xffff_ffff),
                          operationOrdinal: boundedInteger(receipt?.operationOrdinal, 0xffff_ffff),
                          requestHmac: HMAC.test(receipt?.requestHmac ?? "")
                            ? receipt.requestHmac
                            : null,
                          clientHmac: HMAC.test(receipt?.clientHmac ?? "")
                            ? receipt.clientHmac
                            : null,
                          dimensionsHmac: HMAC.test(receipt?.dimensionsHmac ?? "")
                            ? receipt.dimensionsHmac
                            : null,
                        }),
                      )
                    : [],
                ),
              });
            };
            return Object.freeze({
              a: project(pair?.a),
              b: project(pair?.b),
              activityA: projectActivity(pair?.activityA),
              activityB: projectActivity(pair?.activityB),
              activityTui: projectActivity(pair?.activityTui),
              semanticEqual: pair?.semanticEqual === true,
              revisionMonotonic: pair?.revisionMonotonic === true,
            });
          })
        : [],
    ),
    candidateSummaries: Object.freeze(
      Array.isArray(input?.candidateSummaries)
        ? input.candidateSummaries.slice(-2).map((candidate) =>
            Object.freeze({
              clients: Object.freeze(
                Array.isArray(candidate?.clients)
                  ? candidate.clients.slice(0, 3).map((client) =>
                      Object.freeze({
                        client: CLIENTS.has(client?.client) ? client.client : null,
                        correlationHmac: HMAC.test(client?.correlationHmac ?? "")
                          ? client.correlationHmac
                          : null,
                        workspaceHmac: HMAC.test(client?.workspaceHmac ?? "")
                          ? client.workspaceHmac
                          : null,
                        paneHmac: HMAC.test(client?.paneHmac ?? "") ? client.paneHmac : null,
                        incarnationHmac: HMAC.test(client?.incarnationHmac ?? "")
                          ? client.incarnationHmac
                          : null,
                        renditionHmac: HMAC.test(client?.renditionHmac ?? "")
                          ? client.renditionHmac
                          : null,
                        revision: boundedInteger(client?.revision, 0xffff_ffff),
                        cols: boundedInteger(client?.cols, 65_535),
                        rows: boundedInteger(client?.rows, 65_535),
                        deliveryFence: boundedInteger(client?.deliveryFence, 0xffff_ffff),
                      }),
                    )
                  : [],
              ),
            }),
          )
        : [],
    ),
  });
}

export function assessCard5ReplacementEnvelopeEvidence(input) {
  const after = input?.replacementGeneration;
  const before = input?.predecessorGeneration;
  const lanes = input?.lanes;
  if (
    typeof after !== "string" ||
    typeof before !== "string" ||
    after === before ||
    !Array.isArray(lanes) ||
    lanes.length !== 3
  ) {
    return Object.freeze({ passed: false, reason: "generation-identity" });
  }
  for (const [laneOrdinal, lane] of lanes.entries()) {
    const events = lane?.events;
    const boundary = lane?.replacementBoundary;
    if (
      !Array.isArray(events) ||
      boundary?.predecessorGeneration !== before ||
      boundary?.replacementGeneration !== after ||
      !Number.isSafeInteger(boundary?.acceptedOrdinal) ||
      lane?.predecessorAcceptedAfterReplacement !== 0
    )
      return Object.freeze({ passed: false, reason: "replacement-boundary" });
    if (
      laneOrdinal < 2 &&
      (!Number.isSafeInteger(boundary.socketOrdinal) ||
        !Array.isArray(lane.socketEvents) ||
        !lane.socketEvents.some(
          ({ generation, outcome, ordinal }) =>
            generation === before && outcome === "closed" && ordinal >= boundary.socketOrdinal,
        ) ||
        !lane.socketEvents.some(
          ({ generation, outcome, ordinal }) =>
            generation === after && outcome === "open" && ordinal <= boundary.socketOrdinal,
        ))
    ) {
      return Object.freeze({ passed: false, reason: "socket-replacement-order" });
    }
    if (
      events.some(
        ({ generation, acceptedOrdinal }) =>
          generation === before && acceptedOrdinal >= boundary.acceptedOrdinal,
      )
    ) {
      return Object.freeze({ passed: false, reason: "predecessor-accepted-after-replace" });
    }
    const firstReplacement = events.find(
      ({ generation, acceptedOrdinal }) =>
        generation === after && acceptedOrdinal >= boundary.acceptedOrdinal,
    );
    if (firstReplacement?.type !== "terminal.seed") {
      return Object.freeze({ passed: false, reason: "replacement-not-seed-first" });
    }
  }
  if (
    !Array.isArray(input.staleRedemptions) ||
    input.staleRedemptions.length !== 2 ||
    input.staleRedemptions.some(
      (result) =>
        result?.rejected !== true ||
        result?.typed !== true ||
        !["redemption-rejected", "ticket-expired"].includes(result.reason),
    )
  ) {
    return Object.freeze({ passed: false, reason: "retirement-not-typed" });
  }
  return Object.freeze({
    passed: true,
    reason: null,
    staleGenerationError: "generation-replaced",
    replacementFirstEnvelope: "seed",
    replacementSeedGeneration: after,
    predecessorEnvelopeAcceptedAfterReplace: false,
  });
}

const CARD5_CORRELATION_KINDS = Object.freeze([
  "host-open",
  "canonical-before",
  "authority-handoff",
  "slow-isolation",
  "generation-replacement",
  "canonical-after",
  "native-observer",
]);

/** Join already-bounded observed records without ever serializing raw authority. */
export function sealCard5CorrelationEvidence(
  records,
  evidenceKey,
  requiredKinds = CARD5_CORRELATION_KINDS,
) {
  if (
    !Array.isArray(records) ||
    !HMAC.test(evidenceKey ?? "") ||
    !Array.isArray(requiredKinds) ||
    requiredKinds.length < 1 ||
    requiredKinds.some((kind) => !CARD5_CORRELATION_KINDS.includes(kind)) ||
    new Set(requiredKinds).size !== requiredKinds.length
  ) {
    throw new TypeError("Card5 correlation input is malformed");
  }
  const evidenceHmac = (domain, value) =>
    createHmac("sha256", Buffer.from(evidenceKey, "hex"))
      .update(`${domain}\0${value}`)
      .digest("hex");
  const expectedClients = ["opentui", "web-a", "web-b"];
  const validRecord = (record, ordinal) => {
    if (
      record?.kind !== requiredKinds[ordinal] ||
      record?.ordinal !== ordinal ||
      !HMAC.test(record?.valueHmac ?? "") ||
      !Array.isArray(record?.sourceBindings) ||
      record.sourceBindings.length !== 3
    )
      return false;
    const panes = new Set();
    const processes = new Set();
    for (const [clientOrdinal, binding] of record.sourceBindings.entries()) {
      if (
        binding?.client !== expectedClients[clientOrdinal] ||
        !HMAC.test(binding?.paneHmac ?? "") ||
        !HMAC.test(binding?.processHmac ?? "") ||
        !HMAC.test(binding?.clockHmac ?? "") ||
        binding?.bindingHmac !==
          evidenceHmac(
            "source-binding",
            [binding.client, binding.paneHmac, binding.processHmac, binding.clockHmac].join("\0"),
          )
      )
        return false;
      panes.add(binding.paneHmac);
      processes.add(binding.processHmac);
    }
    const expectedRecordHmac = evidenceHmac(
      "record",
      [
        record.kind,
        record.ordinal,
        record.valueHmac,
        ...record.sourceBindings.map(({ bindingHmac }) => bindingHmac),
      ].join("\0"),
    );
    return panes.size === 1 && processes.size === 3 && record.recordHmac === expectedRecordHmac;
  };
  const accepted = records.filter(validRecord);
  const recordIds = accepted.map(({ recordHmac }) => recordHmac);
  const kinds = new Set(accepted.map(({ kind }) => kind));
  const missingJoinCount = requiredKinds.filter((kind) => !kinds.has(kind)).length;
  const duplicateJoinCount = recordIds.length - new Set(recordIds).size;
  const malformedRecordCount = records.length - accepted.length;
  const serialized = JSON.stringify(records);
  const countMatches = (pattern) => [...serialized.matchAll(pattern)].length;
  const rawOwnerTokenCount = countMatches(/ownerToken|bearer/giu);
  const rawCapabilityCount = countMatches(/capability|redemptionTicket|subprotocol/giu);
  const rawPaneContentCount = countMatches(/paneContent|terminalBytes|rawContent/giu);
  const complete =
    records.length === requiredKinds.length &&
    malformedRecordCount === 0 &&
    missingJoinCount === 0 &&
    duplicateJoinCount === 0;
  const journeyHmac = createHmac("sha256", Buffer.from(evidenceKey, "hex"))
    .update(
      accepted
        .map(({ kind, ordinal, recordHmac }) => [kind, ordinal, recordHmac].join("\0"))
        .join("\n"),
    )
    .digest("hex");
  return Object.freeze({
    correlation: Object.freeze({
      complete,
      recordCount: Math.min(records.length, 256),
      missingJoinCount: Math.min(missingJoinCount + malformedRecordCount, 256),
      duplicateJoinCount: Math.min(Math.max(duplicateJoinCount, 0), 256),
      journeyHmac,
    }),
    privacy: Object.freeze({
      scannedRecordCount: Math.min(records.length, 256),
      rawOwnerTokenCount: Math.min(rawOwnerTokenCount, 256),
      rawCapabilityCount: Math.min(rawCapabilityCount, 256),
      rawPaneContentCount: Math.min(rawPaneContentCount, 256),
    }),
  });
}
