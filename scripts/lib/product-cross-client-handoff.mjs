import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const HASH = /^[0-9a-f]{16}$/u;
const HMAC = /^[0-9a-f]{64}$/u;

function evidenceHmac(evidenceKey, domain, value) {
  if (!HMAC.test(evidenceKey ?? "")) return null;
  return createHmac("sha256", Buffer.from(evidenceKey, "hex"))
    .update(`${domain}\0${value}`)
    .digest("hex");
}

function card5AuthorityReleaseBindingPayload(transition, ownerReleaseEvidence) {
  const byAuthority = (left, right) => left.authority.localeCompare(right.authority);
  return {
    ordinal: transition?.ordinal,
    operationHmac: transition?.operationHmac,
    markerHmac: transition?.markerHmac,
    grantRevision: transition?.grantRevision,
    authorityReleaseEvidence: {
      ...transition?.authorityReleaseEvidence,
      receipts: [...(transition?.authorityReleaseEvidence?.receipts ?? [])].sort(byAuthority),
    },
    ownerReleaseEvidence: {
      ...ownerReleaseEvidence,
      expectedReleases: [...(ownerReleaseEvidence?.expectedReleases ?? [])].sort(byAuthority),
    },
    nullAuthorityEvidence: transition?.nullAuthorityEvidence,
    authorityJoinEvidence: transition?.authorityJoinEvidence,
    postHandoffAuthorityEvidence: transition?.postHandoffAuthorityEvidence,
  };
}

export function card5AuthorityReleaseBindingDigest(transition, ownerReleaseEvidence) {
  return createHash("sha256")
    .update(JSON.stringify(card5AuthorityReleaseBindingPayload(transition, ownerReleaseEvidence)))
    .digest("hex");
}

export function card5AuthorityReleaseBindingHmac(transition, ownerReleaseEvidence, evidenceKey) {
  if (!HMAC.test(evidenceKey ?? "")) return null;
  return createHmac("sha256", Buffer.from(evidenceKey, "hex"))
    .update(JSON.stringify(card5AuthorityReleaseBindingPayload(transition, ownerReleaseEvidence)))
    .digest("hex");
}

