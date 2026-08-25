import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  CARD5_CROSS_CLIENT_BOUNDARIES,
  CARD5_DAEMON_RESTART_BOUNDARIES,
  assessCard5CrossClientEvidence as assessCard5CrossClientEvidenceRaw,
  assessCard5DaemonRestartEvidence,
  card5AuthorityReleaseBindingDigest,
  card5AuthorityReleaseBindingHmac,
  card5CrossClientFailureObservation,
  card5DaemonRestartFailureObservation,
} from "./product-cross-client-handoff.mjs";

const HASH = "a".repeat(16);
const HMAC = "c".repeat(64);
const KEY = "1".repeat(64);
const evidenceHmac = (key, domain, value) =>
  createHmac("sha256", Buffer.from(key, "hex")).update(`${domain}\0${value}`).digest("hex");
const assessCard5CrossClientEvidence = (input) =>
  assessCard5CrossClientEvidenceRaw({ ...input, evidenceKey: input.evidenceKey ?? KEY });
const hostLedger = () =>
  ["opentui", "web-a", "web-b"].map((client, openOrdinal) => ({
    client,
    opened: true,
    processHmac: String(openOrdinal + 1).repeat(64),
    requestHmac: String(openOrdinal + 4).repeat(64),
    socketObserved: client !== "opentui",
    socketHmac: client === "opentui" ? null : String(openOrdinal + 7).repeat(64),
    laneHmac: String(openOrdinal + 1).repeat(64),
    clientHmac: String(openOrdinal + 4).repeat(64),
    openOrdinal,
  }));
const authorityTransitions = () =>
  ["opentui", "web-a", "web-b"].map((client, ordinal) => ({
    client,
    ordinal,
    releaseObserved: true,
    authorityReleaseEvidence: {
      ownerTupleHmac: HMAC,
      ownerRevision: ordinal,
      ownerReleaseSeal: HMAC,
      expectedReleaseMapHmac: HMAC,
      expectedReleaseCount: ordinal === 0 ? 3 : 1,
      expectedWebReleaseCount: ordinal === 0 ? 0 : 1,
      expectedTuiReleaseCount: ordinal === 0 ? 3 : 0,
      tuiBlurSettlementHmac: ordinal === 0 ? HMAC : null,
      tuiBlurRevision: ordinal === 0 ? 1 : null,
      tuiBlurClientHmac: ordinal === 0 ? HMAC : null,
      receipts:
        ordinal === 0
          ? []
          : [
              {
                authority: "input",
                status: "released",
                operationOrdinal: ordinal,
                beforeRevision: ordinal,
                afterRevision: ordinal + 1,
                workspaceHmac: HMAC,
                generationHmac: HMAC,
                runtimeSessionHmac: HMAC,
                paneHmac: HMAC,
                requestHmac: HMAC,
                clientHmac: HMAC,
              },
            ],
    },
    authorityJoinEvidence: {
      nullCount: 1,
      nullOverflow: false,
      grantCount: 1,
      grantOverflow: false,
      receiptCount: ordinal === 0 ? 0 : 1,
      nullExact: true,
      grantExact: true,
      receiptExact: true,
      boundary: ordinal,
      boundaryOverflow: false,
      nullReplayCount: 0,
      nullReplayOrdinalHmac: HMAC,
      grantReplayCount: 0,
      grantReplayOrdinalHmac: HMAC,
      stagingCount: 2,
      stagingOverflow: false,
      stagingExact: true,
      stagingOrdinalHmac: HMAC,
      stagingSequenceHmac: HMAC,
      lastRecords: [
        {
          ordinal: ordinal + 1,
          revision: ordinal + 2,
          ownerHmac: HMAC,
          topologyHmac: HMAC,
        },
      ],
    },
    nullAuthorityEvidence: {
      authorityHmac: HMAC,
      authorityMutationHmac: HMAC,
      authorityOwnerHmac: HMAC,
      authorityRevision: ordinal + 2,
      authorityTopologyHmac: HMAC,
    },
    nullObserved: true,
    grantObserved: true,
    inputAccepted: true,
    receiptSettled: true,
    renderedClientCount: 3,
    renderedMarkerCount: 2,
    beforeRenditionHmac: String(ordinal + 1).repeat(64),
    renderedRenditionHmac: String(ordinal + 4).repeat(64),
    grantRevision: ordinal + 4,
    postHandoffAuthorityEvidence: {
      mode: "post-handoff",
      relation: "retained-owner",
      grantRevision: ordinal + 4,
      currentRevision: ordinal + 4,
      releaseRevision: null,
      relationHmac: HMAC,
      sequenceHmac: HMAC,
      inputProofHmac: HMAC,
      authorityHmac: HMAC,
      authorityOwnerHmac: HMAC,
      authorityTopologyHmac: HMAC,
      authorityMutationHmac: HMAC,
      duplicateCount: 0,
    },
    grantedClientHmac: String(ordinal + 1).repeat(64),
    receiptClientHmac: String(ordinal + 1).repeat(64),
    receiptRequestHmac: String(ordinal + 7).repeat(64),
    receiptOrdinal: ordinal + 1,
    receiptPaneHmac: HMAC,
    tuiFocusEvidence:
      ordinal === 0
        ? {
            paneHmac: HMAC,
            processHmac: "1".repeat(64),
            clockHmac: HMAC,
            authorityHmac: "e".repeat(64),
            authorityOwnerHmac: HMAC,
            authorityRevision: 4,
            authorityTopologyHmac: "d".repeat(64),
            retainedAuthorityHmac: HMAC,
            retainedAuthorityOwnerHmac: HMAC,
            retainedAuthorityRevision: 0,
            retainedAuthorityTopologyHmac: HMAC,
            postBlurGrantRevision: 4,
            transition: {
              hostPaneHmac: HMAC,
              blurReceiptHmac: HMAC,
              focusReceiptHmac: HMAC,
              duplicateFocusReceiptHmac: HMAC,
              blurSettlementHmac: HMAC,
              focusSettlementHmac: HMAC,
              lifecycleHmac: HMAC,
              nullAuthorityHmac: HMAC,
              nullAuthorityMutationHmac: HMAC,
              nullAuthorityOwnerHmac: HMAC,
              nullAuthorityRevision: 1,
              nullAuthorityTopologyHmac: HMAC,
              postInputRecordCount: 20,
              blurEpoch: 1,
              focusEpoch: 2,
              claimOrdinal: 2,
              blurRevision: 1,
              focusRevision: 4,
              clientHmac: "1".repeat(64),
              claimCount: 1,
              duplicateClaimCount: 0,
            },
            canonicalHmac: HMAC,
            presentationHmac: HMAC,
            frameHmac: HMAC,
            focusFenceHmac: HMAC,
            rendererEpoch: 3,
            rendererEpochHmac: evidenceHmac(KEY, "retained-renderer-epoch", "3"),
            focusStateHmac: HMAC,
            revision: 7,
            cols: 120,
            rows: 40,
            viewportCols: 70,
            viewportRows: 20,
          }
        : null,
    tuiInputTrace:
      ordinal === 0
        ? {
            hostReceiptHmac: HMAC,
            hostPaneHmac: HMAC,
            traceHmac: HMAC,
            payloadHmac: HMAC,
            paneHmac: HMAC,
            canonicalHmac: HMAC,
            originRevision: 7,
            fenceRevision: 8,
            cols: 120,
            rows: 40,
          }
        : null,
    operationHmac: String(ordinal + 4).repeat(64),
    markerHmac: String(ordinal + 4).repeat(64),
  }));
const slowSamples = () =>
  Array.from({ length: 30 }, (_, ordinal) => ({
    sampleOrdinal: ordinal,
    inputPaintMs: 3,
    traceHmac: (ordinal + 1).toString(16).padStart(64, "0"),
    markerHmac: (ordinal + 33).toString(16).padStart(64, "0"),
    inputReceiptHmac: (ordinal + 65).toString(16).padStart(64, "0"),
    queueCurrent: 0,
    queuePeak: 4,
    queueCap: 32,
    ackSettled: true,
    deliveryLaneHmac: HMAC,
    deliveryRequestHmac: HMAC,
    transactionHmac: (ordinal + 97).toString(16).padStart(64, "0"),
    settlementTraceHmac: (ordinal + 1).toString(16).padStart(64, "0"),
    fenceTraceHmac: (ordinal + 1).toString(16).padStart(64, "0"),
    fenceCanonicalHmac: (ordinal + 129).toString(16).padStart(64, "0"),
    ackCanonicalHmac: (ordinal + 129).toString(16).padStart(64, "0"),
    matchingAckCount: 1,
    matchingSettlementCount: 1,
    ackOrdinal: ordinal + 1,
    ackBoundary: ordinal + 1,
    canonicalRevision: ordinal + 1,
    deliveryFenceSettled: true,
    writerHealth: {
      droppedRecords: 0,
      oversizedRecords: 0,
      failed: false,
      pendingCriticalRecords: 0,
    },
    resource: {
      processId: "opentui:123",
      processIdentityExact: true,
      clockId: "opentui-performance-now",
      processHmac: "1".repeat(64),
      clockHmac: HMAC,
      atMicros: 10_000 + ordinal,
      resourceEpochIdentityHmac: (ordinal + 161).toString(16).padStart(64, "0"),
      canonicalIdentityHmac: (ordinal + 129).toString(16).padStart(64, "0"),
      rssBytes: 256 * 1_048_576 + ordinal,
      heapUsedBytes: 128 * 1_048_576 + ordinal,
      rssPeakBytes: 256 * 1_048_576 + ordinal,
      heapUsedPeakBytes: 128 * 1_048_576 + ordinal,
      inputPending: 0,
      inputInFlight: 0,
      inputPendingBytes: 0,
      inputPendingPeak: 0,
      inputInFlightPeak: 0,
      inputPendingBytesPeak: 0,
      resourceSamplingFailureCount: 0,
      eventLoopDelayMicros: 1_000,
      eventLoopDelayPeakMicros: 20_000,
    },
  }));
const client = (generation, processDigit) => ({
  connected: true,
  generation,
  canonicalStateHash: HASH,
  revision: 7,
  cols: 120,
  rows: 40,
  deliveryFence: 9,
  atMicros: 10_000,
  connectElapsedMs: 100,
  workspaceHmac: HMAC,
  paneHmac: HMAC,
  incarnationHmac: HMAC,
  processHmac: processDigit.repeat(64),
  clockHmac: HMAC,
  renditionHmac: processDigit === "1" ? null : HMAC,
});
const clients = (generation) => ({
  opentui: client(generation, "1"),
  "web-a": client(generation, "2"),
  "web-b": client(generation, "3"),
});
const focusedPaneEvidence = () => ({
  paneHmac: HMAC,
  processHmac: "1".repeat(64),
  clockHmac: HMAC,
  authorityHmac: HMAC,
  authorityOwnerHmac: HMAC,
  authorityRevision: 0,
  authorityTopologyHmac: HMAC,
  canonicalHmac: HMAC,
  presentationHmac: HMAC,
  frameHmac: HMAC,
  focusFenceHmac: HMAC,
  focusStateHmac: HMAC,
  revision: 7,
  cols: 120,
  rows: 40,
  viewportCols: 70,
  viewportRows: 20,
});