function exactHmacEqual(left, right) {
  return (
    HMAC.test(left ?? "") &&
    HMAC.test(right ?? "") &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

export const CARD5_CROSS_CLIENT_BOUNDARIES = Object.freeze([
  "cross-client-production-hosts",
  "cross-client-initial-convergence",
  "cross-client-authority-handoff",
  "cross-client-passive-geometry",
  "cross-client-slow-web-isolation",
  "cross-client-daemon-restart",
  "cross-client-restart-convergence",
  "cross-client-native-observer",
  "cross-client-correlation-privacy",
]);

export const CARD5_DAEMON_RESTART_BOUNDARIES = Object.freeze([
  "daemon-restart-production-hosts",
  "daemon-restart-before-convergence",
  "daemon-restart-generation-replaced",
  "daemon-restart-stale-authority-rejected",
  "daemon-restart-hosts-reconnected",
  "daemon-restart-canonical-convergence",
  "daemon-restart-correlation-privacy",
]);

function clientSetExact(clients, generation) {
  const names = ["opentui", "web-a", "web-b"];
  return (
    clients &&
    Object.keys(clients).sort().join("\0") === names.sort().join("\0") &&
    names.every(
      (name) =>
        clients[name]?.generation === generation &&
        HASH.test(clients[name]?.canonicalStateHash ?? "") &&
        clients[name]?.connected === true,
    )
  );
}

function converged(clients, generation) {
  const values = Object.values(clients ?? {});
  return (
    clientSetExact(clients, generation) &&
    new Set(values.map(({ canonicalStateHash }) => canonicalStateHash)).size === 1 &&
    new Set(values.map(({ revision }) => revision)).size === 1 &&
    new Set(values.map(({ cols, rows }) => `${cols}x${rows}`)).size === 1 &&
    new Set(values.map(({ workspaceHmac }) => workspaceHmac)).size === 1 &&
    new Set(values.map(({ paneHmac }) => paneHmac)).size === 1 &&
    new Set(values.map(({ incarnationHmac }) => incarnationHmac)).size === 1 &&
    clients["opentui"]?.renditionHmac === null &&
    HMAC.test(clients["web-a"]?.renditionHmac ?? "") &&
    clients["web-a"]?.renditionHmac === clients["web-b"]?.renditionHmac &&
    values.every(
      ({
        revision,
        cols,
        rows,
        deliveryFence,
        processHmac,
        clockHmac,
        atMicros,
        connectElapsedMs,
      }) =>
        Number.isSafeInteger(revision) &&
        Number.isSafeInteger(cols) &&
        Number.isSafeInteger(rows) &&
        Number.isSafeInteger(deliveryFence) &&
        Number.isSafeInteger(atMicros) &&
        Number.isSafeInteger(connectElapsedMs) &&
        connectElapsedMs > 0 &&
        connectElapsedMs <= 5_000 &&
        HMAC.test(processHmac ?? "") &&
        HMAC.test(clockHmac ?? ""),
    ) &&
    new Set(values.map(({ processHmac }) => processHmac)).size === 3
  );
}

function exactObservedHostLedger(hosts) {
  const ledger = hosts?.lifecycle;
  return (
    Array.isArray(ledger) &&
    ledger.length === 3 &&
    new Set(ledger.map(({ client }) => client)).size === 3 &&
    ledger.every(
      (entry) =>
        ["opentui", "web-a", "web-b"].includes(entry.client) &&
        entry.opened === true &&
        /^[0-9a-f]{64}$/u.test(entry.processHmac ?? "") &&
        /^[0-9a-f]{64}$/u.test(entry.requestHmac ?? "") &&
        (entry.client === "opentui"
          ? entry.socketObserved === false && entry.socketHmac === null
          : entry.socketObserved === true && /^[0-9a-f]{64}$/u.test(entry.socketHmac ?? "")) &&
        /^[0-9a-f]{64}$/u.test(entry.laneHmac ?? "") &&
        /^[0-9a-f]{64}$/u.test(entry.clientHmac ?? "") &&
        Number.isSafeInteger(entry.openOrdinal),
    ) &&
    new Set(ledger.map(({ processHmac }) => processHmac)).size === 3 &&
    new Set(ledger.map(({ requestHmac }) => requestHmac)).size === 3 &&
    new Set(
      ledger.filter(({ socketObserved }) => socketObserved).map(({ socketHmac }) => socketHmac),
    ).size === 2 &&
    new Set(ledger.map(({ laneHmac }) => laneHmac)).size === 3 &&
    new Set(ledger.map(({ clientHmac }) => clientHmac)).size === 3
  );
}

function exactFocusedConvergence(focus, expectedTui) {
  return (
    focus?.paneHmac === expectedTui?.paneHmac &&
    focus?.processHmac === expectedTui?.processHmac &&
    focus?.clockHmac === expectedTui?.clockHmac &&
    HMAC.test(focus?.authorityHmac ?? "") &&
    HMAC.test(focus?.authorityOwnerHmac ?? "") &&
    Number.isSafeInteger(focus?.authorityRevision) &&
    focus.authorityRevision >= 0 &&
    HMAC.test(focus?.authorityTopologyHmac ?? "") &&
    HMAC.test(focus?.canonicalHmac ?? "") &&
    HMAC.test(focus?.presentationHmac ?? "") &&
    HMAC.test(focus?.frameHmac ?? "") &&
    HMAC.test(focus?.focusStateHmac ?? "") &&
    focus?.revision === expectedTui?.revision &&
    focus?.cols === expectedTui?.cols &&
    focus?.rows === expectedTui?.rows &&
    Number.isSafeInteger(focus?.viewportCols) &&
    focus.viewportCols > 0 &&
    Number.isSafeInteger(focus?.viewportRows) &&
    focus.viewportRows > 0
  );
}

function postHandoffAuthorityEvidenceExact(evidence, grantRevision) {
  const keys = [
    "mode",
    "relation",
    "grantRevision",
    "currentRevision",
    "releaseRevision",
    "relationHmac",
    "sequenceHmac",
    "inputProofHmac",
    "authorityHmac",
    "authorityOwnerHmac",
    "authorityTopologyHmac",
    "authorityMutationHmac",
    "duplicateCount",
  ];
  return (
    evidence !== null &&
    typeof evidence === "object" &&
    Object.keys(evidence).sort().join("\0") === keys.sort().join("\0") &&
    evidence.mode === "post-handoff" &&
    ["retained-owner", "released-null"].includes(evidence.relation) &&
    evidence.grantRevision === grantRevision &&
    Number.isSafeInteger(evidence.currentRevision) &&
    evidence.currentRevision >= grantRevision &&
    [
      evidence.relationHmac,
      evidence.sequenceHmac,
      evidence.inputProofHmac,
      evidence.authorityHmac,
      evidence.authorityOwnerHmac,
      evidence.authorityTopologyHmac,
      evidence.authorityMutationHmac,
    ].every((value) => HMAC.test(value ?? "")) &&
    Number.isSafeInteger(evidence.duplicateCount) &&
    evidence.duplicateCount >= 0 &&
    evidence.duplicateCount <= 8 &&
    (evidence.relation === "retained-owner"
      ? evidence.releaseRevision === null
      : Number.isSafeInteger(evidence.releaseRevision) &&
        evidence.releaseRevision > grantRevision &&
        evidence.releaseRevision <= evidence.currentRevision)
  );
}

function authorityReleaseEvidenceExact(evidence) {
  const exactKeys = (value, expected) =>
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
  if (
    !exactKeys(evidence, [
      "ownerTupleHmac",
      "ownerRevision",
      "ownerReleaseSeal",
      "expectedReleaseMapHmac",
      "expectedReleaseCount",
      "expectedWebReleaseCount",
      "expectedTuiReleaseCount",
      "tuiBlurSettlementHmac",
      "tuiBlurRevision",
      "tuiBlurClientHmac",
      "receipts",
    ]) ||
    !HMAC.test(evidence.ownerTupleHmac ?? "") ||
    !HMAC.test(evidence.ownerReleaseSeal ?? "") ||
    !HMAC.test(evidence.expectedReleaseMapHmac ?? "") ||
    !Number.isSafeInteger(evidence.ownerRevision) ||
    evidence.ownerRevision < 0 ||
    !Number.isSafeInteger(evidence.expectedReleaseCount) ||
    evidence.expectedReleaseCount < 1 ||
    evidence.expectedReleaseCount > 3 ||
    !Number.isSafeInteger(evidence.expectedWebReleaseCount) ||
    evidence.expectedWebReleaseCount < 0 ||
    evidence.expectedWebReleaseCount > 3 ||
    !Number.isSafeInteger(evidence.expectedTuiReleaseCount) ||
    evidence.expectedTuiReleaseCount < 0 ||
    evidence.expectedTuiReleaseCount > 3 ||
    evidence.expectedWebReleaseCount + evidence.expectedTuiReleaseCount !==
      evidence.expectedReleaseCount ||
    (evidence.expectedTuiReleaseCount > 0
      ? !HMAC.test(evidence.tuiBlurSettlementHmac ?? "") ||
        !HMAC.test(evidence.tuiBlurClientHmac ?? "") ||
        !Number.isSafeInteger(evidence.tuiBlurRevision) ||
        evidence.tuiBlurRevision <= evidence.ownerRevision
      : evidence.tuiBlurSettlementHmac !== null ||
        evidence.tuiBlurClientHmac !== null ||
        evidence.tuiBlurRevision !== null) ||
    !Array.isArray(evidence.receipts) ||
    evidence.receipts.length !== evidence.expectedWebReleaseCount
  )
    return false;
  const authorities = new Set();
  return evidence.receipts.every((receipt) => {
    if (
      !exactKeys(receipt, [
        "authority",
        "status",
        "operationOrdinal",
        "beforeRevision",
        "afterRevision",
        "workspaceHmac",
        "generationHmac",
        "runtimeSessionHmac",
        "paneHmac",
        "requestHmac",
        "clientHmac",
      ]) ||
      !["input", "focus", "geometry"].includes(receipt.authority) ||
      authorities.has(receipt.authority) ||
      receipt.status !== "released" ||
      !Number.isSafeInteger(receipt.operationOrdinal) ||
      receipt.operationOrdinal < 1 ||
      !Number.isSafeInteger(receipt.beforeRevision) ||
      receipt.beforeRevision < evidence.ownerRevision ||
      !Number.isSafeInteger(receipt.afterRevision) ||
      receipt.afterRevision <= receipt.beforeRevision ||
      ![
        receipt.workspaceHmac,
        receipt.generationHmac,
        receipt.runtimeSessionHmac,
        receipt.paneHmac,
        receipt.requestHmac,
        receipt.clientHmac,
      ].every((value) => HMAC.test(value ?? ""))
    )
      return false;
    authorities.add(receipt.authority);
    return true;
  });
}

function authorityJoinEvidenceExact(evidence) {
  return (
    evidence !== null &&
    typeof evidence === "object" &&
    Object.keys(evidence).sort().join("\0") ===
      [
        "nullCount",
        "nullOverflow",
        "grantCount",
        "grantOverflow",
        "receiptCount",
        "nullExact",
        "grantExact",
        "receiptExact",
        "boundary",
        "boundaryOverflow",
        "nullReplayCount",
        "nullReplayOrdinalHmac",
        "grantReplayCount",
        "grantReplayOrdinalHmac",
        "stagingCount",
        "stagingOverflow",
        "stagingExact",
        "stagingOrdinalHmac",
        "stagingSequenceHmac",
        "lastRecords",
      ]
        .sort()
        .join("\0") &&
    Number.isSafeInteger(evidence.nullCount) &&
    evidence.nullCount >= 1 &&
    evidence.nullCount <= 8 &&
    evidence.nullOverflow === false &&
    Number.isSafeInteger(evidence.grantCount) &&
    evidence.grantCount >= 1 &&
    evidence.grantCount <= 8 &&
    evidence.grantOverflow === false &&
    Number.isSafeInteger(evidence.receiptCount) &&
    evidence.receiptCount >= 0 &&
    evidence.receiptCount <= 1 &&
    evidence.nullExact === true &&
    evidence.grantExact === true &&
    evidence.receiptExact === true &&
    Number.isSafeInteger(evidence.boundary) &&
    evidence.boundary >= 0 &&
    evidence.boundaryOverflow === false &&
    evidence.nullReplayCount === evidence.nullCount - 1 &&
    evidence.grantReplayCount === evidence.grantCount - 1 &&
    HMAC.test(evidence.nullReplayOrdinalHmac ?? "") &&
    HMAC.test(evidence.grantReplayOrdinalHmac ?? "") &&
    Number.isSafeInteger(evidence.stagingCount) &&
    evidence.stagingCount >= 2 &&
    evidence.stagingCount <= 16 &&
    evidence.stagingOverflow === false &&
    evidence.stagingExact === true &&
    HMAC.test(evidence.stagingOrdinalHmac ?? "") &&
    HMAC.test(evidence.stagingSequenceHmac ?? "") &&
    Array.isArray(evidence.lastRecords) &&
    evidence.lastRecords.length >= 1 &&
    evidence.lastRecords.length <= 2 &&
    evidence.lastRecords.every(
      (record) =>
        record !== null &&
        typeof record === "object" &&
        Object.keys(record).sort().join("\0") ===
          ["ordinal", "revision", "ownerHmac", "topologyHmac"].sort().join("\0") &&
        Number.isSafeInteger(record.ordinal) &&
        Number.isSafeInteger(record.revision) &&
        HMAC.test(record.ownerHmac ?? "") &&
        HMAC.test(record.topologyHmac ?? ""),
    )
  );
}

function exactAuthorityHandoff(handoff, expectedTui, expectedFocus, evidenceKey) {
  const transitions = handoff?.transitions;
  const ownerReleaseEvidence = handoff?.ownerReleaseEvidence;
  const expectedPaneHmac = expectedTui?.paneHmac;
  return (
    Array.isArray(transitions) &&
    transitions.length === 3 &&
    Array.isArray(ownerReleaseEvidence) &&
    ownerReleaseEvidence.length === transitions.length &&
    handoff?.retainedAuthorityEvidence?.authorityHmac === expectedFocus?.authorityHmac &&
    handoff?.retainedAuthorityEvidence?.authorityOwnerHmac === expectedFocus?.authorityOwnerHmac &&
    handoff?.retainedAuthorityEvidence?.authorityRevision === expectedFocus?.authorityRevision &&
    handoff?.retainedAuthorityEvidence?.authorityTopologyHmac ===
      expectedFocus?.authorityTopologyHmac &&
    Object.keys(handoff?.nullAuthorityEvidence ?? {})
      .sort()
      .join("\0") ===
      [
        "authorityHmac",
        "authorityMutationHmac",
        "authorityOwnerHmac",
        "authorityRevision",
        "authorityTopologyHmac",
      ]
        .sort()
        .join("\0") &&
    HMAC.test(handoff?.nullAuthorityEvidence?.authorityHmac ?? "") &&
    HMAC.test(handoff?.nullAuthorityEvidence?.authorityMutationHmac ?? "") &&
    HMAC.test(handoff?.nullAuthorityEvidence?.authorityOwnerHmac ?? "") &&
    Number.isSafeInteger(handoff?.nullAuthorityEvidence?.authorityRevision) &&
    HMAC.test(handoff?.nullAuthorityEvidence?.authorityTopologyHmac ?? "") &&
    HMAC.test(handoff?.postBlurAuthorityEvidence?.authorityHmac ?? "") &&
    HMAC.test(handoff?.postBlurAuthorityEvidence?.authorityOwnerHmac ?? "") &&
    Number.isSafeInteger(handoff?.postBlurAuthorityEvidence?.authorityRevision) &&
    HMAC.test(handoff?.postBlurAuthorityEvidence?.authorityTopologyHmac ?? "") &&
    transitions.every(
      (entry, ordinal) =>
        entry.ordinal === ordinal &&
        entry.client === ["opentui", "web-a", "web-b"][ordinal] &&
        entry.releaseObserved === true &&
        authorityReleaseEvidenceExact(entry.authorityReleaseEvidence) &&
        authorityJoinEvidenceExact(entry.authorityJoinEvidence) &&
        Object.keys(entry.nullAuthorityEvidence ?? {})
          .sort()
          .join("\0") ===
          [
            "authorityHmac",
            "authorityMutationHmac",
            "authorityOwnerHmac",
            "authorityRevision",
            "authorityTopologyHmac",
          ]
            .sort()
            .join("\0") &&
        [
          entry.nullAuthorityEvidence.authorityHmac,
          entry.nullAuthorityEvidence.authorityMutationHmac,
          entry.nullAuthorityEvidence.authorityOwnerHmac,
          entry.nullAuthorityEvidence.authorityTopologyHmac,
        ].every((value) => HMAC.test(value ?? "")) &&
        Number.isSafeInteger(entry.nullAuthorityEvidence.authorityRevision) &&
        entry.nullAuthorityEvidence.authorityRevision >
          entry.authorityReleaseEvidence.ownerRevision &&
        entry.nullAuthorityEvidence.authorityRevision >=
          Math.max(
            entry.authorityReleaseEvidence.tuiBlurRevision ?? 0,
            ...entry.authorityReleaseEvidence.receipts.map(({ afterRevision }) => afterRevision),
          ) &&
        exactHmacEqual(
          entry.releaseBindingHmac,
          card5AuthorityReleaseBindingHmac(entry, ownerReleaseEvidence[ordinal], evidenceKey),
        ) &&
        Object.keys(ownerReleaseEvidence[ordinal] ?? {})
          .sort()
          .join("\0") ===
          [
            "ownerReleaseSeal",
            "ownerTupleHmac",
            "expectedReleaseMapHmac",
            "expectedReleaseCount",
            "expectedWebReleaseCount",
            "expectedTuiReleaseCount",
            "expectedReleases",
            "tuiBlurSettlementHmac",
            "tuiBlurRevision",
            "tuiBlurClientHmac",
          ]
            .sort()
            .join("\0") &&
        ownerReleaseEvidence[ordinal].ownerReleaseSeal ===
          entry.authorityReleaseEvidence.ownerReleaseSeal &&
        ownerReleaseEvidence[ordinal].ownerTupleHmac ===
          entry.authorityReleaseEvidence.ownerTupleHmac &&
        HMAC.test(ownerReleaseEvidence[ordinal].ownerTupleHmac ?? "") &&
        ownerReleaseEvidence[ordinal].expectedReleaseMapHmac ===
          entry.authorityReleaseEvidence.expectedReleaseMapHmac &&
        ownerReleaseEvidence[ordinal].expectedReleaseCount ===
          entry.authorityReleaseEvidence.expectedReleaseCount &&
        ownerReleaseEvidence[ordinal].expectedWebReleaseCount ===
          entry.authorityReleaseEvidence.expectedWebReleaseCount &&
        ownerReleaseEvidence[ordinal].expectedTuiReleaseCount ===
          entry.authorityReleaseEvidence.expectedTuiReleaseCount &&
        ownerReleaseEvidence[ordinal].tuiBlurSettlementHmac ===
          entry.authorityReleaseEvidence.tuiBlurSettlementHmac &&
        ownerReleaseEvidence[ordinal].tuiBlurRevision ===
          entry.authorityReleaseEvidence.tuiBlurRevision &&
        ownerReleaseEvidence[ordinal].tuiBlurClientHmac ===
          entry.authorityReleaseEvidence.tuiBlurClientHmac &&
        Array.isArray(ownerReleaseEvidence[ordinal].expectedReleases) &&
        ownerReleaseEvidence[ordinal].expectedReleases.length ===
          entry.authorityReleaseEvidence.expectedReleaseCount &&
        new Set(ownerReleaseEvidence[ordinal].expectedReleases.map(({ authority }) => authority))
          .size === ownerReleaseEvidence[ordinal].expectedReleases.length &&
        ownerReleaseEvidence[ordinal].expectedReleases.every((expectedRelease) => {
          if (
            Object.keys(expectedRelease ?? {})
              .sort()
              .join("\0") !== "authority\0clientHmac\0requestHmac\0surface" ||
            !["input", "focus", "geometry"].includes(expectedRelease.authority) ||
            !["opentui", "web"].includes(expectedRelease.surface) ||
            !HMAC.test(expectedRelease.clientHmac ?? "") ||
            (expectedRelease.surface === "opentui"
              ? expectedRelease.requestHmac !== null
              : !HMAC.test(expectedRelease.requestHmac ?? ""))
          )
            return false;
          const matchingReceipts = entry.authorityReleaseEvidence.receipts.filter(
            (receipt) => receipt.authority === expectedRelease.authority,
          );
          return expectedRelease.surface === "web"
            ? matchingReceipts.length === 1 &&
                matchingReceipts[0].clientHmac === expectedRelease.clientHmac &&
                matchingReceipts[0].requestHmac === expectedRelease.requestHmac
            : matchingReceipts.length === 0 &&
                expectedRelease.clientHmac === entry.authorityReleaseEvidence.tuiBlurClientHmac;
        }) &&
        ownerReleaseEvidence[ordinal].expectedReleases.filter(({ surface }) => surface === "web")
          .length === entry.authorityReleaseEvidence.expectedWebReleaseCount &&
        ownerReleaseEvidence[ordinal].expectedReleases.filter(
          ({ surface }) => surface === "opentui",
        ).length === entry.authorityReleaseEvidence.expectedTuiReleaseCount &&
        entry.nullObserved === true &&
        entry.grantObserved === true &&
        entry.inputAccepted === true &&
        postHandoffAuthorityEvidenceExact(
          entry.postHandoffAuthorityEvidence,
          entry.grantRevision,
        ) &&
        entry.receiptSettled === true &&
        entry.renderedClientCount === 3 &&
        entry.renderedMarkerCount === 2 &&
        HMAC.test(entry.beforeRenditionHmac ?? "") &&
        HMAC.test(entry.renderedRenditionHmac ?? "") &&
        entry.beforeRenditionHmac !== entry.renderedRenditionHmac &&
        Number.isSafeInteger(entry.grantRevision) &&
        entry.grantRevision > entry.nullAuthorityEvidence.authorityRevision &&
        Number.isSafeInteger(entry.receiptOrdinal) &&
        entry.receiptOrdinal > 0 &&
        HMAC.test(entry.grantedClientHmac ?? "") &&
        entry.receiptClientHmac === entry.grantedClientHmac &&
        HMAC.test(entry.receiptRequestHmac ?? "") &&
        HMAC.test(entry.receiptPaneHmac ?? "") &&
        (ordinal === 0
          ? entry.tuiFocusEvidence !== null &&
            entry.tuiFocusEvidence?.paneHmac === expectedPaneHmac &&
            entry.tuiFocusEvidence?.processHmac === expectedTui?.processHmac &&
            entry.tuiFocusEvidence?.clockHmac === expectedTui?.clockHmac &&
            entry.tuiFocusEvidence?.retainedAuthorityHmac === expectedFocus?.authorityHmac &&
            entry.tuiFocusEvidence?.retainedAuthorityOwnerHmac ===
              expectedFocus?.authorityOwnerHmac &&
            entry.tuiFocusEvidence?.retainedAuthorityRevision ===
              expectedFocus?.authorityRevision &&
            entry.tuiFocusEvidence?.retainedAuthorityTopologyHmac ===
              expectedFocus?.authorityTopologyHmac &&
            entry.tuiFocusEvidence?.authorityHmac ===
              handoff.postBlurAuthorityEvidence.authorityHmac &&
            entry.tuiFocusEvidence?.authorityOwnerHmac ===
              handoff.postBlurAuthorityEvidence.authorityOwnerHmac &&
            entry.tuiFocusEvidence?.authorityRevision ===
              handoff.postBlurAuthorityEvidence.authorityRevision &&
            entry.tuiFocusEvidence?.authorityTopologyHmac ===
              handoff.postBlurAuthorityEvidence.authorityTopologyHmac &&
            HMAC.test(entry.tuiFocusEvidence?.authorityHmac ?? "") &&
            entry.tuiFocusEvidence?.authorityOwnerHmac === expectedFocus?.authorityOwnerHmac &&
            Number.isSafeInteger(entry.tuiFocusEvidence?.authorityRevision) &&
            entry.tuiFocusEvidence.authorityRevision > expectedFocus?.authorityRevision &&
            HMAC.test(entry.tuiFocusEvidence?.authorityTopologyHmac ?? "") &&
            entry.tuiFocusEvidence.authorityRevision ===
              entry.tuiFocusEvidence?.postBlurGrantRevision &&
            entry.tuiFocusEvidence.authorityRevision === entry.grantRevision &&
            HMAC.test(entry.tuiFocusEvidence?.transition?.hostPaneHmac ?? "") &&
            HMAC.test(entry.tuiFocusEvidence?.transition?.blurReceiptHmac ?? "") &&
            HMAC.test(entry.tuiFocusEvidence?.transition?.focusReceiptHmac ?? "") &&
            HMAC.test(entry.tuiFocusEvidence?.transition?.duplicateFocusReceiptHmac ?? "") &&
            HMAC.test(entry.tuiFocusEvidence?.transition?.blurSettlementHmac ?? "") &&
            HMAC.test(entry.tuiFocusEvidence?.transition?.focusSettlementHmac ?? "") &&
            HMAC.test(entry.tuiFocusEvidence?.transition?.lifecycleHmac ?? "") &&
            HMAC.test(entry.tuiFocusEvidence?.transition?.nullAuthorityHmac ?? "") &&
            HMAC.test(entry.tuiFocusEvidence?.transition?.nullAuthorityMutationHmac ?? "") &&
            HMAC.test(entry.tuiFocusEvidence?.transition?.nullAuthorityOwnerHmac ?? "") &&
            HMAC.test(entry.tuiFocusEvidence?.transition?.nullAuthorityTopologyHmac ?? "") &&
            entry.tuiFocusEvidence.transition.nullAuthorityHmac ===
              handoff.nullAuthorityEvidence.authorityHmac &&
            entry.tuiFocusEvidence.transition.nullAuthorityMutationHmac ===
              handoff.nullAuthorityEvidence.authorityMutationHmac &&
            entry.tuiFocusEvidence.transition.nullAuthorityOwnerHmac ===
              handoff.nullAuthorityEvidence.authorityOwnerHmac &&
            entry.tuiFocusEvidence.transition.nullAuthorityRevision ===
              handoff.nullAuthorityEvidence.authorityRevision &&
            entry.tuiFocusEvidence.transition.nullAuthorityTopologyHmac ===
              handoff.nullAuthorityEvidence.authorityTopologyHmac &&
            Number.isSafeInteger(entry.tuiFocusEvidence?.transition?.nullAuthorityRevision) &&
            entry.tuiFocusEvidence.transition.nullAuthorityRevision >
              entry.tuiFocusEvidence.retainedAuthorityRevision &&
            Number.isSafeInteger(entry.tuiFocusEvidence?.transition?.postInputRecordCount) &&
            entry.tuiFocusEvidence.transition.postInputRecordCount > 0 &&
            entry.tuiFocusEvidence?.transition?.blurEpoch >= 1 &&
            entry.tuiFocusEvidence?.transition?.focusEpoch ===
              entry.tuiFocusEvidence.transition.blurEpoch + 1 &&
            Number.isSafeInteger(entry.tuiFocusEvidence?.transition?.claimOrdinal) &&
            entry.tuiFocusEvidence.transition.claimOrdinal >= 1 &&
            Number.isSafeInteger(entry.tuiFocusEvidence?.transition?.blurRevision) &&
            entry.tuiFocusEvidence.transition.blurRevision >=
              entry.tuiFocusEvidence.retainedAuthorityRevision &&
            entry.tuiFocusEvidence.transition.blurRevision <=
              entry.tuiFocusEvidence.transition.nullAuthorityRevision &&
            entry.tuiFocusEvidence?.transition?.focusRevision === entry.grantRevision &&
            entry.tuiFocusEvidence?.transition?.clientHmac === entry.grantedClientHmac &&
            entry.tuiFocusEvidence?.transition?.claimCount === 1 &&
            entry.tuiFocusEvidence?.transition?.duplicateClaimCount === 0 &&
            entry.tuiFocusEvidence?.canonicalHmac === expectedFocus?.canonicalHmac &&
            HMAC.test(entry.tuiFocusEvidence?.canonicalHmac ?? "") &&
            HMAC.test(entry.tuiFocusEvidence?.presentationHmac ?? "") &&
            HMAC.test(entry.tuiFocusEvidence?.frameHmac ?? "") &&
            HMAC.test(entry.tuiFocusEvidence?.focusFenceHmac ?? "") &&
            Number.isSafeInteger(entry.tuiFocusEvidence?.rendererEpoch) &&
            entry.tuiFocusEvidence.rendererEpoch >= 1 &&
            entry.tuiFocusEvidence?.rendererEpochHmac ===
              evidenceHmac(
                evidenceKey,
                "retained-renderer-epoch",
                String(entry.tuiFocusEvidence.rendererEpoch),
              ) &&
            entry.tuiFocusEvidence?.focusStateHmac === expectedFocus?.focusStateHmac &&
            HMAC.test(entry.tuiFocusEvidence?.focusStateHmac ?? "") &&
            Number.isSafeInteger(entry.tuiFocusEvidence?.revision) &&
            Number.isSafeInteger(entry.tuiFocusEvidence?.cols) &&
            entry.tuiFocusEvidence.cols > 0 &&
            Number.isSafeInteger(entry.tuiFocusEvidence?.rows) &&
            entry.tuiFocusEvidence.rows > 0 &&
            Number.isSafeInteger(entry.tuiFocusEvidence?.viewportCols) &&
            entry.tuiFocusEvidence.viewportCols > 0 &&
            Number.isSafeInteger(entry.tuiFocusEvidence?.viewportRows) &&
            entry.tuiFocusEvidence.viewportRows > 0 &&
            entry.tuiFocusEvidence.viewportCols === expectedFocus?.viewportCols &&
            entry.tuiFocusEvidence.viewportRows === expectedFocus?.viewportRows &&
            entry.tuiInputTrace !== null &&
            entry.tuiFocusEvidence.revision === entry.tuiInputTrace?.originRevision &&
            entry.tuiFocusEvidence.cols === entry.tuiInputTrace?.cols &&
            entry.tuiFocusEvidence.rows === entry.tuiInputTrace?.rows &&
            HMAC.test(expectedPaneHmac ?? "") &&
            HMAC.test(entry.tuiInputTrace?.hostReceiptHmac ?? "") &&
            HMAC.test(entry.tuiInputTrace?.hostPaneHmac ?? "") &&
            HMAC.test(entry.tuiInputTrace?.traceHmac ?? "") &&
            HMAC.test(entry.tuiInputTrace?.payloadHmac ?? "") &&
            entry.tuiInputTrace?.paneHmac === entry.receiptPaneHmac &&
            entry.tuiInputTrace.paneHmac === expectedPaneHmac &&
            HMAC.test(entry.tuiInputTrace?.canonicalHmac ?? "") &&
            Number.isSafeInteger(entry.tuiInputTrace?.originRevision) &&
            Number.isSafeInteger(entry.tuiInputTrace?.fenceRevision) &&
            entry.tuiInputTrace.fenceRevision > entry.tuiInputTrace.originRevision &&
            Number.isSafeInteger(entry.tuiInputTrace?.cols) &&
            entry.tuiInputTrace.cols > 0 &&
            Number.isSafeInteger(entry.tuiInputTrace?.rows) &&
            entry.tuiInputTrace.rows > 0
          : entry.tuiFocusEvidence === null && entry.tuiInputTrace === null) &&
        HMAC.test(entry.operationHmac ?? "") &&
        HMAC.test(entry.markerHmac ?? ""),
    ) &&
    new Set(transitions.map(({ operationHmac }) => operationHmac)).size === 3 &&
    new Set(transitions.map(({ markerHmac }) => markerHmac)).size === 3 &&
    new Set(transitions.map(({ grantedClientHmac }) => grantedClientHmac)).size === 3 &&
    transitions.every(
      (entry, index) => index === 0 || entry.grantRevision > transitions[index - 1].grantRevision,
    )
  );
}

function exactStableGeometrySamples(samples) {
  return (
    Array.isArray(samples) &&
    samples.length >= 2 &&
    samples.every(
      ({
        clients,
        authorityRevision,
        ownerCount,
        passiveCount,
        geometryFightCount,
        nativeCols,
        nativeRows,
        topologyHmac,
        nativeLayoutHmac,
      }) =>
        Array.isArray(clients) &&
        clients.length === 3 &&
        clients.map(({ client }) => client).join("\0") === "opentui\0web-a\0web-b" &&
        new Set(clients.map(({ clientHmac }) => clientHmac)).size === 3 &&
        new Set(clients.map(({ cols, rows }) => `${cols}x${rows}`)).size === 1 &&
        clients.every(
          (client) =>
            HMAC.test(client.clientHmac ?? "") &&
            Number.isSafeInteger(client.authorityRevision) &&
            client.authorityRevision === authorityRevision &&
            Number.isSafeInteger(client.connectedRevision) &&
            Number.isSafeInteger(client.activityRevision) &&
            typeof client.source === "string" &&
            typeof client.geometryOwner === "boolean" &&
            typeof client.passive === "boolean" &&
            client.geometryOwner !== client.passive,
        ) &&
        ownerCount === 1 &&
        passiveCount === 2 &&
        geometryFightCount === 0 &&
        clients.every(({ cols, rows }) => cols === nativeCols && rows === nativeRows) &&
        HMAC.test(topologyHmac ?? "") &&
        HMAC.test(nativeLayoutHmac ?? ""),
    ) &&
    new Set(samples.map(({ authorityRevision }) => authorityRevision)).size === 1 &&
    new Set(samples.map(({ topologyHmac }) => topologyHmac)).size === 1 &&
    new Set(samples.map(({ nativeLayoutHmac }) => nativeLayoutHmac)).size === 1
  );
}

function exactGeometryEvidence(geometry) {
  const samples = geometry?.samples;
  return (
    HMAC.test(geometry?.challenge?.receiptHmac ?? "") &&
    HMAC.test(geometry?.challenge?.authorityClientHmac ?? "") &&
    HMAC.test(geometry?.challenge?.requestHmac ?? "") &&
    Number.isSafeInteger(geometry?.challenge?.seq) &&
    geometry.challenge.seq > 0 &&
    exactStableGeometrySamples(samples) &&
    samples[0].clients.some(
      ({ clientHmac, geometryOwner, cols, rows }) =>
        clientHmac === geometry.challenge.authorityClientHmac &&
        geometryOwner === true &&
        cols === geometry.challenge.cols &&
        rows === geometry.challenge.rows,
    )
  );
}

function exactReplacementGeometry(geometry) {
  const clients = geometry?.clients;
  const samples = geometry?.samples;
  return (
    geometry?.authorityEqual === true &&
    geometry?.physicalClientCount === 3 &&
    geometry?.uniquePhysicalClientCount === 3 &&
    Number.isSafeInteger(geometry?.authorityRevision) &&
    HMAC.test(geometry?.topologyHmac ?? "") &&
    Array.isArray(clients) &&
    clients.length === 3 &&
    clients.map(({ client }) => client).join("\0") === "opentui\0web-a\0web-b" &&
    new Set(clients.map(({ clientHmac }) => clientHmac)).size === 3 &&
    clients.filter(({ geometryOwner }) => geometryOwner).length === 1 &&
    clients.filter(({ passive }) => passive).length === 2 &&
    new Set(clients.map(({ cols, rows }) => `${cols}x${rows}`)).size === 1 &&
    clients.every(
      ({
        client,
        clientHmac,
        geometryOwner,
        passive,
        observedGeometryOwner,
        observedPassive,
        cols,
        rows,
      }) =>
        HMAC.test(clientHmac ?? "") &&
        geometryOwner !== passive &&
        Number.isSafeInteger(cols) &&
        Number.isSafeInteger(rows) &&
        (client === "opentui" ||
          (observedGeometryOwner === geometryOwner && observedPassive === passive)),
    ) &&
    exactStableGeometrySamples(samples) &&
    samples.every(
      (sample) =>
        sample.authorityRevision === geometry.authorityRevision &&
        sample.topologyHmac === geometry.topologyHmac &&
        sample.clients.every((sampleClient, index) => {
          const outer = clients[index];
          return (
            sampleClient.client === outer.client &&
            sampleClient.clientHmac === outer.clientHmac &&
            sampleClient.geometryOwner === outer.geometryOwner &&
            sampleClient.passive === outer.passive &&
            sampleClient.cols === outer.cols &&
            sampleClient.rows === outer.rows
          );
        }),
    )
  );
}

function exactSlowIsolation(slowWeb, expectedClient) {
  const samples = slowWeb?.samples;
  const resourceProcessIds = new Set(samples?.map((sample) => sample.resource?.processId));
  const resourceClockIds = new Set(samples?.map((sample) => sample.resource?.clockId));
  return (
    slowWeb?.blockedSinkObserved === true &&
    Array.isArray(samples) &&
    samples.length === 30 &&
    samples.every(
      (sample) =>
        Number.isSafeInteger(sample.sampleOrdinal) &&
        Number.isFinite(sample.inputPaintMs) &&
        HMAC.test(sample.traceHmac ?? "") &&
        HMAC.test(sample.markerHmac ?? "") &&
        HMAC.test(sample.inputReceiptHmac ?? "") &&
        Number.isSafeInteger(sample.queueCurrent) &&
        Number.isSafeInteger(sample.queuePeak) &&
        Number.isSafeInteger(sample.queueCap) &&
        sample.queueCurrent >= 0 &&
        sample.queuePeak >= sample.queueCurrent &&
        sample.queuePeak <= sample.queueCap &&
        sample.ackSettled === true &&
        HMAC.test(sample.deliveryLaneHmac ?? "") &&
        HMAC.test(sample.deliveryRequestHmac ?? "") &&
        HMAC.test(sample.transactionHmac ?? "") &&
        HMAC.test(sample.settlementTraceHmac ?? "") &&
        sample.settlementTraceHmac === sample.fenceTraceHmac &&
        sample.matchingSettlementCount === 1 &&
        HMAC.test(sample.fenceCanonicalHmac ?? "") &&
        sample.fenceCanonicalHmac === sample.ackCanonicalHmac &&
        sample.matchingAckCount === 1 &&
        Number.isSafeInteger(sample.ackOrdinal) &&
        Number.isSafeInteger(sample.ackBoundary) &&
        sample.ackOrdinal >= sample.ackBoundary &&
        Number.isSafeInteger(sample.canonicalRevision) &&
        sample.deliveryFenceSettled === true &&
        sample.writerHealth?.droppedRecords === 0 &&
        sample.writerHealth?.oversizedRecords === 0 &&
        sample.writerHealth?.failed === false &&
        sample.writerHealth?.pendingCriticalRecords === 0 &&
        /^opentui:[1-9]\d*$/u.test(sample.resource?.processId ?? "") &&
        sample.resource?.processIdentityExact === true &&
        sample.resource?.clockId === "opentui-performance-now" &&
        sample.resource?.processHmac === expectedClient?.processHmac &&
        sample.resource?.clockHmac === expectedClient?.clockHmac &&
        Number.isSafeInteger(sample.resource?.atMicros) &&
        HMAC.test(sample.resource?.resourceEpochIdentityHmac ?? "") &&
        sample.resource?.canonicalIdentityHmac === sample.fenceCanonicalHmac &&
        Number.isSafeInteger(sample.resource?.rssBytes) &&
        sample.resource.rssBytes >= 0 &&
        sample.resource.rssBytes <= 1_073_741_824 &&
        Number.isSafeInteger(sample.resource?.heapUsedBytes) &&
        sample.resource.heapUsedBytes >= 0 &&
        sample.resource.heapUsedBytes <= 536_870_912 &&
        Number.isSafeInteger(sample.resource?.rssPeakBytes) &&
        sample.resource.rssPeakBytes >= sample.resource.rssBytes &&
        sample.resource.rssPeakBytes <= 1_073_741_824 &&
        Number.isSafeInteger(sample.resource?.heapUsedPeakBytes) &&
        sample.resource.heapUsedPeakBytes >= sample.resource.heapUsedBytes &&
        sample.resource.heapUsedPeakBytes <= 536_870_912 &&
        sample.resource.inputPending === 0 &&
        sample.resource.inputInFlight === 0 &&
        sample.resource.inputPendingBytes === 0 &&
        sample.resource.inputPendingPeak === 0 &&
        sample.resource.inputInFlightPeak === 0 &&
        sample.resource.inputPendingBytesPeak === 0 &&
        sample.resource.resourceSamplingFailureCount === 0 &&
        Number.isSafeInteger(sample.resource?.eventLoopDelayMicros) &&
        sample.resource.eventLoopDelayMicros >= 0 &&
        sample.resource.eventLoopDelayMicros <= 33_000 &&
        Number.isSafeInteger(sample.resource?.eventLoopDelayPeakMicros) &&
        sample.resource.eventLoopDelayPeakMicros >= sample.resource.eventLoopDelayMicros &&
        sample.resource.eventLoopDelayPeakMicros <= 100_000,
    ) &&
    resourceProcessIds.size === 1 &&
    resourceClockIds.size === 1 &&
    samples.every(
      (sample, index) =>
        sample.sampleOrdinal === index &&
        (index === 0 ||
          (sample.resource.atMicros > samples[index - 1].resource.atMicros &&
            sample.ackOrdinal > samples[index - 1].ackOrdinal &&
            sample.canonicalRevision > samples[index - 1].canonicalRevision &&
            sample.resource.rssPeakBytes >= samples[index - 1].resource.rssPeakBytes &&
            sample.resource.heapUsedPeakBytes >= samples[index - 1].resource.heapUsedPeakBytes &&
            sample.resource.eventLoopDelayPeakMicros >=
              samples[index - 1].resource.eventLoopDelayPeakMicros)),
    ) &&
    new Set(samples.map(({ traceHmac }) => traceHmac)).size === samples.length &&
    new Set(samples.map(({ markerHmac }) => markerHmac)).size === samples.length &&
    new Set(samples.map(({ transactionHmac }) => transactionHmac)).size === samples.length &&
    slowWeb?.droppedCriticalObserved === 0 &&
    slowWeb?.catchUpExact === true
  );
}

function exactPrivacyCorrelation(evidence, correlationComplete) {
  return (
    correlationComplete === true &&
    evidence?.correlation?.complete === true &&
    Number.isSafeInteger(evidence?.correlation?.recordCount) &&
    evidence.correlation.recordCount > 0 &&
    evidence?.correlation?.missingJoinCount === 0 &&
    evidence?.correlation?.duplicateJoinCount === 0 &&
    HMAC.test(evidence?.correlation?.journeyHmac ?? "") &&
    evidence?.privacy?.scannedRecordCount === evidence.correlation.recordCount &&
    evidence?.privacy?.rawOwnerTokenCount === 0 &&
    evidence?.privacy?.rawCapabilityCount === 0 &&
    evidence?.privacy?.rawPaneContentCount === 0
  );
}

function boundary(id, passed, detail) {
  return Object.freeze({ id, status: passed ? "passed" : "failed", detail });
}

export function assessCard5CrossClientEvidence({ evidence, correlationComplete, evidenceKey }) {
  const beforeGeneration = evidence?.generations?.before ?? null;
  const afterGeneration = evidence?.generations?.after ?? null;
  const boundaries = [
    boundary(
      CARD5_CROSS_CLIENT_BOUNDARIES[0],
      exactObservedHostLedger(evidence?.hosts),
      "three production WorkspaceClient hosts",
    ),
    boundary(
      CARD5_CROSS_CLIENT_BOUNDARIES[1],
      converged(evidence?.before?.clients, beforeGeneration) &&
        exactFocusedConvergence(
          evidence?.before?.focusedPaneEvidence,
          evidence?.before?.clients?.opentui,
        ),
      "OpenTUI and both Web clients share one canonical hash",
    ),
    boundary(
      CARD5_CROSS_CLIENT_BOUNDARIES[2],
      exactAuthorityHandoff(
        evidence?.handoff,
        evidence?.before?.clients?.opentui,
        evidence?.before?.focusedPaneEvidence,
        evidenceKey,
      ),
      "three foreground/input handoffs with exact executable authority",
    ),
    boundary(
      CARD5_CROSS_CLIENT_BOUNDARIES[3],
      exactGeometryEvidence(evidence?.geometry),
      "one geometry owner, two passive clients, zero native mutation",
    ),
    boundary(
      CARD5_CROSS_CLIENT_BOUNDARIES[4],
      exactSlowIsolation(evidence?.slowWeb, evidence?.before?.clients?.opentui) &&
        evidence?.slowWeb?.hidden === true &&
        Number.isFinite(evidence?.slowWeb?.tuiInputP95Ms) &&
        evidence.slowWeb.tuiInputP95Ms <= 16.67 &&
        Number.isFinite(evidence?.slowWeb?.tuiInputP99Ms) &&
        evidence.slowWeb.tuiInputP99Ms <= 33 &&
        Number.isSafeInteger(evidence?.slowWeb?.queuePeak) &&
        evidence.slowWeb.queuePeak >= 0 &&
        evidence.slowWeb.queuePeak <= evidence.slowWeb.queueCap,
      "hidden slow Web client cannot move OpenTUI latency or exceed its queue",
    ),
    boundary(
      CARD5_CROSS_CLIENT_BOUNDARIES[5],
      typeof beforeGeneration === "string" &&
        typeof afterGeneration === "string" &&
        beforeGeneration !== afterGeneration &&
        evidence?.restart?.staleGenerationRejected === true &&
        Array.isArray(evidence?.restart?.staleRedemptions) &&
        evidence.restart.staleRedemptions.length === 2 &&
        evidence.restart.staleRedemptions.every(
          ({ rejected, typed, reason }) =>
            rejected === true &&
            typed === true &&
            ["redemption-rejected", "ticket-expired"].includes(reason),
        ) &&
        exactObservedHostLedger({ lifecycle: evidence?.restart?.replacementLifecycle }) &&
        evidence?.restart?.elapsedMs <= 5_000,
      "daemon generation replaced within the existing recovery deadline",
    ),
    boundary(
      CARD5_CROSS_CLIENT_BOUNDARIES[6],
      converged(evidence?.after?.clients, afterGeneration),
      "all three production clients reconverged on the replacement hash",
    ),
    boundary(
      CARD5_CROSS_CLIENT_BOUNDARIES[7],
      evidence?.nativeObserver?.readOnly === true &&
        evidence?.nativeObserver?.markerPresent === true &&
        HMAC.test(evidence?.nativeObserver?.markerHmac ?? "") &&
        evidence.nativeObserver.markerHmac ===
          evidence?.handoff?.transitions?.[evidence.handoff.transitions.length - 1]?.markerHmac &&
        HMAC.test(evidence?.nativeObserver?.paneHmac ?? "") &&
        Object.values(evidence?.after?.clients ?? {}).every(
          (client) => client?.paneHmac === evidence.nativeObserver.paneHmac,
        ) &&
        HMAC.test(evidence?.nativeObserver?.contentHmac ?? "") &&
        evidence?.nativeObserver?.mutationCount === 0 &&
        evidence?.nativeObserver?.beforeLayoutHmac === evidence?.nativeObserver?.afterLayoutHmac &&
        evidence?.nativeObserver?.validatedCommandCount === 3 &&
        evidence?.nativeObserver?.activeProcessCount === 0,
      "tmux truth was observed without joining client authority",
    ),
    boundary(
      CARD5_CROSS_CLIENT_BOUNDARIES[8],
      exactPrivacyCorrelation(evidence, correlationComplete),
      "bounded correlation is complete and secret/content free",
    ),
  ];
  const first = boundaries.find(({ status }) => status !== "passed") ?? null;
  return Object.freeze({
    qualified: first === null,
    status: first ? "failed" : "passed",
    firstBrokenBoundary: first?.id ?? null,
    firstUnmeasuredBoundary: null,
    boundaries: Object.freeze(boundaries),
  });
}

export function card5CrossClientFailureObservation(assessment, evidence) {
  const failedIndex = Math.max(
    0,
    CARD5_CROSS_CLIENT_BOUNDARIES.indexOf(assessment?.firstBrokenBoundary),
  );
  return Object.freeze({
    operation: "card5-cross-client-live-proof",
    reason: "boundary-failed",
    boundary: CARD5_CROSS_CLIENT_BOUNDARIES[failedIndex] ?? "cross-client-production-hosts",
    boundaryOrdinal: Math.min(failedIndex, CARD5_CROSS_CLIENT_BOUNDARIES.length - 1),
    beforeClients: Math.min(Object.keys(evidence?.before?.clients ?? {}).length, 3),
    afterClients: Math.min(Object.keys(evidence?.after?.clients ?? {}).length, 3),
    handoffEchoes: Math.min(
      evidence?.handoff?.transitions?.filter(({ inputAccepted }) => inputAccepted === true)
        .length ?? 0,
      3,
    ),
    geometryFightCount: Math.min(
      evidence?.geometry?.samples?.filter(({ ownerCount }) => ownerCount !== 1).length ?? 0,
      65_535,
    ),
    slowQueuePeak: Math.min(Math.max(evidence?.slowWeb?.queuePeak ?? 0, 0), 65_535),
    restartElapsedMs: Number.isFinite(evidence?.restart?.elapsedMs)
      ? Math.min(Math.max(Math.round(evidence.restart.elapsedMs), 0), 60_000)
      : null,
    correlationComplete: evidence?.correlation?.complete === true,
    slowSampleCount: Math.min(evidence?.slowWeb?.samples?.length ?? 0, 65_535),
    lastInputPaintMs: Number.isFinite(evidence?.slowWeb?.samples?.at(-1)?.inputPaintMs)
      ? Math.min(Math.max(evidence.slowWeb.samples.at(-1).inputPaintMs, 0), 60_000)
      : null,
    lastCanonicalRevision: Number.isSafeInteger(evidence?.after?.clients?.opentui?.revision)
      ? Math.min(evidence.after.clients.opentui.revision, 0xffff_ffff)
      : null,
  });
}

export function assessCard5DaemonRestartEvidence({ evidence, correlationComplete }) {
  const beforeGeneration = evidence?.generations?.before ?? null;
  const afterGeneration = evidence?.generations?.after ?? null;
  const hostExact = exactObservedHostLedger(evidence?.hosts);
  const boundaries = [
    boundary(CARD5_DAEMON_RESTART_BOUNDARIES[0], hostExact, "three production host adapters"),
    boundary(
      CARD5_DAEMON_RESTART_BOUNDARIES[1],
      converged(evidence?.before?.clients, beforeGeneration),
      "all hosts share the predecessor canonical hash",
    ),
    boundary(
      CARD5_DAEMON_RESTART_BOUNDARIES[2],
      typeof beforeGeneration === "string" &&
        typeof afterGeneration === "string" &&
        beforeGeneration !== afterGeneration &&
        evidence?.restart?.elapsedMs <= 5_000,
      "daemon generation replaced inside the fixed recovery deadline",
    ),
    boundary(
      CARD5_DAEMON_RESTART_BOUNDARIES[3],
      evidence?.restart?.staleDescriptorRejected === true &&
        Array.isArray(evidence?.restart?.staleRedemptions) &&
        evidence.restart.staleRedemptions.length === 2 &&
        evidence.restart.staleRedemptions.every(
          ({ rejected, typed, reason }) =>
            rejected === true &&
            typed === true &&
            ["redemption-rejected", "ticket-expired"].includes(reason),
        ) &&
        evidence?.restart?.staleSocketRejected === true &&
        evidence?.restart?.staleGenerationError === "generation-replaced" &&
        evidence?.restart?.replacementFirstEnvelope === "seed" &&
        evidence?.restart?.replacementSeedGeneration === afterGeneration &&
        evidence?.restart?.predecessorEnvelopeAcceptedAfterReplace === false,
      "G2 starts with a seed and typed fencing rejects every stale G1 authority",
    ),
    boundary(
      CARD5_DAEMON_RESTART_BOUNDARIES[4],
      evidence?.restart?.reconnectedHosts === 3 &&
        evidence?.restart?.physicalClientCount === 3 &&
        exactObservedHostLedger({ lifecycle: evidence?.restart?.replacementLifecycle }) &&
        evidence?.restart?.duplicatePhysicalClients === 0 &&
        evidence?.restart?.geometryFightCount === 0 &&
        exactReplacementGeometry(evidence?.restart?.replacementGeometry) &&
        Array.isArray(evidence?.restart?.socketOutcomes) &&
        evidence.restart.socketOutcomes.length === 5 &&
        evidence.restart.socketOutcomes.filter(({ outcome }) => outcome === "predecessor-closed")
          .length === 2 &&
        evidence.restart.socketOutcomes.filter(({ outcome }) => outcome === "replacement-open")
          .length === 3,
      "three hosts reconnect once without geometry conflict",
    ),
    boundary(
      CARD5_DAEMON_RESTART_BOUNDARIES[5],
      converged(evidence?.after?.clients, afterGeneration),
      "all hosts share the replacement canonical hash",
    ),
    boundary(
      CARD5_DAEMON_RESTART_BOUNDARIES[6],
      exactPrivacyCorrelation(evidence, correlationComplete),
      "restart correlation is complete and privacy bounded",
    ),
  ];
  const first = boundaries.find(({ status }) => status !== "passed") ?? null;
  return Object.freeze({
    qualified: first === null,
    status: first ? "failed" : "passed",
    firstBrokenBoundary: first?.id ?? null,
    firstUnmeasuredBoundary: null,
    boundaries: Object.freeze(boundaries),
  });
}

export function card5DaemonRestartFailureObservation(assessment, evidence) {
  const failedIndex = Math.max(
    0,
    CARD5_DAEMON_RESTART_BOUNDARIES.indexOf(assessment?.firstBrokenBoundary),
  );
  return Object.freeze({
    operation: "card5-daemon-restart-live-proof",
    reason: "boundary-failed",
    boundary: CARD5_DAEMON_RESTART_BOUNDARIES[failedIndex] ?? "daemon-restart-production-hosts",
    boundaryOrdinal: Math.min(failedIndex, CARD5_DAEMON_RESTART_BOUNDARIES.length - 1),
    beforeClients: Math.min(Object.keys(evidence?.before?.clients ?? {}).length, 3),
    afterClients: Math.min(Object.keys(evidence?.after?.clients ?? {}).length, 3),
    reconnectedHosts: Math.min(Math.max(evidence?.restart?.reconnectedHosts ?? 0, 0), 3),
    duplicatePhysicalClients: Math.min(
      Math.max(evidence?.restart?.duplicatePhysicalClients ?? 0, 0),
      65_535,
    ),
    restartElapsedMs: Number.isFinite(evidence?.restart?.elapsedMs)
      ? Math.min(Math.max(Math.round(evidence.restart.elapsedMs), 0), 60_000)
      : null,
    correlationComplete: evidence?.correlation?.complete === true,
    replacementFirstEnvelope: ["seed", "patch"].includes(
      evidence?.restart?.replacementFirstEnvelope,
    )
      ? evidence.restart.replacementFirstEnvelope
      : null,
    socketOutcomeCount: Math.min(evidence?.restart?.socketOutcomes?.length ?? 0, 5),
    lastCanonicalRevision: Number.isSafeInteger(evidence?.after?.clients?.opentui?.revision)
      ? Math.min(evidence.after.clients.opentui.revision, 0xffff_ffff)
      : null,
  });
}