function evidence() {
  const transitions = authorityTransitions();
  const ownerReleaseEvidence = transitions.map(({ authorityReleaseEvidence }) => ({
    ownerTupleHmac: authorityReleaseEvidence.ownerTupleHmac,
    ownerReleaseSeal: authorityReleaseEvidence.ownerReleaseSeal,
    expectedReleaseMapHmac: authorityReleaseEvidence.expectedReleaseMapHmac,
    expectedReleaseCount: authorityReleaseEvidence.expectedReleaseCount,
    expectedWebReleaseCount: authorityReleaseEvidence.expectedWebReleaseCount,
    expectedTuiReleaseCount: authorityReleaseEvidence.expectedTuiReleaseCount,
    tuiBlurSettlementHmac: authorityReleaseEvidence.tuiBlurSettlementHmac,
    tuiBlurRevision: authorityReleaseEvidence.tuiBlurRevision,
    tuiBlurClientHmac: authorityReleaseEvidence.tuiBlurClientHmac,
    expectedReleases:
      authorityReleaseEvidence.expectedWebReleaseCount === 0
        ? ["input", "focus", "geometry"].map((authority) => ({
            authority,
            surface: "opentui",
            clientHmac: HMAC,
            requestHmac: null,
          }))
        : [
            {
              authority: "input",
              surface: "web",
              clientHmac: HMAC,
              requestHmac: HMAC,
            },
          ],
  }));
  transitions.forEach((transition, ordinal) => {
    transition.releaseBindingDigest = card5AuthorityReleaseBindingDigest(
      transition,
      ownerReleaseEvidence[ordinal],
    );
    transition.releaseBindingHmac = card5AuthorityReleaseBindingHmac(
      transition,
      ownerReleaseEvidence[ordinal],
      KEY,
    );
  });
  return {
    hosts: { lifecycle: hostLedger() },
    generations: { before: "generation-a", after: "generation-b" },
    before: {
      clients: clients("generation-a"),
      focusedPaneEvidence: focusedPaneEvidence(),
    },
    after: { clients: clients("generation-b") },
    handoff: {
      transitions,
      ownerReleaseEvidence,
      retainedAuthorityEvidence: {
        authorityHmac: HMAC,
        authorityOwnerHmac: HMAC,
        authorityRevision: 0,
        authorityTopologyHmac: HMAC,
      },
      nullAuthorityEvidence: {
        authorityHmac: HMAC,
        authorityMutationHmac: HMAC,
        authorityOwnerHmac: HMAC,
        authorityRevision: 1,
        authorityTopologyHmac: HMAC,
      },
      postBlurAuthorityEvidence: {
        authorityHmac: "e".repeat(64),
        authorityOwnerHmac: HMAC,
        authorityRevision: 4,
        authorityTopologyHmac: "d".repeat(64),
      },
    },
    geometry: {
      challenge: {
        receiptHmac: HMAC,
        authorityClientHmac: "1".repeat(64),
        requestHmac: HMAC,
        seq: 1,
        cols: 120,
        rows: 40,
      },
      samples: [0, 1].map((sampleOrdinal) => ({
        clients: ["opentui", "web-a", "web-b"].map((name, clientOrdinal) => ({
          client: name,
          source: clientOrdinal === 0 ? "authority-snapshot" : "web-dom-and-authority",
          clientHmac: String(clientOrdinal + 1).repeat(64),
          authorityRevision: 7,
          connectedRevision: 1,
          activityRevision: sampleOrdinal,
          geometryOwner: clientOrdinal === 0,
          passive: clientOrdinal !== 0,
          cols: 120,
          rows: 40,
        })),
        authorityRevision: 7,
        ownerCount: 1,
        passiveCount: 2,
        geometryFightCount: 0,
        nativeCols: 120,
        nativeRows: 40,
        topologyHmac: HMAC,
        nativeLayoutHmac: HMAC,
      })),
    },
    slowWeb: {
      hidden: true,
      throttled: true,
      tuiInputP95Ms: 16.67,
      tuiInputP99Ms: 33,
      queuePeak: 32,
      queueCap: 32,
      blockedSinkObserved: true,
      catchUpExact: true,
      droppedCriticalObserved: 0,
      samples: slowSamples(),
    },
    restart: {
      staleGenerationRejected: true,
      staleRedemptions: [
        { rejected: true, typed: true, reason: "ticket-expired" },
        { rejected: true, typed: true, reason: "redemption-rejected" },
      ],
      elapsedMs: 5_000,
      replacementLifecycle: hostLedger(),
      physicalClientCount: 3,
      duplicatePhysicalClients: 0,
      geometryFightCount: 0,
      replacementGeometry: {
        authorityEqual: true,
        physicalClientCount: 3,
        uniquePhysicalClientCount: 3,
        authorityRevision: 8,
        topologyHmac: HMAC,
        clients: ["opentui", "web-a", "web-b"].map((name, ordinal) => ({
          client: name,
          clientHmac: String(ordinal + 1).repeat(64),
          geometryOwner: ordinal === 0,
          passive: ordinal !== 0,
          observedGeometryOwner: ordinal === 0 ? null : false,
          observedPassive: ordinal === 0 ? null : true,
          cols: 120,
          rows: 40,
        })),
        samples: [0, 1].map((sampleOrdinal) => ({
          clients: ["opentui", "web-a", "web-b"].map((name, clientOrdinal) => ({
            client: name,
            source: clientOrdinal === 0 ? "authority-snapshot" : "web-dom-and-authority",
            clientHmac: String(clientOrdinal + 1).repeat(64),
            authorityRevision: 8,
            connectedRevision: 1,
            activityRevision: sampleOrdinal,
            geometryOwner: clientOrdinal === 0,
            passive: clientOrdinal !== 0,
            cols: 120,
            rows: 40,
          })),
          authorityRevision: 8,
          ownerCount: 1,
          passiveCount: 2,
          geometryFightCount: 0,
          nativeCols: 120,
          nativeRows: 40,
          topologyHmac: HMAC,
          nativeLayoutHmac: HMAC,
        })),
      },
    },
    nativeObserver: {
      readOnly: true,
      markerPresent: true,
      markerHmac: "6".repeat(64),
      paneHmac: HMAC,
      contentHmac: HMAC,
      mutationCount: 0,
      beforeLayoutHmac: HMAC,
      afterLayoutHmac: HMAC,
      validatedCommandCount: 3,
      activeProcessCount: 0,
    },
    privacy: {
      scannedRecordCount: 9,
      rawOwnerTokenCount: 0,
      rawCapabilityCount: 0,
      rawPaneContentCount: 0,
    },
    correlation: {
      complete: true,
      recordCount: 9,
      missingJoinCount: 0,
      duplicateJoinCount: 0,
      journeyHmac: HMAC,
    },
  };
}

test("Card5 release proof admits later TUI-owned and mixed-owner ordinals exactly", () => {
  const value = evidence();
  const replaceRelease = (ordinal, expectedReleases, receipts) => {
    const transition = value.handoff.transitions[ordinal];
    const webCount = expectedReleases.filter(({ surface }) => surface === "web").length;
    const tuiCount = expectedReleases.filter(({ surface }) => surface === "opentui").length;
    Object.assign(transition.authorityReleaseEvidence, {
      expectedReleaseCount: expectedReleases.length,
      expectedWebReleaseCount: webCount,
      expectedTuiReleaseCount: tuiCount,
      tuiBlurSettlementHmac: tuiCount > 0 ? HMAC : null,
      tuiBlurRevision: tuiCount > 0 ? transition.authorityReleaseEvidence.ownerRevision + 1 : null,
      tuiBlurClientHmac: tuiCount > 0 ? HMAC : null,
      receipts,
    });
    value.handoff.ownerReleaseEvidence[ordinal] = {
      ownerTupleHmac: transition.authorityReleaseEvidence.ownerTupleHmac,
      ownerReleaseSeal: transition.authorityReleaseEvidence.ownerReleaseSeal,
      expectedReleaseMapHmac: transition.authorityReleaseEvidence.expectedReleaseMapHmac,
      expectedReleaseCount: expectedReleases.length,
      expectedWebReleaseCount: webCount,
      expectedTuiReleaseCount: tuiCount,
      tuiBlurSettlementHmac: transition.authorityReleaseEvidence.tuiBlurSettlementHmac,
      tuiBlurRevision: transition.authorityReleaseEvidence.tuiBlurRevision,
      tuiBlurClientHmac: transition.authorityReleaseEvidence.tuiBlurClientHmac,
      expectedReleases,
    };
    transition.releaseBindingDigest = card5AuthorityReleaseBindingDigest(
      transition,
      value.handoff.ownerReleaseEvidence[ordinal],
    );
    transition.releaseBindingHmac = card5AuthorityReleaseBindingHmac(
      transition,
      value.handoff.ownerReleaseEvidence[ordinal],
      KEY,
    );
  };
  const tuiReleases = ["input", "focus", "geometry"].map((authority) => ({
    authority,
    surface: "opentui",
    clientHmac: HMAC,
    requestHmac: null,
  }));
  replaceRelease(1, tuiReleases, []);
  const webReceipt = value.handoff.transitions[2].authorityReleaseEvidence.receipts[0];
  replaceRelease(
    2,
    [
      {
        authority: "input",
        surface: "web",
        clientHmac: webReceipt.clientHmac,
        requestHmac: webReceipt.requestHmac,
      },
      { authority: "focus", surface: "opentui", clientHmac: HMAC, requestHmac: null },
    ],
    [webReceipt],
  );
  for (const ordinal of [1, 2]) {
    const transition = value.handoff.transitions[ordinal];
    transition.nullAuthorityEvidence.authorityRevision = Math.max(
      transition.authorityReleaseEvidence.tuiBlurRevision ?? 0,
      ...transition.authorityReleaseEvidence.receipts.map(({ afterRevision }) => afterRevision),
    );
    transition.releaseBindingDigest = card5AuthorityReleaseBindingDigest(
      transition,
      value.handoff.ownerReleaseEvidence[ordinal],
    );
    transition.releaseBindingHmac = card5AuthorityReleaseBindingHmac(
      transition,
      value.handoff.ownerReleaseEvidence[ordinal],
      KEY,
    );
  }
  assert.equal(
    assessCard5CrossClientEvidence({ evidence: value, correlationComplete: true })
      .firstBrokenBoundary,
    null,
  );
});

test("Card5 cross-client evidence passes only at every inclusive policy boundary", () => {
  const result = assessCard5CrossClientEvidence({
    evidence: evidence(),
    correlationComplete: true,
  });
  assert.equal(result.qualified, true);
  assert.deepEqual(
    result.boundaries.map(({ id, status }) => [id, status]),
    CARD5_CROSS_CLIENT_BOUNDARIES.map((id) => [id, "passed"]),
  );
});

test("Card5 native observer is bound to the accepted pane and exact handoff marker", () => {
  for (const mutate of [
    (value) => (value.nativeObserver.paneHmac = "9".repeat(64)),
    (value) => (value.nativeObserver.markerHmac = "9".repeat(64)),
  ]) {
    const value = evidence();
    mutate(value);
    const result = assessCard5CrossClientEvidence({ evidence: value, correlationComplete: true });
    assert.equal(result.firstBrokenBoundary, CARD5_CROSS_CLIENT_BOUNDARIES[7]);
  }
});

test("Card5 cross-client evidence localizes every exact first boundary", () => {
  const mutations = [
    (value) => (value.hosts.lifecycle[2].socketHmac = null),
    (value) => (value.before.clients["web-b"].canonicalStateHash = "b".repeat(16)),
    (value) => (value.handoff.transitions[1].nullObserved = false),
    (value) => (value.geometry.samples[1].ownerCount = 2),
    (value) => (value.slowWeb.tuiInputP99Ms = 33.001),
    (value) => (value.restart.elapsedMs = 5_001),
    (value) => (value.after.clients.opentui.generation = "generation-a"),
    (value) => (value.nativeObserver.mutationCount = 1),
    (value) => (value.privacy.rawCapabilityCount = 1),
  ];
  for (const [index, mutate] of mutations.entries()) {
    const value = evidence();
    mutate(value);
    const result = assessCard5CrossClientEvidence({
      evidence: value,
      correlationComplete: true,
    });
    assert.equal(result.firstBrokenBoundary, CARD5_CROSS_CLIENT_BOUNDARIES[index]);
    const observation = card5CrossClientFailureObservation(result, value);
    assert.equal(observation.boundaryOrdinal, index);
    assert.deepEqual(Object.keys(observation).sort(), [
      "afterClients",
      "beforeClients",
      "boundary",
      "boundaryOrdinal",
      "correlationComplete",
      "geometryFightCount",
      "handoffEchoes",
      "lastCanonicalRevision",
      "lastInputPaintMs",
      "operation",
      "reason",
      "restartElapsedMs",
      "slowQueuePeak",
      "slowSampleCount",
    ]);
    assert.equal(JSON.stringify(observation).includes(HMAC), false);
  }
});

test("Card5 handoff and slow-client proof reject inferred or incomplete records", () => {
  const mutations = [
    (value) => (value.handoff.transitions[0].releaseObserved = false),
    (value) => (value.handoff.transitions[0].postHandoffAuthorityEvidence = null),
    (value) => (value.handoff.transitions[0].postHandoffAuthorityEvidence.grantRevision += 1),
    (value) =>
      (value.handoff.transitions[0].postHandoffAuthorityEvidence.relation = "released-null"),
    (value) => {
      value.handoff.transitions[0].postHandoffAuthorityEvidence = {
        mode: "post-handoff",
        relation: "retained-owner",
        grantRevision: value.handoff.transitions[0].grantRevision,
        currentRevision: value.handoff.transitions[0].grantRevision + 1,
        releaseRevision: null,
        relationHmac: "a".repeat(64),
        sequenceHmac: "b".repeat(64),
        inputProofHmac: "c".repeat(64),
        authorityHmac: "d".repeat(64),
        authorityOwnerHmac: "e".repeat(64),
        authorityTopologyHmac: "f".repeat(64),
        authorityMutationHmac: "1".repeat(64),
        duplicateCount: 0,
      };
    },
    (value) => (value.handoff.transitions[1].nullObserved = false),
    (value) => (value.handoff.transitions[2].receiptSettled = false),
    (value) =>
      (value.handoff.transitions[1].receiptClientHmac =
        value.handoff.transitions[0].grantedClientHmac),
    (value) =>
      (value.handoff.transitions[2].renderedRenditionHmac =
        value.handoff.transitions[2].beforeRenditionHmac),
    (value) => (value.handoff.transitions[0].renderedMarkerCount = 1),
    (value) => (value.handoff.transitions[0].tuiFocusEvidence = null),
    (value) => (value.before.focusedPaneEvidence = null),
    (value) => (value.before.focusedPaneEvidence.authorityHmac = null),
    (value) => (value.before.focusedPaneEvidence.viewportCols = 71),
    (value) => (value.handoff.transitions[0].tuiFocusEvidence.paneHmac = "f".repeat(64)),
    (value) => (value.handoff.transitions[0].tuiFocusEvidence.processHmac = "f".repeat(64)),
    (value) => (value.handoff.transitions[0].tuiFocusEvidence.revision = 6),
    (value) => (value.handoff.transitions[0].tuiFocusEvidence.focusFenceHmac = null),
    (value) => (value.handoff.transitions[0].tuiFocusEvidence.rendererEpoch = 4),
    (value) => (value.handoff.transitions[0].tuiFocusEvidence.rendererEpochHmac = HMAC),
    (value) => (value.handoff.transitions[1].tuiFocusEvidence = { processHmac: HMAC }),
    (value) => (value.handoff.transitions[0].tuiFocusEvidence.authorityHmac = "f".repeat(64)),
    (value) => (value.handoff.transitions[0].tuiFocusEvidence.authorityRevision = 12),
    (value) =>
      (value.handoff.transitions[0].tuiFocusEvidence.authorityTopologyHmac = "f".repeat(64)),
    (value) =>
      (value.handoff.transitions[0].tuiFocusEvidence.authorityHmac =
        value.handoff.transitions[0].tuiFocusEvidence.retainedAuthorityHmac),
    (value) => (value.handoff.postBlurAuthorityEvidence.authorityRevision = 0),
    (value) => (value.handoff.transitions[0].tuiFocusEvidence.postBlurGrantRevision = 2),
    (value) => (value.handoff.transitions[0].tuiFocusEvidence.transition.claimCount = 2),
    (value) => (value.handoff.transitions[0].tuiFocusEvidence.transition.duplicateClaimCount = 1),
    (value) => (value.handoff.transitions[0].tuiFocusEvidence.transition.focusEpoch = 9),
    (value) => (value.handoff.transitions[0].tuiFocusEvidence.transition.focusRevision = 2),
    (value) =>
      (value.handoff.transitions[0].tuiFocusEvidence.transition.clientHmac = "f".repeat(64)),
    (value) =>
      (value.handoff.transitions[0].tuiFocusEvidence.transition.focusSettlementHmac = null),
    (value) => (value.handoff.transitions[0].tuiFocusEvidence.transition.nullAuthorityHmac = null),
    (value) =>
      (value.handoff.transitions[0].tuiFocusEvidence.transition.nullAuthorityMutationHmac = null),
    (value) =>
      (value.handoff.transitions[0].tuiFocusEvidence.transition.nullAuthorityHmac = "f".repeat(64)),
    (value) =>
      (value.handoff.transitions[0].tuiFocusEvidence.transition.nullAuthorityMutationHmac =
        "f".repeat(64)),
    (value) =>
      (value.handoff.transitions[0].tuiFocusEvidence.transition.nullAuthorityOwnerHmac = "f".repeat(
        64,
      )),
    (value) =>
      (value.handoff.transitions[0].tuiFocusEvidence.transition.nullAuthorityTopologyHmac =
        "f".repeat(64)),
    (value) => (value.handoff.nullAuthorityEvidence.authorityRevision = 2),
    (value) => (value.handoff.nullAuthorityEvidence.extra = true),
    (value) => (value.handoff.transitions[0].authorityReleaseEvidence = null),
    (value) => (value.handoff.transitions[0].authorityReleaseEvidence.expectedReleaseCount = 0),
    (value) =>
      (value.handoff.transitions[0].authorityReleaseEvidence.ownerReleaseSeal = "f".repeat(64)),
    (value) =>
      (value.handoff.transitions[0].authorityReleaseEvidence.expectedReleaseMapHmac = "f".repeat(
        64,
      )),
    (value) => (value.handoff.ownerReleaseEvidence[0].ownerReleaseSeal = "f".repeat(64)),
    (value) =>
      (value.handoff.transitions[0].authorityReleaseEvidence.ownerTupleHmac = "f".repeat(64)),
    (value) =>
      (value.handoff.transitions[1].authorityReleaseEvidence.receipts[0].authority = "focus"),
    (value) =>
      (value.handoff.transitions[1].authorityReleaseEvidence.receipts[0].clientHmac = "f".repeat(
        64,
      )),
    (value) =>
      (value.handoff.transitions[1].authorityReleaseEvidence.receipts[0].requestHmac = "f".repeat(
        64,
      )),
    (value) => (value.handoff.ownerReleaseEvidence[0].extra = true),
    (value) => {
      value.handoff.transitions[1].authorityReleaseEvidence.receipts[0].clientHmac = "f".repeat(64);
      value.handoff.ownerReleaseEvidence[1].expectedReleases[0].clientHmac = "f".repeat(64);
    },
    (value) => {
      const transition = value.handoff.transitions[0];
      transition.authorityReleaseEvidence.tuiBlurClientHmac = "f".repeat(64);
      value.handoff.ownerReleaseEvidence[0].tuiBlurClientHmac = "f".repeat(64);
      value.handoff.ownerReleaseEvidence[0].expectedReleases.forEach(
        (release) => (release.clientHmac = "f".repeat(64)),
      );
      transition.releaseBindingDigest = card5AuthorityReleaseBindingDigest(
        transition,
        value.handoff.ownerReleaseEvidence[0],
      );
    },
    (value) => {
      const transition = value.handoff.transitions[0];
      transition.authorityJoinEvidence.stagingSequenceHmac = "f".repeat(64);
      transition.releaseBindingDigest = card5AuthorityReleaseBindingDigest(
        transition,
        value.handoff.ownerReleaseEvidence[0],
      );
    },
    (value) => {
      const transition = value.handoff.transitions[0];
      transition.authorityReleaseEvidence.tuiBlurRevision =
        transition.authorityReleaseEvidence.ownerRevision;
      value.handoff.ownerReleaseEvidence[0].tuiBlurRevision =
        transition.authorityReleaseEvidence.ownerRevision;
    },
    (value) => {
      const transition = value.handoff.transitions[1];
      transition.nullAuthorityEvidence.authorityRevision =
        transition.authorityReleaseEvidence.receipts[0].afterRevision;
      transition.releaseBindingDigest = card5AuthorityReleaseBindingDigest(
        transition,
        value.handoff.ownerReleaseEvidence[1],
      );
    },
    (value) => {
      [value.handoff.transitions[1], value.handoff.transitions[2]] = [
        value.handoff.transitions[2],
        value.handoff.transitions[1],
      ];
      [value.handoff.ownerReleaseEvidence[1], value.handoff.ownerReleaseEvidence[2]] = [
        value.handoff.ownerReleaseEvidence[2],
        value.handoff.ownerReleaseEvidence[1],
      ];
    },
    (value) => (value.handoff.transitions[1].authorityReleaseEvidence.receipts = []),
    (value) =>
      value.handoff.transitions[1].authorityReleaseEvidence.receipts.push(
        structuredClone(value.handoff.transitions[1].authorityReleaseEvidence.receipts[0]),
      ),
    (value) =>
      (value.handoff.transitions[1].authorityReleaseEvidence.receipts[0].runtimeSessionHmac = null),
    (value) =>
      (value.handoff.transitions[1].authorityReleaseEvidence.receipts[0].afterRevision = 0),
    (value) => (value.handoff.transitions[0].tuiFocusEvidence.transition.nullAuthorityRevision = 0),
    (value) =>
      (value.handoff.transitions[0].tuiFocusEvidence.transition.nullAuthorityTopologyHmac = null),
    (value) => (value.handoff.transitions[0].tuiFocusEvidence.transition.postInputRecordCount = 0),
    (value) => value.slowWeb.samples.pop(),
    (value) => (value.slowWeb.blockedSinkObserved = false),
    (value) => (value.slowWeb.samples[12].ackSettled = false),
    (value) => (value.slowWeb.samples[13].deliveryFenceSettled = false),
    (value) => (value.slowWeb.samples[14].writerHealth.pendingCriticalRecords = 1),
    (value) => (value.slowWeb.samples[15].resource.eventLoopDelayMicros = 33_001),
    (value) => (value.slowWeb.samples[16].resource.eventLoopDelayPeakMicros = 100_001),
    (value) => (value.slowWeb.samples[17].resource.clockId = "foreign-clock"),
    (value) => (value.slowWeb.samples[17].resource.processId = "foreign:123"),
    (value) => (value.slowWeb.samples[17].resource.processHmac = "f".repeat(64)),
    (value) =>
      value.slowWeb.samples.forEach((sample) => {
        sample.resource.processId = "opentui:999";
        sample.resource.processIdentityExact = false;
      }),
    (value) =>
      (value.slowWeb.samples[18].resource.atMicros = value.slowWeb.samples[17].resource.atMicros),
    (value) => (value.slowWeb.samples[19].transactionHmac = null),
    (value) =>
      (value.slowWeb.samples[20].transactionHmac = value.slowWeb.samples[19].transactionHmac),
    (value) => (value.slowWeb.samples[21].traceHmac = value.slowWeb.samples[20].traceHmac),
    (value) => (value.slowWeb.samples[22].ackBoundary = value.slowWeb.samples[22].ackOrdinal + 1),
    (value) =>
      (value.slowWeb.samples[23].canonicalRevision = value.slowWeb.samples[22].canonicalRevision),
    (value) => (value.slowWeb.samples[24].settlementTraceHmac = "f".repeat(64)),
    (value) => (value.slowWeb.samples[25].ackCanonicalHmac = "f".repeat(64)),
    (value) => (value.slowWeb.samples[26].matchingAckCount = 2),
    (value) => (value.slowWeb.samples[26].matchingSettlementCount = 2),
    (value) => (value.slowWeb.samples[27].resource.canonicalIdentityHmac = "f".repeat(64)),
    (value) => (value.slowWeb.samples[28].resource.rssBytes = 1_073_741_825),
    (value) => (value.slowWeb.samples[29].resource.heapUsedBytes = 536_870_913),
    (value) => (value.slowWeb.samples[8].resource.resourceSamplingFailureCount = 1),
    (value) => (value.slowWeb.samples[9].resource.inputPendingPeak = 1),
    (value) =>
      (value.slowWeb.samples[10].resource.rssPeakBytes =
        value.slowWeb.samples[9].resource.rssPeakBytes - 1),
    (value) => value.slowWeb.samples.push(structuredClone(value.slowWeb.samples.at(-1))),
    (value) => (value.slowWeb.catchUpExact = false),
  ];
  for (const mutate of mutations) {
    const value = evidence();
    mutate(value);
    const failed = assessCard5CrossClientEvidence({ evidence: value, correlationComplete: true });
    const mutatesSlowWeb = mutate.toString().includes("slowWeb");
    const mutationSource = mutate.toString();
    const mutatesInitial =
      mutationSource.includes("before.focusedPaneEvidence = null") ||
      mutationSource.includes("before.focusedPaneEvidence.authorityHmac");
    assert.equal(
      failed.firstBrokenBoundary,
      mutatesInitial
        ? "cross-client-initial-convergence"
        : mutatesSlowWeb
          ? "cross-client-slow-web-isolation"
          : "cross-client-authority-handoff",
    );
  }
});

test("Card5 geometry requires exact per-client owner, passive, revision, and dimensions", () => {
  const mutations = [
    (value) => (value.geometry.samples[0].clients[1].geometryOwner = true),
    (value) => (value.geometry.samples[0].clients[2].passive = false),
    (value) => (value.geometry.samples[0].clients[1].authorityRevision += 1),
    (value) => (value.geometry.samples[0].clients[2].cols += 1),
    (value) =>
      (value.geometry.samples[1].authorityRevision =
        value.geometry.samples[0].authorityRevision + 1),
    (value) => (value.geometry.samples[1].topologyHmac = "f".repeat(64)),
    (value) => (value.geometry.samples[0].nativeCols += 1),
    (value) => (value.geometry.samples[0].clients[2].clientHmac = null),
    (value) => (value.geometry.challenge.authorityClientHmac = "f".repeat(64)),
    (value) => (value.geometry.challenge.cols += 1),
  ];
  for (const mutate of mutations) {
    const value = evidence();
    mutate(value);
    assert.equal(
      assessCard5CrossClientEvidence({ evidence: value, correlationComplete: true })
        .firstBrokenBoundary,
      "cross-client-passive-geometry",
    );
  }
});

test("Card5 host ledger requires three distinct observed process/request/lane/socket identities", () => {
  for (const field of ["processHmac", "requestHmac", "laneHmac", "socketHmac", "clientHmac"]) {
    const value = evidence();
    value.hosts.lifecycle[1][field] = value.hosts.lifecycle[0][field];
    const failed = assessCard5CrossClientEvidence({ evidence: value, correlationComplete: true });
    assert.equal(failed.firstBrokenBoundary, "cross-client-production-hosts");
  }
});

function restartEvidence() {
  const replacement = evidence().restart;
  return {
    hosts: { lifecycle: hostLedger() },
    generations: { before: "generation-a", after: "generation-b" },
    before: { clients: clients("generation-a") },
    after: { clients: clients("generation-b") },
    restart: {
      elapsedMs: 5_000,
      staleDescriptorRejected: true,
      staleRedemptions: [
        { rejected: true, typed: true, reason: "ticket-expired" },
        { rejected: true, typed: true, reason: "redemption-rejected" },
      ],
      staleSocketRejected: true,
      staleGenerationError: "generation-replaced",
      replacementFirstEnvelope: "seed",
      replacementSeedGeneration: "generation-b",
      predecessorEnvelopeAcceptedAfterReplace: false,
      reconnectedHosts: 3,
      physicalClientCount: 3,
      duplicatePhysicalClients: 0,
      geometryFightCount: 0,
      replacementGeometry: replacement.replacementGeometry,
      replacementLifecycle: hostLedger(),
      socketOutcomes: [
        { outcome: "predecessor-closed" },
        { outcome: "predecessor-closed" },
        { outcome: "replacement-open" },
        { outcome: "replacement-open" },
        { outcome: "replacement-open" },
      ],
    },
    privacy: {
      scannedRecordCount: 9,
      rawOwnerTokenCount: 0,
      rawCapabilityCount: 0,
      rawPaneContentCount: 0,
    },
    correlation: {
      complete: true,
      recordCount: 9,
      missingJoinCount: 0,
      duplicateJoinCount: 0,
      journeyHmac: HMAC,
    },
  };
}

test("Card5 daemon restart has an independent exact boundary vector", () => {
  const result = assessCard5DaemonRestartEvidence({
    evidence: restartEvidence(),
    correlationComplete: true,
  });
  assert.equal(result.qualified, true);
  assert.deepEqual(
    result.boundaries.map(({ id, status }) => [id, status]),
    CARD5_DAEMON_RESTART_BOUNDARIES.map((id) => [id, "passed"]),
  );
  const mutations = [
    (value) => (value.hosts.lifecycle[1].opened = false),
    (value) => (value.before.clients["web-a"].canonicalStateHash = "b".repeat(16)),
    (value) => (value.generations.after = value.generations.before),
    (value) => (value.restart.staleSocketRejected = false),
    (value) => (value.restart.duplicatePhysicalClients = 1),
    (value) => (value.after.clients["web-b"].generation = "generation-a"),
    (value) => (value.privacy.rawPaneContentCount = 1),
  ];
  for (const [index, mutate] of mutations.entries()) {
    const value = restartEvidence();
    mutate(value);
    const failed = assessCard5DaemonRestartEvidence({ evidence: value, correlationComplete: true });
    assert.equal(failed.firstBrokenBoundary, CARD5_DAEMON_RESTART_BOUNDARIES[index]);
    assert.equal(card5DaemonRestartFailureObservation(failed, value).boundaryOrdinal, index);
  }
});

test("Card5 restart requires exact replacement physical geometry cardinality", () => {
  const mutations = [
    (value) => (value.restart.physicalClientCount = 2),
    (value) => (value.restart.replacementGeometry.authorityEqual = false),
    (value) => (value.restart.replacementGeometry.uniquePhysicalClientCount = 2),
    (value) => (value.restart.replacementGeometry.clients[1].observedPassive = false),
    (value) => (value.restart.replacementGeometry.clients[2].cols += 1),
    (value) =>
      (value.restart.replacementGeometry.samples[1].authorityRevision =
        value.restart.replacementGeometry.samples[0].authorityRevision + 1),
    (value) => (value.restart.replacementGeometry.samples[1].topologyHmac = "f".repeat(64)),
    (value) => (value.restart.replacementGeometry.samples[1].nativeCols += 1),
    (value) => (value.restart.replacementGeometry.authorityRevision += 1),
    (value) => (value.restart.replacementGeometry.topologyHmac = "e".repeat(64)),
    (value) => (value.restart.replacementGeometry.clients[1].clientHmac = "e".repeat(64)),
    (value) => {
      value.restart.replacementGeometry.clients[0].geometryOwner = false;
      value.restart.replacementGeometry.clients[0].passive = true;
      value.restart.replacementGeometry.clients[1].geometryOwner = true;
      value.restart.replacementGeometry.clients[1].passive = false;
    },
  ];
  for (const mutate of mutations) {
    const value = restartEvidence();
    mutate(value);
    const failed = assessCard5DaemonRestartEvidence({ evidence: value, correlationComplete: true });
    assert.equal(failed.firstBrokenBoundary, "daemon-restart-hosts-reconnected");
  }
});

test("Card5 restart rejects patch-first G2 and any accepted stale G1 envelope", () => {
  for (const mutate of [
    (value) => (value.restart.replacementFirstEnvelope = "patch"),
    (value) => (value.restart.replacementSeedGeneration = "generation-a"),
    (value) => (value.restart.predecessorEnvelopeAcceptedAfterReplace = true),
    (value) => (value.restart.staleGenerationError = "closed"),
  ]) {
    const value = restartEvidence();
    mutate(value);
    const failed = assessCard5DaemonRestartEvidence({ evidence: value, correlationComplete: true });
    assert.equal(failed.firstBrokenBoundary, "daemon-restart-stale-authority-rejected");
  }
});

test("Card5 restart requires distinct predecessor closure and replacement socket outcomes", () => {
  for (const mutate of [
    (value) => value.restart.socketOutcomes.pop(),
    (value) => (value.restart.socketOutcomes[0].outcome = "replacement-open"),
    (value) => (value.restart.socketOutcomes[4].outcome = "predecessor-closed"),
  ]) {
    const value = restartEvidence();
    mutate(value);
    assert.equal(
      assessCard5DaemonRestartEvidence({ evidence: value, correlationComplete: true })
        .firstBrokenBoundary,
      "daemon-restart-hosts-reconnected",
    );
  }
});
