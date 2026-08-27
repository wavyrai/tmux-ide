import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  advanceCard5AuthorityReleaseStability,
  advanceCard5PostInputAuthorityPreconditionHistory,
  advanceCard5CanonicalStability,
  advanceCard5FocusedConvergenceStability,
  advanceCard5WebPhysicalLifecycleStability,
  advanceCard5RetainedFocusStability,
  assessCard5WebAuthorityRelease,
  assessCard5WebPhysicalLifecycle,
  assessCard5NullAuthorityPair,
  assessCard5TuiFocusAuthority,
  assessCard5TuiFocusedPane,
  assessCard5TuiRetainedFocus,
  assessCard5PostHandoffAuthority,
  assessCard5TuiFocusTransition,
  assessCard5TuiHandoffInput,
  assessCard5ReplacementEnvelopeEvidence,
  boundedCard5PostInputAuthorityPreconditionObservation,
  boundedCard5TuiFocusFailureObservation,
  boundedCard5TuiBlurTransitionObservation,
  boundedCard5HostFailureObservation,
  card5AuthorityActivityWithinCap,
  createCard5DiagnosticEvidenceBinding,
  createCard5TuiFrameFenceTracker,
  exactSharedCard5WebPane,
  hasExactCard5TuiFocusAuthority,
  isExactCard5TuiHostInputReceipt,
  matchesExpectedCard5WebPane,
  mergeCard5SemanticAuthorityEvidence,
  observeCard5WithinDeadline,
  selectCard5PostInputAuthorityJoin,
  selectExactCard5PaneGeometry,
  selectExactCard5TmuxPaneBinding,
  sameExactCard5TmuxPaneBinding,
  card5TmuxCapturePaneArgv,
  runExactCard5TmuxPaneCapture,
  sealCard5NullAuthority,
  sealCard5CorrelationEvidence,
  sealCard5TuiFocusAuthority,
  selectCard5TuiHostFocusBinding,
  sealCard5ProductionClientObservation,
  sameCard5WebPhysicalLifecycleEvidence,
} from "./product-cross-client-host-evidence.mjs";

test("Card5 Web physical lifecycle proof requires one exact current epoch and descriptor", () => {
  const hash = (byte) => byte.repeat(64);
  const exact = {
    semanticPaneId: "pane-a",
    generation: "generation-a",
    runtimeReplacement: {
      currentLifecycleRequest: {
        status: "exact",
        requestHmac: hash("a"),
        physicalBindingExact: true,
        physicalEpochHmac: hash("b"),
        bindingRequestHmac: hash("a"),
        bindingClientHmac: hash("c"),
        activeCount: 1,
        descriptorCount: 1,
        overflow: false,
        rawActiveCount: 1,
        rawDescriptorCount: 1,
        firstSeedOrdinal: 4,
        physicalBindingAxes: {
          present: true,
          epochSafe: true,
          generationExact: true,
          runtimeSessionExact: true,
          workspaceExact: true,
          paneExact: true,
          stageExact: true,
          clientExact: true,
          epochActiveCount: 1,
          bindingRequestExact: true,
          descriptorExact: true,
        },
      },
    },
  };
  assert.equal(assessCard5WebPhysicalLifecycle(exact, "pane-a", "generation-a").valid, true);
  const changes = [
    (value) => (value.runtimeReplacement.currentLifecycleRequest.status = "missing"),
    (value) => (value.runtimeReplacement.currentLifecycleRequest.activeCount = 0),
    (value) => (value.runtimeReplacement.currentLifecycleRequest.descriptorCount = 0),
    (value) => (value.runtimeReplacement.currentLifecycleRequest.descriptorCount = 2),
    (value) => (value.runtimeReplacement.currentLifecycleRequest.overflow = true),
    (value) => (value.runtimeReplacement.currentLifecycleRequest.bindingRequestHmac = hash("d")),
    (value) =>
      (value.runtimeReplacement.currentLifecycleRequest.physicalBindingAxes.clientExact = false),
    (value) =>
      (value.runtimeReplacement.currentLifecycleRequest.physicalBindingAxes.epochActiveCount = 2),
    (value) => (value.semanticPaneId = "pane-b"),
    (value) => (value.generation = "generation-b"),
  ];
  for (const change of changes) {
    const value = structuredClone(exact);
    change(value);
    assert.equal(assessCard5WebPhysicalLifecycle(value, "pane-a", "generation-a").valid, false);
  }
  const key = "1".repeat(64);
  const canonicalDigest = "2".repeat(64);
  const evidence = assessCard5WebPhysicalLifecycle(exact, "pane-a", "generation-a").evidence;
  const electronEvidence = Object.freeze({
    ...evidence,
    requestHmac: "4".repeat(64),
    clientHmac: "5".repeat(64),
  });
  const pair = Object.freeze({ chromium: evidence, electron: electronEvidence });
  const first = advanceCard5WebPhysicalLifecycleStability(null, canonicalDigest, pair, key);
  assert.equal(first.stable, false);
  assert.match(first.digest, /^[0-9a-f]{64}$/u);
  assert.equal(
    advanceCard5WebPhysicalLifecycleStability(first.digest, canonicalDigest, pair, key).stable,
    true,
  );
  assert.equal(
    advanceCard5WebPhysicalLifecycleStability(
      first.digest,
      canonicalDigest,
      { chromium: evidence, electron: null },
      key,
    ).digest,
    null,
    "one Web host without an exact lifecycle can never form a stable sample",
  );
  const rebound = {
    chromium: { ...evidence, physicalEpochHmac: "3".repeat(64) },
    electron: electronEvidence,
  };
  assert.equal(
    advanceCard5WebPhysicalLifecycleStability(first.digest, canonicalDigest, rebound, key).stable,
    false,
    "between-sample physical epoch churn must reset convergence",
  );
  assert.equal(sameCard5WebPhysicalLifecycleEvidence(pair, structuredClone(pair)), true);
  assert.equal(
    sameCard5WebPhysicalLifecycleEvidence(pair, rebound),
    false,
    "a convergence-to-preflight rebind must reject",
  );
  for (const aliased of [
    { chromium: evidence, electron: { ...electronEvidence, requestHmac: evidence.requestHmac } },
    { chromium: evidence, electron: { ...electronEvidence, clientHmac: evidence.clientHmac } },
    {
      chromium: evidence,
      electron: {
        ...electronEvidence,
        requestHmac: evidence.requestHmac,
        clientHmac: evidence.clientHmac,
      },
    },
  ]) {
    assert.equal(
      advanceCard5WebPhysicalLifecycleStability(null, canonicalDigest, aliased, key).digest,
      null,
      "two Web views cannot alias one physical request or client",
    );
  }
  const swapped = Object.freeze({ chromium: electronEvidence, electron: evidence });
  assert.equal(
    advanceCard5WebPhysicalLifecycleStability(first.digest, canonicalDigest, swapped, key).stable,
    false,
    "a positional host swap resets two-sample stability",
  );
  assert.equal(
    sameCard5WebPhysicalLifecycleEvidence(pair, swapped),
    false,
    "a positional host swap fails the convergence-to-preflight join",
  );
});

test("Card5 post-input precondition history preserves success across terminal timeouts", () => {
  const informative = Object.freeze({ reason: "receipt-missing", axes: Object.freeze({}) });
  const terminal = Object.freeze({ reason: "web-observation-timeout", axes: Object.freeze({}) });
  const first = advanceCard5PostInputAuthorityPreconditionHistory(null, informative, [
    { status: "ok" },
    { status: "ok" },
  ]);
  const final = advanceCard5PostInputAuthorityPreconditionHistory(first, terminal, [
    { status: "deadline" },
    { status: "deadline" },
  ]);
  assert.equal(final.firstInformative, informative);
  assert.equal(final.lastSuccessful, informative);
  assert.equal(final.terminal, terminal);
  const mixedTimeout = advanceCard5PostInputAuthorityPreconditionHistory(null, terminal, [
    { status: "ok" },
    { status: "deadline" },
  ]);
  const recovered = advanceCard5PostInputAuthorityPreconditionHistory(mixedTimeout, informative, [
    { status: "ok" },
    { status: "ok" },
  ]);
  assert.equal(recovered.firstInformative, informative);
  assert.equal(recovered.lastSuccessful, informative);
});

const KEY = "1".repeat(64);
const HASH = "a".repeat(16);
const CONTENT = "b".repeat(64);
const HMAC = "c".repeat(64);

function card5PostInputPreconditionFixture() {
  const generation = "11111111-1111-4111-8111-111111111111";
  const session = "22222222-2222-4222-8222-222222222222";
  const clients = [
    {
      clientId: "tui-a",
      surface: "opentui",
      state: "background",
      connectedRevision: 1,
      activityRevision: 1,
    },
    {
      clientId: "web-a",
      surface: "web",
      state: "foreground",
      connectedRevision: 2,
      activityRevision: 2,
    },
    {
      clientId: "web-b",
      surface: "web",
      state: "background",
      connectedRevision: 3,
      activityRevision: 1,
    },
  ];
  const authority = {
    generation,
    session,
    revision: 11,
    owners: { input: "web-a", focus: "web-a", geometry: "web-a" },
    nativeGeometryYieldUntilMs: 0,
    clients,
  };
  const record = {
    ordinal: 2,
    generation,
    session,
    revision: 11,
    nativeGeometryYieldUntilMs: 0,
    inputOwner: "web-a",
    focusOwner: "web-a",
    geometryOwner: "web-a",
    clients,
  };
  const receipt = {
    generation,
    pane: "pane-a",
    seq: 1,
    inputSha256: "a".repeat(64),
    requestId: "request-a",
    authorityClientId: "web-a",
    ordinal: 0,
  };
  const web = (page) => ({
    semanticPaneId: "pane-a",
    generation,
    page,
    workspaceEvidence: { authority: structuredClone(authority) },
  });
  return {
    webResults: [
      { status: "ok", value: web("chromium") },
      { status: "ok", value: web("electron") },
    ],
    receiptPage: "chromium",
    receiptBoundary: 0,
    rawReceipts: [receipt],
    receiptCandidates: [receipt],
    expectedInputSha256: "a".repeat(64),
    expectedRequestHmac: createHmac("sha256", Buffer.from(KEY, "hex"))
      .update("request\0request-a")
      .digest("hex"),
    requireReceipt: true,
    expectedPane: "pane-a",
    expectedGeneration: generation,
    expectedBaselineAuthority: {
      generation,
      session,
      revision: 10,
      owners: { input: null, focus: null, geometry: null },
      nativeGeometryYieldUntilMs: 0,
      clients: clients.map((client) =>
        client.clientId === "web-a"
          ? { ...client, state: "background", activityRevision: 1 }
          : { ...client },
      ),
    },
    expectedClientId: "web-a",
    expectedSurface: "web",
    expectedGrantRecord: record,
    authorityRecords: [record],
    authorityBoundary: 1,
    boundaryOverflow: false,
    evidenceKey: KEY,
  };
}

test("Card5 post-input producer preconditions expose every strict latch leaf without raw identity", () => {
  const exact = card5PostInputPreconditionFixture();
  const accepted = boundedCard5PostInputAuthorityPreconditionObservation(exact);
  assert.equal(accepted.reason, null);
  assert.equal(Object.values(accepted.axes).some(Boolean), false);
  assert.equal(JSON.stringify(accepted).includes('"web-a"'), false);
  assert.equal(JSON.stringify(accepted).includes('"request-a"'), false);

  const absentTerminal = structuredClone(exact);
  absentTerminal.expectedGrantRecord = null;
  absentTerminal.authorityRecords = [];
  assert.equal(
    boundedCard5PostInputAuthorityPreconditionObservation(absentTerminal).reason,
    "terminal-record-missing",
  );
  const unlatchableTerminal = structuredClone(exact);
  unlatchableTerminal.expectedGrantRecord = null;
  assert.equal(
    boundedCard5PostInputAuthorityPreconditionObservation(unlatchableTerminal).reason,
    "selector-contract-invalid",
  );

  const cases = [
    ["receipt-missing", (value) => ((value.rawReceipts = []), (value.receiptCandidates = []))],
    [
      "receipt-ambiguous",
      (value) => {
        value.rawReceipts.push({ ...value.rawReceipts[0], ordinal: 1 });
        value.receiptCandidates = [...value.rawReceipts];
      },
    ],
    ["receipt-invalid", (value) => (value.rawReceipts[0].seq = -1)],
    [
      "receipt-target-mismatch",
      (value) => {
        value.rawReceipts[0].authorityClientId = "web-b";
        value.receiptCandidates = [value.rawReceipts[0]];
      },
    ],
    ["web-observation-invalid", (value) => (value.webResults[0].status = "source-unavailable")],
    ["web-observation-timeout", (value) => (value.webResults[0].status = "deadline")],
    [
      "web-current-mismatch",
      (value) => (value.webResults[1].value.workspaceEvidence.authority.revision += 1),
    ],
    [
      "target-web-absent",
      (value) => {
        for (const result of value.webResults) {
          const client = result.value.workspaceEvidence.authority.clients[1];
          client.clientId = "web-z";
        }
      },
    ],
    [
      "target-web-wrong-surface",
      (value) => {
        for (const result of value.webResults)
          result.value.workspaceEvidence.authority.clients[1].surface = "opentui";
      },
    ],
    [
      "input-owner-mismatch",
      (value) => {
        for (const result of value.webResults)
          result.value.workspaceEvidence.authority.owners.input = null;
      },
    ],
    [
      "focus-owner-mismatch",
      (value) => {
        for (const result of value.webResults)
          result.value.workspaceEvidence.authority.owners.focus = null;
      },
    ],
    [
      "geometry-owner-mismatch",
      (value) => {
        for (const result of value.webResults)
          result.value.workspaceEvidence.authority.owners.geometry = null;
      },
    ],
    [
      "current-revision-mismatch",
      (value) => {
        for (const result of value.webResults)
          result.value.workspaceEvidence.authority.revision = 12;
      },
    ],
    [
      "current-generation-mismatch",
      (value) => {
        for (const result of value.webResults)
          result.value.workspaceEvidence.authority.generation =
            "33333333-3333-4333-8333-333333333333";
      },
    ],
    [
      "current-session-mismatch",
      (value) => {
        for (const result of value.webResults)
          result.value.workspaceEvidence.authority.session = "33333333-3333-4333-8333-333333333333";
      },
    ],
    [
      "current-native-yield-mismatch",
      (value) => {
        for (const result of value.webResults)
          result.value.workspaceEvidence.authority.nativeGeometryYieldUntilMs = 1;
      },
    ],
    [
      "current-topology-mismatch",
      (value) => {
        for (const result of value.webResults)
          result.value.workspaceEvidence.authority.clients[1].activityRevision = 3;
      },
    ],
    ["terminal-record-missing", (value) => (value.authorityRecords = [])],
    [
      "terminal-record-mismatch",
      (value) => (value.expectedGrantRecord = { ...value.expectedGrantRecord, ordinal: 3 }),
    ],
    ["selector-contract-invalid", (value) => (value.evidenceKey = "invalid")],
    ["boundary-overflow", (value) => (value.boundaryOverflow = true)],
  ];
  for (const [reason, mutate] of cases) {
    const input = structuredClone(exact);
    mutate(input);
    let observed;
    assert.doesNotThrow(() => {
      observed = boundedCard5PostInputAuthorityPreconditionObservation(input);
    });
    assert.equal(observed.reason, reason);
    assert.equal(JSON.stringify(observed).includes('"web-a"'), false, reason);
    assert.equal(JSON.stringify(observed).includes('"request-a"'), false, reason);
  }

  const exactMismatchCases = [
    [
      "receiptInputMismatch",
      (value) => {
        value.rawReceipts[0].inputSha256 = "b".repeat(64);
        value.receiptCandidates = [];
      },
    ],
    [
      "receiptRequestMismatch",
      (value) => {
        value.rawReceipts[0].requestId = "request-b";
        value.receiptCandidates = [];
      },
    ],
    ["receiptCandidateMismatch", (value) => (value.receiptCandidates = [])],
    [
      "webObservationInvalid",
      (value) => delete value.webResults[0].value.workspaceEvidence.authority.clients,
    ],
  ];
  for (const [axis, mutate] of exactMismatchCases) {
    const input = structuredClone(exact);
    mutate(input);
    const observed = boundedCard5PostInputAuthorityPreconditionObservation(input);
    assert.equal(
      observed.reason,
      axis === "webObservationInvalid" ? "web-observation-invalid" : "receipt-invalid",
      axis,
    );
    assert.equal(observed.axes[axis], true);
  }

  const reordered = structuredClone(exact);
  reordered.webResults[1].value.workspaceEvidence.authority.clients.reverse();
  const reorderedObservation = boundedCard5PostInputAuthorityPreconditionObservation(reordered);
  assert.equal(reorderedObservation.reason, "web-current-mismatch");
  assert.equal(reorderedObservation.axes.webCurrentMismatch, true);
});

test("Card5 post-input precondition evidence caps receipts and records", () => {
  const input = card5PostInputPreconditionFixture();
  input.rawReceipts = Array.from({ length: 9 }, (_, ordinal) => ({
    ...input.rawReceipts[0],
    ordinal,
    requestId: `request-${ordinal}`,
  }));
  input.receiptCandidates = [...input.rawReceipts];
  input.authorityRecords = Array.from({ length: 17 }, (_, index) => ({
    ...structuredClone(input.expectedGrantRecord),
    ordinal: index + 1,
    revision: index + 10,
  }));
  const observed = boundedCard5PostInputAuthorityPreconditionObservation(input);
  assert.equal(observed.receipt.count, 8);
  assert.equal(observed.receipt.overflow, true);
  assert.equal(observed.records.count, 16);
  assert.equal(observed.records.overflow, true);
  assert.equal(observed.records.last.length, 2);
});

test("Card5 post-input join accepts a same-client new epoch and exact Web target", () => {
  const generation = "11111111-1111-4111-8111-111111111111";
  const session = "22222222-2222-4222-8222-222222222222";
  const clients = [
    {
      clientId: "tui-a",
      surface: "opentui",
      state: "background",
      connectedRevision: 1,
      activityRevision: 1,
    },
    {
      clientId: "web-a",
      surface: "web",
      state: "background",
      connectedRevision: 2,
      activityRevision: 1,
    },
    {
      clientId: "web-b",
      surface: "web",
      state: "background",
      connectedRevision: 3,
      activityRevision: 1,
    },
  ];
  const nullAuthority = {
    generation,
    session,
    revision: 10,
    owners: { input: null, focus: null, geometry: null },
    nativeGeometryYieldUntilMs: 0,
    clients,
  };
  const nullEvidence = sealCard5NullAuthority(nullAuthority, generation, KEY);
  const grantClients = clients.map((client) =>
    client.clientId === "tui-a"
      ? { ...client, state: "foreground", activityRevision: 2 }
      : { ...client },
  );
  const records = [
    {
      ordinal: 7,
      generation,
      session,
      revision: 10,
      nativeGeometryYieldUntilMs: 0,
      inputOwner: null,
      focusOwner: null,
      geometryOwner: null,
      clients,
    },
    {
      ordinal: 8,
      generation,
      session,
      revision: 11,
      nativeGeometryYieldUntilMs: 0,
      inputOwner: "tui-a",
      focusOwner: "tui-a",
      geometryOwner: "tui-a",
      clients: grantClients,
    },
  ];
  const tui = selectCard5PostInputAuthorityJoin({
    records,
    nullRevision: 10,
    expectedNullAuthority: nullAuthority,
    expectedNullEvidence: nullEvidence,
    expectedClientId: "tui-a",
    expectedSurface: "opentui",
    expectedGrantRevision: 11,
    expectedGrantRecord: records[1],
    receiptCandidates: [],
    requireReceipt: false,
    boundary: 6,
    evidenceKey: KEY,
  });
  assert.equal(tui.passed, true);
  assert.equal(tui.grant, records[1]);
  for (const order of [
    ["inputOwner", "focusOwner", "geometryOwner"],
    ["geometryOwner", "inputOwner", "focusOwner"],
    ["focusOwner", "geometryOwner", "inputOwner"],
  ]) {
    const staged = [structuredClone(records[0])];
    const owners = { inputOwner: null, focusOwner: null, geometryOwner: null };
    for (const [index, owner] of order.entries()) {
      owners[owner] = "tui-a";
      staged.push({
        ...structuredClone(records[1]),
        ...owners,
        ordinal: 8 + index,
        revision: 11 + index,
      });
    }
    const stagedResult = selectCard5PostInputAuthorityJoin({
      records: staged,
      nullRevision: 10,
      expectedNullAuthority: nullAuthority,
      expectedNullEvidence: nullEvidence,
      expectedClientId: "tui-a",
      expectedSurface: "opentui",
      expectedGrantRevision: 13,
      expectedGrantRecord: staged.at(-1),
      receiptCandidates: [],
      requireReceipt: false,
      boundary: 6,
      evidenceKey: KEY,
    });
    assert.equal(stagedResult.passed, true);
    assert.equal(stagedResult.observation.stagingCount, 4);
    assert.equal(stagedResult.observation.stagingExact, true);
  }
  const presenceOnly = {
    ...structuredClone(records[1]),
    ordinal: 8,
    revision: 11,
    inputOwner: null,
    focusOwner: null,
    geometryOwner: null,
  };
  const presenceAndReplay = [
    structuredClone(records[0]),
    presenceOnly,
    { ...structuredClone(presenceOnly), ordinal: 9 },
    { ...structuredClone(records[1]), ordinal: 10, revision: 12 },
  ];
  const presenceResult = selectCard5PostInputAuthorityJoin({
    records: presenceAndReplay,
    nullRevision: 10,
    expectedNullAuthority: nullAuthority,
    expectedNullEvidence: nullEvidence,
    expectedClientId: "tui-a",
    expectedSurface: "opentui",
    expectedGrantRevision: 12,
    expectedGrantRecord: presenceAndReplay.at(-1),
    receiptCandidates: [],
    requireReceipt: false,
    boundary: 6,
    evidenceKey: KEY,
  });
  assert.equal(presenceResult.passed, true);
  assert.equal(presenceResult.observation.stagingExact, true);
  const replayedNullRecords = [
    records[0],
    { ...structuredClone(records[0]), ordinal: 8 },
    { ...structuredClone(records[1]), ordinal: 9 },
  ];
  const replayedNull = selectCard5PostInputAuthorityJoin({
    records: replayedNullRecords,
    nullRevision: 10,
    expectedNullAuthority: nullAuthority,
    expectedNullEvidence: nullEvidence,
    expectedClientId: "tui-a",
    expectedSurface: "opentui",
    expectedGrantRevision: 11,
    expectedGrantRecord: replayedNullRecords[2],
    receiptCandidates: [],
    requireReceipt: false,
    boundary: 6,
    evidenceKey: KEY,
  });
  assert.equal(replayedNull.passed, true);
  assert.equal(replayedNull.observation.nullReplayCount, 1);
  assert.match(replayedNull.observation.nullReplayOrdinalHmac, /^[a-f0-9]{64}$/u);
  for (const mutate of [
    (record) => (record.generation = "33333333-3333-4333-8333-333333333333"),
    (record) => (record.session = "33333333-3333-4333-8333-333333333333"),
    (record) => (record.nativeGeometryYieldUntilMs = 1),
    (record) => (record.focusOwner = null),
    (record) => (record.clients[0].activityRevision += 1),
  ]) {
    const changedRecords = structuredClone(records);
    mutate(changedRecords[1]);
    assert.equal(
      selectCard5PostInputAuthorityJoin({
        records: changedRecords,
        nullRevision: 10,
        expectedNullAuthority: nullAuthority,
        expectedNullEvidence: nullEvidence,
        expectedClientId: "tui-a",
        expectedSurface: "opentui",
        expectedGrantRevision: 11,
        expectedGrantRecord: records[1],
        receiptCandidates: [],
        requireReceipt: false,
        boundary: 6,
        evidenceKey: KEY,
      }).passed,
      false,
    );
  }
  const webRecords = [
    records[0],
    {
      ...records[1],
      inputOwner: "web-a",
      focusOwner: "web-a",
      geometryOwner: "web-a",
      clients: grantClients.map((client) =>
        client.clientId === "tui-a"
          ? { ...client, state: "background", activityRevision: 1 }
          : client.clientId === "web-a"
            ? { ...client, state: "foreground", activityRevision: 2 }
            : client,
      ),
    },
  ];
  const receipt = { authorityClientId: "web-a", requestId: "request-a" };
  const web = selectCard5PostInputAuthorityJoin({
    records: webRecords,
    nullRevision: 10,
    expectedNullAuthority: nullAuthority,
    expectedNullEvidence: nullEvidence,
    expectedClientId: "web-a",
    expectedSurface: "web",
    expectedGrantRevision: 11,
    expectedGrantRecord: webRecords[1],
    receiptCandidates: [receipt],
    requireReceipt: true,
    boundary: 6,
    evidenceKey: KEY,
  });
  assert.equal(web.passed, true);
  assert.equal(web.receipt, receipt);
  for (const order of [
    ["inputOwner", "focusOwner", "geometryOwner"],
    ["inputOwner", "geometryOwner", "focusOwner"],
    ["focusOwner", "inputOwner", "geometryOwner"],
    ["focusOwner", "geometryOwner", "inputOwner"],
    ["geometryOwner", "inputOwner", "focusOwner"],
    ["geometryOwner", "focusOwner", "inputOwner"],
  ]) {
    const staged = [structuredClone(webRecords[0])];
    const owners = { inputOwner: null, focusOwner: null, geometryOwner: null };
    for (const [index, owner] of order.entries()) {
      owners[owner] = "web-a";
      staged.push({
        ...structuredClone(webRecords[1]),
        ...owners,
        ordinal: 8 + index,
        revision: 11 + index,
      });
    }
    assert.equal(
      selectCard5PostInputAuthorityJoin({
        records: staged,
        nullRevision: 10,
        expectedNullAuthority: nullAuthority,
        expectedNullEvidence: nullEvidence,
        expectedClientId: "web-a",
        expectedSurface: "web",
        expectedGrantRevision: 13,
        expectedGrantRecord: staged.at(-1),
        receiptCandidates: [receipt],
        requireReceipt: true,
        boundary: 6,
        evidenceKey: KEY,
      }).passed,
      true,
    );
  }
  assert.equal(
    selectCard5PostInputAuthorityJoin({
      records: webRecords,
      nullRevision: 10,
      expectedNullAuthority: nullAuthority,
      expectedNullEvidence: nullEvidence,
      expectedClientId: "web-a",
      expectedSurface: "web",
      expectedGrantRevision: 11,
      expectedGrantRecord: webRecords[1],
      receiptCandidates: [receipt, { authorityClientId: "web-b", requestId: "request-b" }],
      requireReceipt: true,
      boundary: 6,
      evidenceKey: KEY,
    }).passed,
    false,
  );
});

test("Card5 post-input join rejects stale, cross, duplicate, and missing grants without throwing", () => {
  const generation = "11111111-1111-4111-8111-111111111111";
  const session = "22222222-2222-4222-8222-222222222222";
  const clients = [
    {
      clientId: "tui-a",
      surface: "opentui",
      state: "foreground",
      connectedRevision: 1,
      activityRevision: 2,
    },
    {
      clientId: "web-a",
      surface: "web",
      state: "background",
      connectedRevision: 2,
      activityRevision: 1,
    },
    {
      clientId: "web-b",
      surface: "web",
      state: "background",
      connectedRevision: 3,
      activityRevision: 1,
    },
  ];
  const nullAuthority = {
    generation,
    session,
    revision: 10,
    owners: { input: null, focus: null, geometry: null },
    nativeGeometryYieldUntilMs: 0,
    clients,
  };
  const exact = {
    records: [
      {
        ordinal: 1,
        generation,
        session,
        revision: 10,
        nativeGeometryYieldUntilMs: 0,
        inputOwner: null,
        focusOwner: null,
        geometryOwner: null,
        clients,
      },
      {
        ordinal: 2,
        generation,
        session,
        revision: 11,
        nativeGeometryYieldUntilMs: 0,
        inputOwner: "tui-a",
        focusOwner: "tui-a",
        geometryOwner: "tui-a",
        clients,
      },
    ],
    nullRevision: 10,
    expectedNullAuthority: nullAuthority,
    expectedNullEvidence: sealCard5NullAuthority(nullAuthority, generation, KEY),
    expectedClientId: "tui-a",
    expectedSurface: "opentui",
    expectedGrantRevision: 11,
    expectedGrantRecord: null,
    receiptCandidates: [],
    requireReceipt: false,
    boundary: 0,
    evidenceKey: KEY,
  };
  const adversaries = [
    (value) => (value.expectedGrantRevision = 12),
    (value) => (value.expectedClientId = "other-client"),
    (value) => value.records.pop(),
    (value) => (value.nullRevision = 9),
    (value) => (value.boundaryOverflow = true),
    (value) => (value.records[0].session = "33333333-3333-4333-8333-333333333333"),
    (value) => (value.records[0].nativeGeometryYieldUntilMs = 1),
    (value) => (value.records[0].clients[0].activityRevision += 1),
    (value) => {
      value.records.splice(1, 0, {
        ...structuredClone(value.records[1]),
        ordinal: 2,
        revision: 10,
        inputOwner: "web-a",
        focusOwner: "web-a",
        geometryOwner: "web-a",
      });
      value.records[2].ordinal = 3;
    },
    (value) => {
      value.records.splice(1, 0, {
        ...structuredClone(value.records[0]),
        ordinal: 2,
        clients: value.records[0].clients.map((client, index) =>
          index === 0 ? { ...client, activityRevision: client.activityRevision + 1 } : client,
        ),
      });
      value.records[2].ordinal = 3;
    },
    (value) => (value.records[1].ordinal = 3),
    (value) => {
      value.records[1].ordinal = 3;
      value.records[1].revision = 12;
      value.expectedGrantRevision = 12;
      value.records.splice(1, 0, {
        ...structuredClone(value.records[1]),
        ordinal: 2,
        revision: 11,
        inputOwner: "other-client",
        focusOwner: null,
        geometryOwner: null,
      });
    },
    (value) => {
      value.records[1].ordinal = 4;
      value.records[1].revision = 13;
      value.expectedGrantRevision = 13;
      const partial = {
        ...structuredClone(value.records[1]),
        ordinal: 2,
        revision: 11,
        focusOwner: null,
        geometryOwner: null,
      };
      value.records.splice(1, 0, partial, {
        ...structuredClone(partial),
        ordinal: 3,
        revision: 12,
        inputOwner: null,
        focusOwner: "tui-a",
      });
    },
    (value) => {
      value.records[1].ordinal = 3;
      value.records[1].revision = 12;
      value.expectedGrantRevision = 12;
      value.records.splice(1, 0, {
        ...structuredClone(value.records[1]),
        ordinal: 2,
        revision: 11,
        focusOwner: null,
        geometryOwner: null,
        clients: value.records[1].clients.map((client, index) =>
          index === 1 ? { ...client, activityRevision: client.activityRevision + 1 } : client,
        ),
      });
    },
    (value) => {
      const terminal = value.records[1];
      terminal.ordinal = 18;
      terminal.revision = 27;
      value.expectedGrantRevision = 27;
      value.records.splice(
        1,
        0,
        ...Array.from({ length: 16 }, (_, index) => ({
          ...structuredClone(terminal),
          ordinal: index + 2,
          revision: index + 11,
          focusOwner: null,
          geometryOwner: null,
        })),
      );
    },
    (value) =>
      value.records.splice(
        0,
        1,
        ...Array.from({ length: 9 }, (_, index) => ({
          ...structuredClone(value.records[0]),
          ordinal: index + 1,
        })),
      ),
  ];
  for (const mutate of adversaries) {
    const input = structuredClone(exact);
    mutate(input);
    let result;
    assert.doesNotThrow(() => {
      result = selectCard5PostInputAuthorityJoin(input);
    });
    assert.equal(result.passed, false);
    assert.match(JSON.stringify(result.observation), /^[\x20-\x7e]+$/u);
    assert.equal(JSON.stringify(result).includes("tui-a"), false);
  }
});

test("Card5 diagnostic binding keeps the selector separate from the private HMAC key", () => {
  const selected = Object.freeze({ value: "selected" });
  const binding = createCard5DiagnosticEvidenceBinding({
    journeyEvidence: { crossClientHandoff: selected, daemonRestart: { value: "other" } },
    journeyEvidenceKey: "crossClientHandoff",
    privateEvidenceKey: KEY,
  });
  assert.equal(binding.evidence, selected);
  assert.deepEqual(
    binding.correlate((evidence, privateKey) => ({ evidence, privateKey })),
    { evidence: selected, privateKey: KEY },
  );
  assert.equal(
    binding.assess((_evidence, privateKey) => privateKey),
    KEY,
  );
  assert.equal(JSON.stringify(binding).includes(KEY), false);
  assert.throws(() =>
    createCard5DiagnosticEvidenceBinding({
      journeyEvidence: { crossClientHandoff: selected },
      journeyEvidenceKey: "crossClientHandoff",
      privateEvidenceKey: "crossClientHandoff",
    }),
  );
  assert.throws(() =>
    createCard5DiagnosticEvidenceBinding({
      journeyEvidence: { crossClientHandoff: selected },
      journeyEvidenceKey: "crossClientHandoff",
      privateEvidenceKey: null,
    }),
  );
});

function card5FocusReceipt(state, status = "changed") {
  return {
    version: 1,
    status,
    action: state,
    nonceHmac: HMAC,
    diagnosticEpoch: status === "changed" ? (state === "blur" ? 7 : 8) : null,
    state: state === "blur" ? "background" : "foreground",
    bindingHmac: HMAC,
    receiptHmac: HMAC,
  };
}

function card5FocusTransitionRecords() {
  const identity = {
    processId: "opentui:42",
    clockId: "opentui-performance-now",
    daemonInstanceId: "daemon-generation-a",
    runtimeSession: "runtime-session-a",
    workspaceName: "workspace-a",
    rendererEpoch: 3,
    clientGeneration: 7,
  };
  const record = (phase, diagnosticEpoch, monotonicMicros, extra = {}) => ({
    phase,
    diagnosticEpoch,
    monotonicMicros,
    ...identity,
    ...extra,
  });
  return [
    record("terminal-host-renderer-blur-event", 7, 100, { state: "background" }),
    record("terminal-host-blur-presence", 7, 101),
    record("terminal-host-blur-authority-settled", 7, 102, {
      status: "fulfilled",
      bindingCurrent: true,
      receipts: ["input", "focus", "geometry"].map((authority) => ({
        authority,
        status: "fulfilled",
        generation: "daemon-generation-a",
        owners: { input: null, focus: null, geometry: null },
        revision: 13,
        session: "runtime-session-a",
      })),
      settledIdentity: {
        authorityRevision: 13,
        authorityOwners: { input: null, focus: null, geometry: null },
      },
    }),
    record("terminal-host-focus-fence", 7, 103, {
      settledPhase: "blur-authority-settled",
      writerHealth: { failed: false, droppedRecords: 0, pendingCriticalRecords: 0 },
    }),
    record("terminal-host-renderer-focus-event", 8, 104, { state: "foreground" }),
    record("terminal-host-focus-claim-attempt", 8, 105, { claimOrdinal: 4 }),
    record("terminal-host-focus-presence", 8, 106),
    record("terminal-host-focus-activity", 8, 107),
    record("terminal-host-focus-authority-reconcile", 8, 108),
    record("terminal-host-focus-authority-settled", 8, 109, {
      status: "fulfilled",
      bindingCurrent: true,
      receipts: ["input", "focus", "geometry"].map((authority, index) => ({
        authority,
        status: "fulfilled",
        granted: true,
        generation: "daemon-generation-a",
        clientId: "opentui:42",
        revision: 14 + index,
        session: "runtime-session-a",
      })),
      settledIdentity: { authorityRevision: 16 },
    }),
    record("terminal-host-focus-fence", 8, 110, {
      settledPhase: "focus-authority-settled",
      writerHealth: { failed: false, droppedRecords: 0, pendingCriticalRecords: 0 },
    }),
  ];
}

test("qualifies one explicit Card5 blur-focus epoch and rejects passive loss or duplicate claims", () => {
  const input = {
    records: card5FocusTransitionRecords(),
    receipts: {
      blur: card5FocusReceipt("blur"),
      focus: card5FocusReceipt("focus"),
      duplicateFocus: card5FocusReceipt("focus", "no-op"),
    },
    expectedCanonical: {
      processId: "opentui:42",
      clockId: "opentui-performance-now",
      generation: "daemon-generation-a",
    },
    expectedBindingHmac: HMAC,
    expectedWorkspaceName: "workspace-a",
    expectedRendererEpoch: 3,
    expectedClientGeneration: 7,
    expectedRuntimeSession: "runtime-session-a",
    expectedAuthorityOwners: { input: "opentui:42", focus: "opentui:42", geometry: "opentui:42" },
    expectedTuiClientId: "opentui:42",
    minimumBlurAuthorityRevision: 12,
    minimumFocusAuthorityRevision: 13,
    baselineClaimOrdinal: 3,
    evidenceKey: KEY,
  };
  const passed = assessCard5TuiFocusTransition(input);
  assert.equal(passed.passed, true);
  assert.equal(passed.evidence.claimCount, 1);
  assert.equal(passed.evidence.duplicateClaimCount, 0);
  assert.equal(passed.evidence.duplicateFocusReceiptHmac, HMAC);
  const focusBeforeDuplicate = assessCard5TuiFocusTransition({
    ...input,
    receipts: { blur: input.receipts.blur, focus: input.receipts.focus },
    stage: "focus",
  });
  assert.equal(focusBeforeDuplicate.passed, true);
  assert.equal(focusBeforeDuplicate.evidence.focusReceiptHmac, HMAC);
  assert.equal(focusBeforeDuplicate.evidence.duplicateFocusReceiptHmac, null);
  const alreadyBackground = assessCard5TuiFocusTransition({
    ...input,
    priorBlurRecords: input.records.slice(0, 4),
    records: input.records.slice(4),
    receipts: { ...input.receipts, blur: card5FocusReceipt("blur", "no-op") },
  });
  assert.equal(alreadyBackground.passed, true);
  assert.equal(
    assessCard5TuiFocusTransition({
      ...input,
      priorBlurRecords: [],
      records: input.records.slice(4),
      receipts: { ...input.receipts, blur: card5FocusReceipt("blur", "no-op") },
    }).passed,
    false,
  );
  const mixedOwners = { input: "opentui:42", focus: "web-a", geometry: null };
  const mixedAfterBlur = { input: null, focus: "web-a", geometry: null };
  const mixedRecords = input.records.map((record) =>
    record.phase === "terminal-host-blur-authority-settled"
      ? {
          ...record,
          receipts: record.receipts.map((receipt) => ({
            ...receipt,
            owners: mixedAfterBlur,
          })),
          settledIdentity: {
            ...record.settledIdentity,
            authorityOwners: mixedAfterBlur,
          },
        }
      : record,
  );
  assert.equal(
    assessCard5TuiFocusTransition({
      ...input,
      records: mixedRecords.slice(0, 4),
      receipts: { blur: input.receipts.blur },
      expectedAuthorityOwners: mixedOwners,
      stage: "blur",
    }).passed,
    true,
  );
  assert.equal(
    assessCard5TuiFocusTransition({
      ...input,
      records: input.records.slice(0, 4),
      receipts: { blur: input.receipts.blur, focus: input.receipts.focus },
      stage: "focus",
    }).reason,
    "focus-claim-cardinality",
  );
  assert.equal(
    assessCard5TuiFocusTransition({
      ...input,
      records: [...input.records, { ...input.records[5], monotonicMicros: 111, claimOrdinal: 5 }],
    }).reason,
    "focus-claim-cardinality",
  );
  const receiptAdversaries = [
    { stage: "blur", receipts: {} },
    { stage: "blur", receipts: { blur: input.receipts.blur, extra: input.receipts.focus } },
    { stage: "focus", receipts: { blur: input.receipts.blur } },
    {
      stage: "focus",
      receipts: {
        blur: input.receipts.blur,
        focus: { ...input.receipts.focus, receiptHmac: null },
      },
    },
    { stage: "focus", receipts: input.receipts },
    {
      stage: "complete",
      receipts: { blur: input.receipts.blur, focus: input.receipts.focus },
    },
    {
      stage: "complete",
      receipts: {
        ...input.receipts,
        duplicateFocus: card5FocusReceipt("focus", "changed"),
      },
    },
    { stage: "complete", receipts: { ...input.receipts, extra: input.receipts.focus } },
  ];
  for (const changed of receiptAdversaries) {
    const assessed = assessCard5TuiFocusTransition({ ...input, ...changed });
    assert.equal(assessed.passed, false);
    assert.match(assessed.reason, /^focus-(?:blur|focus)-receipt-invalid$/u);
  }
});

test("Card5 host-focus binding joins separate lifecycle and source-shaped canonical streams", () => {
  const authority = {
    generation: "daemon-generation-a",
    session: "runtime-session-a",
    revision: 17,
    owners: { input: "opentui:42", focus: "opentui:42", geometry: "opentui:42" },
    nativeGeometryYieldUntilMs: 0,
    clients: [
      {
        clientId: "web:a",
        surface: "web",
        state: "background",
        connectedRevision: 1,
        activityRevision: 1,
      },
      {
        clientId: "web:b",
        surface: "web",
        state: "background",
        connectedRevision: 2,
        activityRevision: 2,
      },
      {
        clientId: "opentui:42",
        surface: "opentui",
        state: "foreground",
        connectedRevision: 3,
        activityRevision: 17,
      },
    ],
  };
  const reconcile = {
    phase: "terminal-host-focus-authority-reconcile",
    diagnosticEpoch: null,
    status: "applied",
    processId: "opentui:42",
    clockId: "opentui-performance-now",
    daemonInstanceId: authority.generation,
    authorityGeneration: authority.generation,
    runtimeSession: authority.session,
    workspaceName: "workspace-a",
    clientPhase: "live",
    rendererEpoch: 3,
    clientGeneration: 7,
    authorityRevision: authority.revision,
    authorityOwners: authority.owners,
    opentuiPresence: {
      clientId: "opentui:42",
      state: "foreground",
      connectedRevision: 3,
      activityRevision: 17,
    },
    receipts: ["input", "focus", "geometry"].map((authorityKind) => ({
      authority: authorityKind,
      status: "fulfilled",
      granted: true,
      exact: true,
    })),
  };
  const bindingReady = {
    phase: "terminal-host-focus-control-binding-ready",
    elapsedMs: 10,
    at: "2026-08-24T20:00:00.000Z",
    bindingEpoch: 1,
    processId: "opentui:42",
    clockId: "opentui-performance-now",
    daemonInstanceId: authority.generation,
    authorityGeneration: authority.generation,
    runtimeSession: authority.session,
    workspaceName: "workspace-a",
    clientId: "opentui:42",
    clientPhase: "live",
    rendererEpoch: 3,
    clientGeneration: 7,
    monotonicMicros: 100,
  };
  const gateReady = {
    phase: "terminal-host-focus-control-gate-ready",
    elapsedMs: 9,
    at: "2026-08-24T20:00:00.000Z",
    processId: "opentui:42",
    clockId: "opentui-performance-now",
    capability: true,
    detail: true,
    path: true,
    root: true,
    key: true,
    trace: true,
    enabled: true,
    monotonicMicros: 90,
  };
  const input = {
    referenceRecords: [
      {
        type: "performance.terminal-frame-fence",
        semanticPaneId: "pane-a",
        processId: "opentui:42",
        clockId: "opentui-performance-now",
        generation: "daemon-generation-a",
        incarnation: "daemon-generation-a:0",
        revision: 5,
        stateHash: "a".repeat(16),
        rendererEpoch: 3,
      },
    ],
    lifecycleRecords: [gateReady, bindingReady, reconcile],
    expectedCanonical: {
      processId: "opentui:42",
      clockId: "opentui-performance-now",
      semanticPaneId: "pane-a",
      generation: "daemon-generation-a",
      incarnation: "daemon-generation-a:0",
      revision: 5,
      canonicalStateHash: "a".repeat(16),
    },
    expectedAuthority: authority,
    expectedWorkspaceName: "workspace-a",
    expectedTuiClientId: "opentui:42",
    evidenceKey: KEY,
  };
  const exact = selectCard5TuiHostFocusBinding(input);
  assert.equal(exact.passed, true);
  assert.equal(exact.source, "binding-ready");
  assert.deepEqual(exact.binding, { rendererEpoch: 3, clientGeneration: 7, bindingEpoch: 1 });
  assert.equal(selectCard5TuiHostFocusBinding({ ...input, lifecycleRecords: [] }).passed, false);
  assert.equal(selectCard5TuiHostFocusBinding({ ...input, referenceRecords: [] }).passed, false);
  const advancedAuthority = structuredClone(authority);
  advancedAuthority.revision = 23;
  advancedAuthority.clients.find(({ clientId }) => clientId === "opentui:42").activityRevision = 23;
  assert.equal(
    selectCard5TuiHostFocusBinding({ ...input, expectedAuthority: advancedAuthority }).passed,
    true,
  );
  const futureReconcile = structuredClone(reconcile);
  futureReconcile.authorityRevision = 24;
  futureReconcile.opentuiPresence.activityRevision = 24;
  const future = selectCard5TuiHostFocusBinding({
    ...input,
    lifecycleRecords: [gateReady, bindingReady, futureReconcile],
    expectedAuthority: advancedAuthority,
  });
  assert.equal(future.passed, true);
  assert.equal(future.observation.revisionRelationMismatch, true);
  for (const mutate of [
    (record) => (record.rendererEpoch = -1),
    (record) => (record.runtimeSession = "runtime-session-b"),
    (record) => (record.clientId = "opentui:foreign"),
    (record) => (record.bindingEpoch = 0),
  ]) {
    const changed = structuredClone(bindingReady);
    mutate(changed);
    assert.equal(
      selectCard5TuiHostFocusBinding({
        ...input,
        lifecycleRecords: [gateReady, changed, reconcile],
      }).passed,
      false,
    );
  }
  for (const field of ["capability", "detail", "path", "root", "key", "trace", "enabled"]) {
    const changed = structuredClone(gateReady);
    changed[field] = false;
    const selected = selectCard5TuiHostFocusBinding({
      ...input,
      lifecycleRecords: [changed, bindingReady, reconcile],
    });
    assert.equal(selected.passed, false);
    assert.equal(selected.reason, "binding-gate-invalid");
    assert.equal(selected.observation[`gate${field[0].toUpperCase()}${field.slice(1)}`], false);
  }
  for (const record of [gateReady, bindingReady]) {
    const changed = { ...record, extra: true };
    assert.equal(
      selectCard5TuiHostFocusBinding({
        ...input,
        lifecycleRecords:
          record === gateReady
            ? [changed, bindingReady, reconcile]
            : [gateReady, changed, reconcile],
      }).passed,
      false,
    );
  }
  const mixedReconcile = structuredClone(reconcile);
  mixedReconcile.status = "failed";
  mixedReconcile.authorityOwners.geometry = "web:b";
  mixedReconcile.receipts[2].granted = false;
  mixedReconcile.receipts[2].exact = false;
  const mixed = selectCard5TuiHostFocusBinding({
    ...input,
    lifecycleRecords: [gateReady, bindingReady, mixedReconcile],
  });
  assert.equal(mixed.passed, true);
  assert.equal(mixed.observation.statusMismatch, true);
  assert.equal(mixed.observation.receiptMismatch, true);
  assert.equal(mixed.observation.allTuiOwners, false);
  assert.equal(mixed.observation.authorityOutcome.geometry, "not-granted");
  assert.equal(
    selectCard5TuiHostFocusBinding({
      ...input,
      lifecycleRecords: [gateReady, bindingReady, structuredClone(bindingReady), reconcile],
    }).passed,
    true,
  );

  const laterAuthority = structuredClone(authority);
  laterAuthority.revision = 23;
  laterAuthority.owners = { input: "web:a", focus: "web:a", geometry: "web:b" };
  const focusSettlement = {
    ...reconcile,
    phase: "terminal-host-focus-authority-settled",
    diagnosticEpoch: 8,
    status: "fulfilled",
    bindingCurrent: true,
    authorityRevision: 16,
    authorityOwners: { input: null, focus: null, geometry: null },
    opentuiPresence: { ...reconcile.opentuiPresence, state: "background" },
    receipts: ["input", "focus", "geometry"].map((authorityKind, index) => ({
      authority: authorityKind,
      status: "fulfilled",
      generation: authority.generation,
      granted: true,
      revision: 17 + index,
      session: authority.session,
      clientId: "opentui:42",
    })),
    settledIdentity: {
      clientGeneration: 7,
      clientPhase: "live",
      authorityGeneration: authority.generation,
      runtimeSession: authority.session,
      authorityOwners: authority.owners,
      authorityRevision: 19,
      daemonInstanceId: authority.generation,
      workspaceName: "workspace-a",
      opentuiPresence: reconcile.opentuiPresence,
    },
  };
  assert.equal(
    selectCard5TuiHostFocusBinding({
      ...input,
      lifecycleRecords: [gateReady, bindingReady, focusSettlement],
      expectedAuthority: laterAuthority,
    }).passed,
    true,
  );
  const blurSettlement = {
    ...focusSettlement,
    phase: "terminal-host-blur-authority-settled",
    diagnosticEpoch: 9,
    authorityRevision: 19,
    authorityOwners: authority.owners,
    opentuiPresence: reconcile.opentuiPresence,
    receipts: ["input", "focus", "geometry"].map((authorityKind, index) => ({
      authority: authorityKind,
      status: "fulfilled",
      generation: authority.generation,
      owners: { input: null, focus: null, geometry: null },
      revision: 20 + index,
      session: authority.session,
    })),
    settledIdentity: {
      ...focusSettlement.settledIdentity,
      authorityOwners: { input: null, focus: null, geometry: null },
      authorityRevision: 22,
      opentuiPresence: { ...reconcile.opentuiPresence, state: "background", activityRevision: 22 },
    },
  };
  assert.equal(
    selectCard5TuiHostFocusBinding({
      ...input,
      lifecycleRecords: [gateReady, bindingReady, blurSettlement],
      expectedAuthority: laterAuthority,
    }).passed,
    true,
  );
  for (const mutate of [
    (record) => (record.rendererEpoch = 4),
    (record) => (record.runtimeSession = "runtime-session-b"),
    (record) => (record.clientGeneration = -1),
    (record) => (record.clientId = "opentui:9"),
    (record) => (record.daemonInstanceId = "daemon-generation-b"),
  ]) {
    const changed = structuredClone(bindingReady);
    mutate(changed);
    assert.equal(
      selectCard5TuiHostFocusBinding({
        ...input,
        lifecycleRecords: [changed, focusSettlement],
        expectedAuthority: laterAuthority,
      }).passed,
      false,
    );
  }
});

test("fails closed on stale lifecycle, missing fences, and malformed focus receipts", () => {
  const records = card5FocusTransitionRecords();
  const input = {
    records,
    receipts: {
      blur: card5FocusReceipt("blur"),
      focus: card5FocusReceipt("focus"),
      duplicateFocus: card5FocusReceipt("focus", "no-op"),
    },
    expectedCanonical: {
      processId: "opentui:42",
      clockId: "opentui-performance-now",
      generation: "daemon-generation-a",
    },
    expectedBindingHmac: HMAC,
    expectedWorkspaceName: "workspace-a",
    expectedRendererEpoch: 3,
    expectedClientGeneration: 7,
    expectedRuntimeSession: "runtime-session-a",
    expectedAuthorityOwners: { input: "opentui:42", focus: "opentui:42", geometry: "opentui:42" },
    expectedTuiClientId: "opentui:42",
    minimumBlurAuthorityRevision: 13,
    minimumFocusAuthorityRevision: 13,
    baselineClaimOrdinal: 3,
    evidenceKey: KEY,
  };
  for (const changed of [
    { records: records.filter((record) => record.phase !== "terminal-host-focus-fence") },
    {
      records: records.map((record, index) =>
        index === 4 ? { ...record, processId: "opentui:9" } : record,
      ),
    },
    { receipts: { ...input.receipts, blur: { ...input.receipts.blur, bytesInjected: 2 } } },
    {
      receipts: {
        ...input.receipts,
        duplicateFocus: { ...input.receipts.duplicateFocus, requestedState: "blur" },
      },
    },
    {
      records: records.map((record) =>
        record.phase === "terminal-host-blur-authority-settled"
          ? {
              ...record,
              receipts: record.receipts.map((receipt, index) =>
                index === 0 ? { ...receipt, session: "runtime-session-b" } : receipt,
              ),
            }
          : record,
      ),
    },
    {
      records: records.map((record) =>
        record.phase === "terminal-host-focus-authority-settled"
          ? {
              ...record,
              receipts: record.receipts.map((receipt, index) =>
                index === 0 ? { ...receipt, session: "runtime-session-b" } : receipt,
              ),
            }
          : record,
      ),
    },
    {
      records: records.map((record) =>
        record.phase === "terminal-host-focus-authority-settled"
          ? {
              ...record,
              receipts: record.receipts.map((receipt, index) =>
                index === 0 ? { ...receipt, revision: 13 } : receipt,
              ),
            }
          : record,
      ),
    },
    { expectedRuntimeSession: "runtime-session-b" },
  ]) {
    assert.equal(assessCard5TuiFocusTransition({ ...input, ...changed }).passed, false);
  }
});

test("waits for a delayed blur fence and requires two identical qualified release samples", () => {
  const records = card5FocusTransitionRecords().slice(0, 4);
  const input = {
    receipts: { blur: card5FocusReceipt("blur") },
    expectedCanonical: {
      processId: "opentui:42",
      clockId: "opentui-performance-now",
      generation: "daemon-generation-a",
    },
    expectedBindingHmac: HMAC,
    expectedWorkspaceName: "workspace-a",
    expectedRendererEpoch: 3,
    expectedClientGeneration: 7,
    expectedRuntimeSession: "runtime-session-a",
    expectedAuthorityOwners: {
      input: "opentui:42",
      focus: "opentui:42",
      geometry: "opentui:42",
    },
    expectedTuiClientId: "opentui:42",
    minimumBlurAuthorityRevision: 12,
    minimumFocusAuthorityRevision: 12,
    baselineClaimOrdinal: 3,
    evidenceKey: KEY,
    stage: "blur",
  };
  const beforeFence = assessCard5TuiFocusTransition({ ...input, records: records.slice(0, 3) });
  assert.equal(beforeFence.passed, false);
  const failedObservation = boundedCard5TuiBlurTransitionObservation({
    assessment: beforeFence,
    records: records.slice(0, 3),
    receipt: input.receipts.blur,
    evidenceKey: KEY,
  });
  assert.equal(failedObservation.reason, "focus-blur-lifecycle-invalid");
  assert.equal(failedObservation.fenceCount, 0);
  let stability = advanceCard5AuthorityReleaseStability(undefined, "candidate", false);
  assert.deepEqual(stability, { candidate: null, samples: 0, passed: false });

  const afterFence = assessCard5TuiFocusTransition({ ...input, records });
  assert.equal(afterFence.passed, true);
  const observation = boundedCard5TuiBlurTransitionObservation({
    assessment: afterFence,
    records,
    receipt: input.receipts.blur,
    evidenceKey: KEY,
  });
  assert.deepEqual(Object.keys(observation).sort(), [
    "blurEventCount",
    "controlBindingHmac",
    "controlEpoch",
    "controlStatus",
    "diagnosticEpoch",
    "fenceCount",
    "passed",
    "reason",
    "receiptCount",
    "receiptOverflow",
    "receiptRevisions",
    "receiptStatuses",
    "recordCount",
    "recordOverflow",
    "settledOwnersHmac",
    "settledRevision",
    "settlementCount",
    "tailPosition",
    "writerHealthy",
  ]);
  assert.equal(observation.reason, "exact");
  assert.equal(observation.writerHealthy, true);
  assert.match(observation.settledOwnersHmac, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(observation).includes("opentui:42"), false);
  const candidate = JSON.stringify({ blur: observation, authority: "exact-null" });
  stability = advanceCard5AuthorityReleaseStability(stability, candidate, true);
  assert.deepEqual(stability, { candidate, samples: 1, passed: false });
  stability = advanceCard5AuthorityReleaseStability(stability, candidate, true);
  assert.deepEqual(stability, { candidate, samples: 2, passed: true });
  assert.equal(
    advanceCard5AuthorityReleaseStability(stability, `${candidate}-growth`, true).passed,
    false,
  );
  assert.equal(
    advanceCard5AuthorityReleaseStability(stability, "x".repeat(16_385), true).samples,
    0,
  );
});

test("blur release rejects duplicate, cross-session, stale, foreign-owner, and unhealthy evidence", () => {
  const records = card5FocusTransitionRecords().slice(0, 4);
  const input = {
    records,
    receipts: { blur: card5FocusReceipt("blur") },
    expectedCanonical: {
      processId: "opentui:42",
      clockId: "opentui-performance-now",
      generation: "daemon-generation-a",
    },
    expectedBindingHmac: HMAC,
    expectedWorkspaceName: "workspace-a",
    expectedRendererEpoch: 3,
    expectedClientGeneration: 7,
    expectedRuntimeSession: "runtime-session-a",
    expectedAuthorityOwners: {
      input: "opentui:42",
      focus: "opentui:42",
      geometry: "opentui:42",
    },
    expectedTuiClientId: "opentui:42",
    minimumBlurAuthorityRevision: 13,
    minimumFocusAuthorityRevision: 13,
    baselineClaimOrdinal: 3,
    evidenceKey: KEY,
    stage: "blur",
  };
  const mutateSettlement = (mutate) =>
    records.map((record) =>
      record.phase === "terminal-host-blur-authority-settled" ? mutate(record) : record,
    );
  const invalid = [
    [...records, { ...records[2], monotonicMicros: 104 }],
    mutateSettlement((record) => ({
      ...record,
      receipts: record.receipts.map((receipt, index) =>
        index === 0 ? { ...receipt, session: "runtime-session-b" } : receipt,
      ),
    })),
    mutateSettlement((record) => ({
      ...record,
      receipts: record.receipts.map((receipt, index) =>
        index === 0 ? { ...receipt, revision: 12 } : receipt,
      ),
    })),
    mutateSettlement((record) => ({
      ...record,
      settledIdentity: {
        ...record.settledIdentity,
        authorityOwners: { input: "web-a", focus: null, geometry: null },
      },
    })),
    records.map((record) =>
      record.phase === "terminal-host-focus-fence"
        ? { ...record, writerHealth: { ...record.writerHealth, failed: true } }
        : record,
    ),
  ];
  for (const changedRecords of invalid) {
    assert.equal(
      assessCard5TuiFocusTransition({ ...input, records: changedRecords }).passed,
      false,
    );
  }
});

function focusAuthorityFixture(generation = "daemon-generation-a") {
  return {
    generation,
    session: "runtime-session-a",
    revision: 11,
    owners: { input: "client-a", focus: "client-a", geometry: "client-a" },
    nativeGeometryYieldUntilMs: 0,
    clients: [
      {
        clientId: "client-a",
        surface: "opentui",
        state: "foreground",
        connectedRevision: 1,
        activityRevision: 10,
      },
      {
        clientId: "client-b",
        surface: "web",
        state: "background",
        connectedRevision: 2,
        activityRevision: 9,
      },
      {
        clientId: "client-c",
        surface: "web",
        state: "background",
        connectedRevision: 3,
        activityRevision: 8,
      },
    ],
  };
}

test("seals exact Card5 null authority topology and rejects cross-view splices", () => {
  const authority = {
    ...focusAuthorityFixture(),
    revision: 13,
    owners: { input: null, focus: null, geometry: null },
  };
  const sealed = sealCard5NullAuthority(authority, authority.generation, KEY);
  assert.ok(sealed);
  assert.equal(sealed.authorityRevision, 13);
  assert.equal(
    sealCard5NullAuthority({ ...authority }, authority.generation, KEY)?.authorityHmac,
    sealed.authorityHmac,
  );
  for (const changed of [
    { ...authority, session: "runtime-session-b" },
    { ...authority, revision: 14 },
    { ...authority, owners: { ...authority.owners, focus: "client-a" } },
    {
      ...authority,
      clients: authority.clients.map((client, index) =>
        index === 0 ? { ...client, state: "background" } : client,
      ),
    },
    {
      ...authority,
      clients: authority.clients.map((client, index) =>
        index === 1 ? { ...client, activityRevision: client.activityRevision + 1 } : client,
      ),
    },
  ]) {
    const candidate = sealCard5NullAuthority(changed, changed.generation, KEY);
    if (candidate === null) continue;
    assert.equal(
      candidate.authorityHmac !== sealed.authorityHmac ||
        candidate.authorityTopologyHmac !== sealed.authorityTopologyHmac ||
        candidate.authorityMutationHmac !== sealed.authorityMutationHmac,
      true,
    );
  }
  assert.equal(
    sealCard5NullAuthority({ ...authority, extra: true }, authority.generation, KEY),
    null,
  );
});

test("Card5 null authority pair localizes each view and exact cross-view mismatch", () => {
  const authority = {
    ...focusAuthorityFixture(),
    revision: 13,
    owners: { input: null, focus: null, geometry: null },
  };
  const input = {
    authorities: [authority, structuredClone(authority)],
    generations: [authority.generation, authority.generation],
    minimumRevision: 12,
    evidenceKey: KEY,
  };
  assert.equal(assessCard5NullAuthorityPair(input).passed, true);
  const cases = [
    [{ ...authority, owners: { ...authority.owners, input: "client-a" } }, "owner-nonnull"],
    [{ ...authority, revision: 12 }, "cross-revision"],
    [{ ...authority, revision: 14 }, "cross-revision"],
    [{ ...authority, session: "runtime-session-b" }, "cross-authority"],
    [
      {
        ...authority,
        clients: authority.clients.map((client, index) =>
          index === 0 ? { ...client, state: "background" } : client,
        ),
      },
      "cross-authority",
    ],
    [
      {
        ...authority,
        clients: authority.clients.map((client, index) =>
          index === 0 ? { ...client, activityRevision: client.activityRevision + 1 } : client,
        ),
      },
      "cross-mutation",
    ],
  ];
  for (const [changed, reason] of cases) {
    const result = assessCard5NullAuthorityPair({
      ...input,
      authorities: [authority, changed],
    });
    assert.equal(result.passed, false);
    assert.equal(result.reason, reason);
    assert.equal(JSON.stringify(result.observation).includes("client-a"), false);
    assert.equal(result.observation.views.length, 2);
  }
  assert.equal(
    assessCard5NullAuthorityPair({
      ...input,
      authorities: [
        { ...authority, revision: 12 },
        { ...authority, revision: 12 },
      ],
    }).reason,
    "revision-not-advanced",
  );
  assert.equal(
    assessCard5NullAuthorityPair({
      ...input,
      releaseRevisions: [13, 13, 13],
    }).passed,
    true,
  );
  assert.equal(
    assessCard5NullAuthorityPair({
      ...input,
      releaseRevisions: [14],
    }).reason,
    "release-revision-not-settled",
  );
  assert.equal(
    assessCard5NullAuthorityPair({
      ...input,
      releaseRevisions: [Number.NaN],
    }).reason,
    "contract-invalid",
  );
});

function tuiHandoffFixture(overrides = {}) {
  const payload = "CARD5_HANDOFF_0_deadbeef\n";
  const traceId = "trace-a";
  const canonical = {
    generation: "daemon-generation-a",
    incarnation: "daemon-generation-a:0",
    revision: 1,
    canonicalStateHash: HASH,
    processId: "opentui:123",
    clockId: "opentui-performance-now",
    cols: 80,
    rows: 24,
  };
  const next = { revision: 2, stateHash: "c".repeat(16), cols: 80, rows: 24 };
  const writerHealth = {
    droppedRecords: 0,
    oversizedRecords: 0,
    failed: false,
    pendingCriticalRecords: 0,
  };
  const common = {
    traceId,
    processId: "opentui:123",
    clockId: "opentui-performance-now",
    clockKind: "performance-now",
  };
  const records = [
    {
      version: 1,
      type: "performance.input-origin",
      ...common,
      origin: "bracketed-paste",
      parserConsumption: "paste-event",
      atMicros: 1_000,
      semanticPaneId: "pane-a",
      generation: canonical.generation,
      incarnation: canonical.incarnation,
      revision: canonical.revision,
      stateHash: canonical.canonicalStateHash,
      payloadByteCount: Buffer.byteLength(payload),
      payloadFingerprint: createHmac("sha256", KEY)
        .update(traceId)
        .update("\0")
        .update(payload)
        .digest("hex"),
    },
    {
      version: 1,
      type: "performance.terminal-framebuffer-projection",
      ...common,
      atMicros: 1_025,
      semanticPaneId: "pane-a",
      generation: canonical.generation,
      incarnation: canonical.incarnation,
      ...next,
    },
    {
      version: 1,
      type: "performance.stage",
      stage: "input",
      ...common,
      scenario: "terminal-input-to-paint",
      startedAtMicros: 1_000,
      endedAtMicros: 1_010,
      authority: { generation: canonical.generation, incarnation: canonical.incarnation },
    },
    {
      version: 1,
      type: "performance.stage",
      stage: "paint",
      ...common,
      scenario: "terminal-input-to-paint",
      startedAtMicros: 1_020,
      endedAtMicros: 1_030,
      paintStateIdentity: "latest-canonical-state-blitted",
      semanticPaneId: "pane-a",
      generation: canonical.generation,
      incarnation: canonical.incarnation,
      revision: next.revision,
      stateHash: next.stateHash,
    },
    {
      version: 1,
      type: "performance.input-fence",
      ...common,
      atMicros: 1_031,
      semanticPaneId: "pane-a",
      generation: canonical.generation,
      incarnation: canonical.incarnation,
      revision: next.revision,
      stateHash: next.stateHash,
      writerHealth,
    },
    {
      version: 1,
      type: "performance.terminal-frame-fence",
      semanticPaneId: "pane-a",
      generation: canonical.generation,
      incarnation: canonical.incarnation,
      ...next,
      acceptedRevision: next.revision,
      identityDrops: 0,
      processId: common.processId,
      clockId: common.clockId,
      clockKind: common.clockKind,
      atMicros: 1_050,
      writerHealth,
    },
  ];
  return {
    records,
    hostReceipt: {
      version: 1,
      kind: "paste",
      target: "%7",
      paneId: "%7",
      sessionId: "$3",
      geometry: { cols: 160, rows: 44 },
      delivery: "exact-bytes-to-immutable-host-pane-pty",
      bytesInjected: Buffer.byteLength(`\x1b[200~${payload}\x1b[201~`),
      phases: 1,
      transportCalls: 1,
      physicalTransportCalls: 1,
    },
    payload,
    expectedPane: "pane-a",
    expectedCanonical: canonical,
    inputFingerprintKey: KEY,
    evidenceKey: KEY,
    ...overrides,
  };
}

function tuiFocusedPaneFixture() {
  const input = tuiHandoffFixture();
  const canonical = input.expectedCanonical;
  const common = {
    processId: canonical.processId,
    clockId: canonical.clockId,
    clockKind: "performance-now",
    semanticPaneId: input.expectedPane,
    generation: canonical.generation,
    incarnation: canonical.incarnation,
    revision: canonical.revision,
    stateHash: canonical.canonicalStateHash,
    cols: canonical.cols,
    rows: canonical.rows,
  };
  return {
    records: [
      {
        version: 1,
        type: "performance.terminal-cursor-presentation",
        ...common,
        atMicros: 900,
        viewportCols: 70,
        viewportRows: 20,
        presentationCount: 3,
      },
      {
        version: 1,
        type: "performance.terminal-frame-fence",
        ...common,
        atMicros: 950,
        viewportCols: 70,
        viewportRows: 20,
        acceptedRevision: canonical.revision,
        identityDrops: 0,
        writerHealth: {
          droppedRecords: 0,
          oversizedRecords: 0,
          failed: false,
          pendingCriticalRecords: 0,
        },
      },
    ],
    expectedPane: input.expectedPane,
    expectedCanonical: canonical,
    evidenceKey: KEY,
  };
}

function observation(client, host, overrides = {}) {
  return sealCard5ProductionClientObservation(
    {
      client,
      host,
      generation: "daemon-generation-a",
      connected: true,
      canonicalStateHash: HASH,
      ...(client === "opentui" ? {} : { contentHmac: CONTENT }),
      workspaceName: "workspace-a",
      semanticPaneId: "pane-a",
      incarnation: "incarnation-a",
      processIdentity: `${host}:process-a`,
      clockId: "performance-now",
      atMicros: 10_000,
      revision: 7,
      cols: 120,
      rows: 40,
      deliveryFence: 9,
      presence: client === "web-b" ? "background" : "foreground",
      passive: client !== "opentui",
      geometryOwner: client === "opentui",
      queueCurrent: 0,
      queuePeak: 4,
      queueCap: 32,
      connectElapsedMs: 100,
      ownerToken: "must-not-project",
      descriptor: "must-not-project",
      paneContent: "must-not-project",
      ...overrides,
    },
    KEY,
  );
}

test("production host evidence is exact, bounded, and capability/content free", () => {
  const sealed = observation("web-a", "chromium");
  assert.deepEqual(Object.keys(sealed).sort(), [
    "atMicros",
    "canonicalStateHash",
    "client",
    "clockHmac",
    "cols",
    "connectElapsedMs",
    "connected",
    "correlationHmac",
    "deliveryFence",
    "generation",
    "geometryOwner",
    "host",
    "incarnationHmac",
    "paneHmac",
    "passive",
    "presence",
    "processHmac",
    "queueCap",
    "queueCurrent",
    "queuePeak",
    "renditionHmac",
    "revision",
    "rows",
    "workspaceHmac",
  ]);
  const serialized = JSON.stringify(sealed);
  assert.equal(serialized.includes("must-not-project"), false);
  assert.equal(sealed.correlationHmac.length, 64);
});

test("Card5 correlation joins the same bounded observed records and scans privacy", () => {
  const kinds = [
    "host-open",
    "canonical-before",
    "authority-handoff",
    "slow-isolation",
    "generation-replacement",
    "canonical-after",
    "native-observer",
  ];
  const hmac = (domain, value) =>
    createHmac("sha256", Buffer.from(KEY, "hex")).update(`${domain}\0${value}`).digest("hex");
  const records = kinds.map((kind, ordinal) => {
    const sourceBindings = ["opentui", "web-a", "web-b"].map((client, clientOrdinal) => {
      const paneHmac = "a".repeat(64);
      const processHmac = String(clientOrdinal + 1).repeat(64);
      const clockHmac = String(clientOrdinal + 4).repeat(64);
      return {
        client,
        paneHmac,
        processHmac,
        clockHmac,
        bindingHmac: hmac("source-binding", [client, paneHmac, processHmac, clockHmac].join("\0")),
      };
    });
    const valueHmac = hmac("value", kind);
    return {
      kind,
      ordinal,
      valueHmac,
      sourceBindings,
      recordHmac: hmac(
        "record",
        [kind, ordinal, valueHmac, ...sourceBindings.map(({ bindingHmac }) => bindingHmac)].join(
          "\0",
        ),
      ),
    };
  });
  const sealed = sealCard5CorrelationEvidence(records, KEY);
  assert.equal(sealed.correlation.complete, true);
  assert.equal(sealed.correlation.recordCount, 7);
  assert.equal(sealed.privacy.rawCapabilityCount, 0);
  assert.equal(
    sealCard5CorrelationEvidence([...records, records[0]], KEY).correlation.complete,
    false,
  );
  assert.equal(
    sealCard5CorrelationEvidence(
      records.map((record, index) =>
        index === 2
          ? {
              ...record,
              sourceBindings: record.sourceBindings.map((binding, bindingIndex) =>
                bindingIndex === 1 ? { ...binding, processHmac: "9".repeat(64) } : binding,
              ),
            }
          : record,
      ),
      KEY,
    ).correlation.complete,
    false,
  );
  assert.equal(
    sealCard5CorrelationEvidence(
      records.map((record, index) => (index === 0 ? { ...record, ownerToken: "raw" } : record)),
      KEY,
    ).privacy.rawOwnerTokenCount,
    1,
  );
});

test("canonical convergence requires two identical exact three-host samples", () => {
  const sample = [
    observation("opentui", "opentui"),
    observation("web-a", "chromium"),
    observation("web-b", "electron"),
  ];
  const first = advanceCard5CanonicalStability(null, sample);
  assert.equal(first.stable, false);
  assert.equal(first.reason, "stability-pending");
  assert.equal(advanceCard5CanonicalStability(first.digest, sample).stable, true);
  assert.equal(
    advanceCard5CanonicalStability(first.digest, sample.slice(0, 2)).reason,
    "client-cardinality",
  );
  assert.equal(
    advanceCard5CanonicalStability(first.digest, [sample[0], sample[1], sample[1]]).reason,
    "client-identity",
  );
  const divergence = advanceCard5CanonicalStability(first.digest, [
    sample[0],
    sample[1],
    { ...sample[2], canonicalStateHash: "c".repeat(16) },
  ]);
  assert.equal(divergence.reason, "canonical-divergence");
  assert.deepEqual(divergence.axes, {
    generation: true,
    canonicalHash: false,
    revision: true,
    dimensions: true,
    workspace: true,
    pane: true,
    incarnation: true,
    webRendition: true,
    fieldsComplete: true,
  });
  assert.equal(divergence.candidate.clients.length, 3);
  assert.equal(JSON.stringify(divergence.candidate).includes("workspace-a"), false);
});

test("focused convergence requires two identical Web, cursor, frame, viewport, and authority tuples", () => {
  const focused = tuiFocusedPaneFixture();
  focused.expectedAuthority = focusAuthorityFixture(focused.expectedCanonical.generation);
  const focus = assessCard5TuiFocusedPane(focused).evidence;
  const common = {
    generation: focused.expectedCanonical.generation,
    canonicalStateHash: focused.expectedCanonical.canonicalStateHash,
    semanticPaneId: focused.expectedPane,
    incarnation: focused.expectedCanonical.incarnation,
    revision: focused.expectedCanonical.revision,
    cols: focused.expectedCanonical.cols,
    rows: focused.expectedCanonical.rows,
  };
  const clients = [
    observation("opentui", "opentui", {
      ...common,
      processIdentity: focused.expectedCanonical.processId,
      clockId: focused.expectedCanonical.clockId,
    }),
    observation("web-a", "chromium", common),
    observation("web-b", "electron", common),
  ];
  const first = advanceCard5FocusedConvergenceStability(null, clients, focus, KEY);
  assert.equal(first.stable, false);
  assert.match(first.digest, /^[0-9a-f]{64}$/u);
  assert.equal(
    advanceCard5FocusedConvergenceStability(first.digest, clients, focus, KEY).stable,
    true,
  );
  const changedViewport = { ...focus, viewportCols: focus.viewportCols + 1 };
  const changed = advanceCard5FocusedConvergenceStability(
    first.digest,
    clients,
    changedViewport,
    KEY,
  );
  assert.equal(changed.stable, false);
  assert.notEqual(changed.digest, first.digest);
  const revisionChangedInput = tuiFocusedPaneFixture();
  revisionChangedInput.expectedAuthority = {
    ...focusAuthorityFixture(revisionChangedInput.expectedCanonical.generation),
    revision: 12,
  };
  const revisionChanged = assessCard5TuiFocusedPane(revisionChangedInput).evidence;
  assert.equal(
    advanceCard5FocusedConvergenceStability(first.digest, clients, revisionChanged, KEY).digest,
    first.digest,
  );
  const topologyChangedInput = tuiFocusedPaneFixture();
  const topologyAuthority = focusAuthorityFixture(
    topologyChangedInput.expectedCanonical.generation,
  );
  topologyChangedInput.expectedAuthority = {
    ...topologyAuthority,
    clients: topologyAuthority.clients.map((client, index) =>
      index === 1 ? { ...client, activityRevision: client.activityRevision + 1 } : client,
    ),
  };
  const topologyChanged = assessCard5TuiFocusedPane(topologyChangedInput).evidence;
  assert.equal(topologyChanged.authorityTopologyHmac, focus.authorityTopologyHmac);
  assert.notEqual(topologyChanged.authorityMutationHmac, focus.authorityMutationHmac);
  assert.equal(
    advanceCard5FocusedConvergenceStability(first.digest, clients, topologyChanged, KEY).digest,
    first.digest,
  );
  assert.equal(
    advanceCard5FocusedConvergenceStability(
      null,
      clients,
      {
        ...focus,
        paneHmac: "f".repeat(64),
      },
      KEY,
    ).digest,
    null,
  );
});

test("Card5 TUI convergence selects the latest exact frame fence per pane", () => {
  const tracker = createCard5TuiFrameFenceTracker();
  const fence = (revision, semanticPaneId = "pane-a") => ({
    type: "performance.terminal-frame-fence",
    generation: "generation-a",
    revision,
    acceptedRevision: revision,
    stateHash: revision === 5 ? "b".repeat(16) : "a".repeat(16),
    semanticPaneId,
    incarnation: "generation-a:0",
    cols: 120,
    rows: 40,
    atMicros: 1_000 + revision,
    processId: "opentui:123",
    clockId: "opentui-performance-now",
  });

  assert.equal(tracker.ingest(fence(2)), true);
  assert.equal(tracker.ingest(fence(3)), true);
  assert.equal(tracker.ingest(fence(4)), true);
  assert.equal(tracker.ingest(fence(5)), true);
  assert.equal(tracker.latest("pane-a")?.revision, 5);
  assert.equal(tracker.latest("pane-b"), null);

  const tuiFence = tracker.latest("pane-a");
  const samples = [
    observation("opentui", "opentui", {
      generation: tuiFence.generation,
      canonicalStateHash: tuiFence.canonicalStateHash,
      semanticPaneId: tuiFence.semanticPaneId,
      incarnation: tuiFence.incarnation,
      processIdentity: tuiFence.processId,
      clockId: tuiFence.clockId,
      atMicros: tuiFence.atMicros,
      revision: tuiFence.revision,
      cols: tuiFence.cols,
      rows: tuiFence.rows,
      deliveryFence: tuiFence.deliveryFence,
    }),
    observation("web-a", "chromium", {
      generation: "generation-a",
      canonicalStateHash: "b".repeat(16),
      semanticPaneId: "pane-a",
      incarnation: "generation-a:0",
      revision: 5,
    }),
    observation("web-b", "electron", {
      generation: "generation-a",
      canonicalStateHash: "b".repeat(16),
      semanticPaneId: "pane-a",
      incarnation: "generation-a:0",
      revision: 5,
    }),
  ];
  const first = advanceCard5CanonicalStability(null, samples);
  assert.equal(first.reason, "stability-pending");
  assert.equal(advanceCard5CanonicalStability(first.digest, samples).stable, true);
});

test("Card5 TUI convergence rejects malformed and nonmonotonic frame fences", () => {
  const valid = {
    type: "performance.terminal-frame-fence",
    generation: "generation-a",
    revision: 5,
    acceptedRevision: 5,
    stateHash: "a".repeat(16),
    semanticPaneId: "pane-a",
    incarnation: "generation-a:0",
    cols: 120,
    rows: 40,
    atMicros: 1_005,
    processId: "opentui:123",
    clockId: "opentui-performance-now",
  };
  const malformed = createCard5TuiFrameFenceTracker();
  assert.equal(malformed.ingest({ ...valid, acceptedRevision: 4 }), false);
  assert.equal(malformed.latest("pane-a"), null);

  const nonmonotonic = createCard5TuiFrameFenceTracker();
  assert.equal(nonmonotonic.ingest(valid), true);
  assert.equal(nonmonotonic.ingest({ ...valid, revision: 4, acceptedRevision: 4 }), false);
  assert.equal(nonmonotonic.latest("pane-a"), null);
});

test("Card5 TUI pane selection requires the exact shared qualified Web pane", () => {
  assert.equal(
    exactSharedCard5WebPane([{ semanticPaneId: "pane-b" }, { semanticPaneId: "pane-b" }]),
    "pane-b",
  );
  assert.equal(
    exactSharedCard5WebPane([{ semanticPaneId: "pane-a" }, { semanticPaneId: "pane-b" }]),
    null,
  );
  assert.equal(exactSharedCard5WebPane([{ semanticPaneId: "pane-a" }, {}]), null);
  assert.equal(exactSharedCard5WebPane(undefined), null);
  const stable = [{ semanticPaneId: "pane-a" }, { semanticPaneId: "pane-a" }];
  assert.equal(matchesExpectedCard5WebPane(stable, "pane-a"), true);
  for (const switched of [
    [{ semanticPaneId: "pane-b" }, { semanticPaneId: "pane-b" }],
    [{ semanticPaneId: "pane-a" }, { semanticPaneId: "pane-b" }],
    [{ semanticPaneId: "pane-a" }, {}],
  ]) {
    assert.equal(matchesExpectedCard5WebPane(switched, "pane-a"), false);
  }
  assert.equal(matchesExpectedCard5WebPane(stable, undefined), false);
});

test("Card5 native pane selection is identity-bound and row-order independent", () => {
  const paneA = { paneId: "%1", semanticPaneId: "pane-a" };
  const paneB = { paneId: "%2", semanticPaneId: "pane-b" };
  assert.equal(selectExactCard5PaneGeometry([paneB, paneA], "pane-a"), paneA);
  assert.equal(selectExactCard5PaneGeometry([paneA, paneB], "pane-b"), paneB);
  assert.equal(selectExactCard5PaneGeometry([paneA], "pane-b"), null);
  assert.equal(selectExactCard5PaneGeometry([paneA, { ...paneA }], "pane-a"), null);
  assert.equal(selectExactCard5PaneGeometry([paneA], undefined), null);
});

test("Card5 tmux capture binds hostile semantic identity to one exact raw pane", () => {
  const pane = {
    paneId: "%17",
    semanticPaneId: "pane.promoted.hostile:1.2",
    sessionName: "card5-session",
    sessionId: "$3",
    paneCreated: 123,
    windowActive: true,
    left: 0,
    top: 0,
    width: 120,
    height: 40,
  };
  const sibling = { ...pane, paneId: "%18", semanticPaneId: "pane-other", left: 121 };
  const binding = selectExactCard5TmuxPaneBinding(
    [sibling, pane],
    pane.semanticPaneId,
    pane.sessionName,
  );
  assert.equal(binding.paneId, "%17");
  assert.deepEqual(card5TmuxCapturePaneArgv(binding), ["capture-pane", "-p", "-J", "-t", "%17"]);
  assert.equal(
    JSON.stringify(card5TmuxCapturePaneArgv(binding)).includes(pane.semanticPaneId),
    false,
  );
  assert.equal(
    sameExactCard5TmuxPaneBinding(
      binding,
      selectExactCard5TmuxPaneBinding([pane, sibling], pane.semanticPaneId, pane.sessionName),
    ),
    true,
  );
});

test("Card5 tmux capture rejects missing, duplicate, replaced, or cross-session bindings", () => {
  const pane = {
    paneId: "%17",
    semanticPaneId: "pane-a",
    sessionName: "card5-session",
    sessionId: "$3",
    paneCreated: 123,
    windowActive: true,
    left: 0,
    top: 0,
    width: 120,
    height: 40,
  };
  const binding = selectExactCard5TmuxPaneBinding([pane], "pane-a", "card5-session");
  assert.equal(selectExactCard5TmuxPaneBinding([], "pane-a", "card5-session"), null);
  assert.equal(
    selectExactCard5TmuxPaneBinding([pane, { ...pane }], "pane-a", "card5-session"),
    null,
  );
  assert.equal(selectExactCard5TmuxPaneBinding([pane], "pane-a", "other-session"), null);
  for (const changed of [
    { ...pane, paneId: "%19" },
    { ...pane, paneCreated: 124 },
    { ...pane, sessionId: "$4" },
    { ...pane, left: 1 },
  ]) {
    assert.equal(
      sameExactCard5TmuxPaneBinding(
        binding,
        selectExactCard5TmuxPaneBinding([changed], "pane-a", "card5-session"),
      ),
      false,
    );
  }
  assert.equal(card5TmuxCapturePaneArgv({ paneId: "pane.promoted.hostile" }), null);
});

test("Card5 tmux capture revalidates the exact binding before and after its raw argv", () => {
  const pane = {
    paneId: "%17",
    semanticPaneId: "pane.promoted.hostile",
    sessionName: "card5-session",
    sessionId: "$3",
    paneCreated: 123,
    windowActive: true,
    left: 0,
    top: 0,
    width: 120,
    height: 40,
  };
  const binding = selectExactCard5TmuxPaneBinding([pane], pane.semanticPaneId, pane.sessionName);
  let observations = 0;
  let capturedArgv = null;
  const result = runExactCard5TmuxPaneCapture({
    latchedBinding: binding,
    observeBinding: () => {
      observations += 1;
      return selectExactCard5TmuxPaneBinding([pane], pane.semanticPaneId, pane.sessionName);
    },
    capture: (argv) => {
      capturedArgv = argv;
      return "marker";
    },
  });
  assert.deepEqual(result, { status: "ok", value: "marker" });
  assert.equal(observations, 2);
  assert.deepEqual(capturedArgv, ["capture-pane", "-p", "-J", "-t", "%17"]);

  let turn = 0;
  let calls = 0;
  const drift = runExactCard5TmuxPaneCapture({
    latchedBinding: binding,
    observeBinding: () => {
      turn += 1;
      const current = turn === 1 ? pane : { ...pane, paneId: "%19", paneCreated: 124 };
      return selectExactCard5TmuxPaneBinding([current], pane.semanticPaneId, pane.sessionName);
    },
    capture: () => {
      calls += 1;
      return "marker";
    },
  });
  assert.deepEqual(drift, { status: "topology-changed", value: null });
  assert.equal(calls, 1);

  calls = 0;
  const preDrift = runExactCard5TmuxPaneCapture({
    latchedBinding: binding,
    observeBinding: () => null,
    capture: () => {
      calls += 1;
    },
  });
  assert.deepEqual(preDrift, { status: "topology-changed", value: null });
  assert.equal(calls, 0);
});

test("Card5 TUI focus qualifies the exact current cursor presentation and later frame", () => {
  const input = tuiFocusedPaneFixture();
  const result = assessCard5TuiFocusedPane(input);
  assert.equal(result.passed, true);
  assert.equal(JSON.stringify(result.evidence).includes(input.expectedPane), false);
  assert.equal(result.evidence.revision, input.expectedCanonical.revision);
  assert.equal(result.evidence.cols, 80);
  assert.equal(result.evidence.viewportCols, 70);
});

function tuiRetainedFocusFixture() {
  const initial = tuiFocusedPaneFixture();
  const acceptedFocusEvidence = assessCard5TuiFocusedPane(initial).evidence;
  const common = {
    processId: initial.expectedCanonical.processId,
    clockId: initial.expectedCanonical.clockId,
    clockKind: "performance-now",
    semanticPaneId: initial.expectedPane,
    generation: initial.expectedCanonical.generation,
    incarnation: initial.expectedCanonical.incarnation,
    revision: initial.expectedCanonical.revision,
    stateHash: initial.expectedCanonical.canonicalStateHash,
    cols: initial.expectedCanonical.cols,
    rows: initial.expectedCanonical.rows,
    viewportCols: acceptedFocusEvidence.viewportCols,
    viewportRows: acceptedFocusEvidence.viewportRows,
    sourceEpoch: 4,
    rendererEpoch: 3,
  };
  return {
    records: [
      {
        version: 1,
        type: "performance.terminal-cursor-presentation",
        ...common,
        atMicros: 1_000,
        presentationCount: 4,
      },
      {
        version: 1,
        type: "performance.terminal-focus-fence",
        ...common,
        atMicros: 1_050,
        diagnosticEpoch: 2,
        rendererEpoch: 3,
        focused: true,
        writerHealth: {
          droppedRecords: 0,
          oversizedRecords: 0,
          failed: false,
          pendingCriticalRecords: 0,
        },
      },
    ],
    expectedPane: initial.expectedPane,
    expectedCanonical: initial.expectedCanonical,
    acceptedFocusEvidence,
    expectedDiagnosticEpoch: 2,
    expectedRendererEpoch: 3,
    evidenceKey: KEY,
  };
}

test("Card5 retained focus accepts a production focus-only redraw without a canonical frame", () => {
  const input = tuiRetainedFocusFixture();
  const result = assessCard5TuiRetainedFocus(input);
  assert.equal(result.passed, true);
  assert.equal(
    input.records.some(({ type }) => type === "performance.terminal-frame-fence"),
    false,
  );
  assert.equal(result.evidence.focusStateHmac, input.acceptedFocusEvidence.focusStateHmac);
  assert.match(result.evidence.focusFenceHmac, /^[0-9a-f]{64}$/u);
  assert.equal(result.evidence.rendererEpoch, input.expectedRendererEpoch);
  assert.match(result.evidence.rendererEpochHmac, /^[0-9a-f]{64}$/u);
  const delayed = tuiRetainedFocusFixture();
  delayed.records.splice(1, 1);
  const missing = assessCard5TuiRetainedFocus(delayed);
  let stability = advanceCard5RetainedFocusStability(
    null,
    JSON.stringify(missing.candidate),
    false,
  );
  assert.equal(stability.passed, false);
  delayed.records.push(structuredClone(input.records[1]));
  const settled = assessCard5TuiRetainedFocus(delayed);
  const candidate = JSON.stringify({ focus: settled.candidate, referenceOffset: 2 });
  stability = advanceCard5RetainedFocusStability(stability, candidate, settled.passed);
  assert.equal(stability.passed, false);
  stability = advanceCard5RetainedFocusStability(stability, candidate, settled.passed);
  assert.equal(stability.passed, true);
  assert.equal(
    advanceCard5RetainedFocusStability(stability, `${candidate}-growth`, true).passed,
    false,
  );
});

test("Card5 retained focus rejects missing, foreign, unhealthy, later, or changed evidence", () => {
  const mutations = [
    (value) => value.records.splice(1, 1),
    (value) => (value.records[1].diagnosticEpoch = 3),
    (value) => (value.records[0].rendererEpoch = 2),
    (value) => delete value.records[0].rendererEpoch,
    (value) => (value.records[0].rendererEpoch = Number.MAX_SAFE_INTEGER + 1),
    (value) => (value.records[1].rendererEpoch = 4),
    (value) => (value.records[1].sourceEpoch = 5),
    (value) => (value.records[1].processId = "opentui:456"),
    (value) => (value.records[1].writerHealth.failed = true),
    (value) => value.records.push({ ...structuredClone(value.records[1]), atMicros: 1_075 }),
    (value) =>
      value.records.push({
        ...structuredClone(value.records[0]),
        atMicros: 1_100,
        semanticPaneId: "pane-b",
        presentationCount: 5,
      }),
    (value) =>
      value.records.push({
        version: 1,
        type: "performance.terminal-canonical-update",
        semanticPaneId: value.expectedPane,
        revision: 2,
        stateHash: "d".repeat(16),
      }),
    (value) =>
      value.records.push({
        version: 1,
        ...structuredClone(value.records[1]),
        type: "performance.terminal-frame-fence",
        revision: 2,
        acceptedRevision: 2,
        stateHash: "d".repeat(16),
        atMicros: 1_100,
      }),
  ];
  for (const mutate of mutations) {
    const input = tuiRetainedFocusFixture();
    mutate(input);
    assert.equal(assessCard5TuiRetainedFocus(input).passed, false);
  }
});

test("Card5 TUI focus rejects missing, ambiguous, stale, cross-identity, and unhealthy facts", () => {
  const mutations = [
    (value) => value.records.splice(0, 1),
    (value) => value.records.push({ ...value.records[0] }),
    (value) =>
      value.records.push({
        ...value.records[0],
        atMicros: value.records[0].atMicros + 1,
        semanticPaneId: "pane-b",
      }),
    (value) => (value.records[0].semanticPaneId = "pane-b"),
    (value) => (value.records[0].generation = "daemon-generation-b"),
    (value) => (value.records[0].incarnation = "daemon-generation-a:1"),
    (value) => (value.records[0].revision = 0),
    (value) => (value.records[0].stateHash = "d".repeat(16)),
    (value) => (value.records[0].cols = 79),
    (value) => (value.records[0].rows = 23),
    (value) => (value.records[0].processId = "opentui:456"),
    (value) => (value.records[0].clockId = "foreign-clock"),
    (value) => (value.records[0].viewportCols = 79),
    (value) => value.records.splice(1, 1),
    (value) => (value.records[1].acceptedRevision = 0),
    (value) => (value.records[1].identityDrops = 1),
    (value) => (value.records[1].writerHealth.droppedRecords = 1),
    (value) => (value.records[1].atMicros = 899),
  ];
  for (const mutate of mutations) {
    const input = tuiFocusedPaneFixture();
    mutate(input);
    assert.equal(assessCard5TuiFocusedPane(input).passed, false);
  }
});

test("Card5 retained focus ignores background frames but rejects later focus or canonical change", () => {
  const background = tuiFocusedPaneFixture();
  background.records.push({
    ...structuredClone(background.records[1]),
    semanticPaneId: "pane-b",
    atMicros: 960,
  });
  assert.equal(assessCard5TuiFocusedPane(background).passed, true);

  const repaint = tuiFocusedPaneFixture();
  repaint.records.push({ ...structuredClone(repaint.records[1]), atMicros: 960 });
  assert.equal(assessCard5TuiFocusedPane(repaint).passed, true);
  assert.equal(
    assessCard5TuiFocusedPane(repaint).evidence.focusStateHmac,
    assessCard5TuiFocusedPane(tuiFocusedPaneFixture()).evidence.focusStateHmac,
  );

  const laterCursor = tuiFocusedPaneFixture();
  laterCursor.records.push({
    ...structuredClone(laterCursor.records[0]),
    semanticPaneId: "pane-b",
    atMicros: 960,
  });
  assert.equal(assessCard5TuiFocusedPane(laterCursor).passed, false);

  const changedCanonical = tuiFocusedPaneFixture();
  changedCanonical.records.push({
    ...structuredClone(changedCanonical.records[1]),
    revision: 2,
    acceptedRevision: 2,
    stateHash: "d".repeat(16),
    atMicros: 960,
  });
  assert.equal(assessCard5TuiFocusedPane(changedCanonical).passed, false);
});

test("Card5 TUI focus reports fixed bounded axes and keeps canonical and viewport dimensions separate", () => {
  const input = tuiFocusedPaneFixture();
  input.expectedAuthority = focusAuthorityFixture(input.expectedCanonical.generation);
  const exact = assessCard5TuiFocusedPane(input);
  assert.equal(exact.passed, true);
  assert.deepEqual(Object.values(exact.axes), Array(13).fill(false));
  assert.equal(exact.evidence.cols, 80);
  assert.equal(exact.evidence.rows, 24);
  assert.equal(exact.evidence.viewportCols, 70);
  assert.equal(exact.evidence.viewportRows, 20);
  assert.match(exact.evidence.authorityHmac, /^[0-9a-f]{64}$/u);
  assert.equal(exact.evidence.authorityRevision, 11);
  assert.match(exact.evidence.authorityTopologyHmac, /^[0-9a-f]{64}$/u);

  input.records[0].semanticPaneId = "pane-b";
  const wrongPane = assessCard5TuiFocusedPane(input);
  assert.equal(wrongPane.passed, false);
  assert.equal(wrongPane.axes.pane, true);
  assert.deepEqual(Object.keys(wrongPane.axes), [
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
  ]);
  assert.equal(JSON.stringify(wrongPane.candidate).includes("pane-b"), false);
  assert.match(wrongPane.candidate.paneHmac, /^[0-9a-f]{64}$/u);
});

test("Card5 TUI focus authority requires one exact OpenTUI input and focus owner", () => {
  const generation = "daemon-generation-a";
  const authority = focusAuthorityFixture(generation);
  assert.equal(hasExactCard5TuiFocusAuthority(authority, generation), true);
  for (const invalid of [
    { ...authority, generation: "daemon-generation-b" },
    { ...authority, owners: { ...authority.owners, input: null } },
    { ...authority, owners: { ...authority.owners, focus: "client-b" } },
    { ...authority, clients: [] },
    { ...authority, clients: [...authority.clients, { ...authority.clients[0] }] },
    { ...authority, clients: [{ clientId: "client-a", surface: "web" }] },
  ]) {
    assert.equal(hasExactCard5TuiFocusAuthority(invalid, generation), false);
  }
});

test("Card5 semantic authority changes on owners, clients, presence, connection, or native yield", () => {
  const generation = "daemon-generation-a";
  const authority = focusAuthorityFixture(generation);
  const exact = sealCard5TuiFocusAuthority(authority, generation, KEY);
  const mutations = [
    { ...authority, owners: { ...authority.owners, geometry: "client-b" } },
    {
      ...authority,
      clients: authority.clients.map((client, index) =>
        index === 1 ? { ...client, state: "foreground" } : client,
      ),
    },
    {
      ...authority,
      clients: authority.clients.map((client, index) =>
        index === 1 ? { ...client, connectedRevision: client.connectedRevision + 1 } : client,
      ),
    },
    { ...authority, nativeGeometryYieldUntilMs: 20 },
  ];
  for (const changed of mutations) {
    const sealed = sealCard5TuiFocusAuthority(changed, generation, KEY);
    assert.notEqual(sealed.authorityHmac, exact.authorityHmac);
    assert.notEqual(sealed.authorityTopologyHmac, exact.authorityTopologyHmac);
  }
});

test("Card5 semantic authority merge admits async ambient revisions and rejects causal regression", () => {
  const input = tuiFocusedPaneFixture();
  input.expectedAuthority = focusAuthorityFixture(input.expectedCanonical.generation);
  const left = assessCard5TuiFocusedPane(input).evidence;
  input.expectedAuthority = {
    ...input.expectedAuthority,
    revision: left.authorityRevision + 2,
    clients: input.expectedAuthority.clients.map((client, index) =>
      index === 2 ? { ...client, activityRevision: client.activityRevision + 2 } : client,
    ),
  };
  const right = assessCard5TuiFocusedPane(input).evidence;
  const merged = mergeCard5SemanticAuthorityEvidence(left, right, left.authorityRevision);
  assert.equal(merged.status, "exact");
  assert.equal(merged.evidence.authorityRevision, right.authorityRevision);
  assert.equal(merged.evidence.authorityHmac, left.authorityHmac);
  assert.equal(
    mergeCard5SemanticAuthorityEvidence(left, right, right.authorityRevision + 1).status,
    "revision-regressed",
  );
  assert.equal(
    mergeCard5SemanticAuthorityEvidence(
      left,
      { ...right, authorityTopologyHmac: "f".repeat(64) },
      left.authorityRevision,
    ).status,
    "semantic-mismatch",
  );
});

test("Card5 TUI handoff separates the outer host pane from the exact semantic trace", () => {
  const input = tuiHandoffFixture();
  assert.equal(isExactCard5TuiHostInputReceipt(input.hostReceipt, input.payload), true);
  const result = assessCard5TuiHandoffInput(input);
  assert.equal(result.passed, true);
  assert.equal(input.hostReceipt.paneId === input.expectedPane, false);
  assert.equal(JSON.stringify(result.evidence).includes("%7"), false);
  assert.equal(JSON.stringify(result.evidence).includes("pane-a"), false);
  assert.match(result.evidence.hostPaneHmac, /^[0-9a-f]{64}$/u);
  assert.match(result.evidence.paneHmac, /^[0-9a-f]{64}$/u);
});

test("Card5 TUI handoff rejects wrong, duplicated, missing, and spliced semantic traces", () => {
  const mutations = [
    (value) => (value.records[0].semanticPaneId = "pane-b"),
    (value) => (value.records[4].semanticPaneId = "pane-b"),
    (value) => (value.records[3].semanticPaneId = "pane-b"),
    (value) => value.records.push({ ...value.records[0] }),
    (value) => value.records.splice(4, 1),
    (value) => (value.records[3].traceId = "trace-b"),
    (value) => (value.records[0].generation = "daemon-generation-b"),
    (value) => (value.records[3].incarnation = "daemon-generation-a:1"),
    (value) => (value.records[0].payloadFingerprint = "f".repeat(64)),
    (value) => (value.records[5].acceptedRevision = 1),
    (value) => (value.records[5].identityDrops = 1),
    (value) => (value.records[4].processId = "opentui:456"),
    (value) => {
      value.expectedCanonical.processId = "opentui:456";
    },
    (value) => (value.records[3].clockId = "foreign-clock"),
    (value) => (value.records[2].endedAtMicros = 999),
    (value) => (value.records[3].startedAtMicros = 1_005),
    (value) => value.records.splice(2, 2, value.records[3], value.records[2]),
    (value) => value.records.splice(1, 2, value.records[2], value.records[1]),
    (value) => (value.records[4].writerHealth.oversizedRecords = 1),
    (value) => (value.hostReceipt.physicalTransportCalls = 2),
  ];
  for (const mutate of mutations) {
    const input = tuiHandoffFixture();
    mutate(input);
    assert.equal(assessCard5TuiHandoffInput(input).passed, false);
  }
});

test("Card5 browser observation is deadline bounded and consumes late settlement", async () => {
  let expire;
  let settle;
  const pending = new Promise((resolve) => {
    settle = resolve;
  });
  const resultPromise = observeCard5WithinDeadline(() => pending, {
    deadline: 5_000,
    now: () => 0,
    scheduleDeadline: (callback) => {
      expire = callback;
      return 1;
    },
    cancelDeadline: () => undefined,
  });
  await Promise.resolve();
  expire();
  assert.deepEqual(await resultPromise, { status: "deadline", value: null });
  settle("late-private-page-result");
  await Promise.resolve();
});

test("Card5 browser observation rejects a result that settles after its deadline", async () => {
  const clock = [0, 5_001];
  assert.deepEqual(
    await observeCard5WithinDeadline(async () => ["late"], {
      deadline: 5_000,
      now: () => clock.shift(),
      scheduleDeadline: () => 1,
      cancelDeadline: () => undefined,
    }),
    { status: "deadline", value: null },
  );
});

test("Card5 browser observation consumes a late rejection and rejects a regressing clock", async () => {
  let expire;
  let rejectLate;
  const pending = new Promise((_, reject) => {
    rejectLate = reject;
  });
  const resultPromise = observeCard5WithinDeadline(() => pending, {
    deadline: 5_000,
    now: () => 0,
    scheduleDeadline: (callback) => {
      expire = callback;
      return 1;
    },
    cancelDeadline: () => undefined,
  });
  await Promise.resolve();
  expire();
  assert.deepEqual(await resultPromise, { status: "deadline", value: null });
  rejectLate(new Error("late private renderer failure"));
  await Promise.resolve();

  const clock = [10, 9];
  assert.deepEqual(
    await observeCard5WithinDeadline(async () => ["value"], {
      deadline: 5_000,
      now: () => clock.shift(),
      scheduleDeadline: () => 1,
      cancelDeadline: () => undefined,
    }),
    { status: "clock-invalid", value: null },
  );
});

test("host failure evidence is enum-only and saturated", () => {
  assert.deepEqual(
    boundedCard5HostFailureObservation({
      reason: "queue-overflow",
      host: "electron",
      attempts: 99_999,
      elapsedMs: 99_999,
      observedClients: 99,
      stableSamples: 99,
      queuePeak: 99_999,
      secret: "not-projected",
    }),
    {
      operation: "card5-production-host-observation",
      reason: "queue-overflow",
      host: "electron",
      attempts: 4_096,
      elapsedMs: 60_000,
      observedClients: 3,
      stableSamples: 2,
      queuePeak: 65_535,
      divergenceAxes: null,
      focusDivergenceAxes: null,
      focusCandidates: [],
      authorityViews: [],
      candidateSummaries: [],
    },
  );
});

test("host failure evidence distinguishes semantic authority from ambient mutation clocks", () => {
  const input = tuiFocusedPaneFixture();
  input.expectedAuthority = focusAuthorityFixture(input.expectedCanonical.generation);
  const first = assessCard5TuiFocusedPane(input).evidence;
  input.expectedAuthority = {
    ...input.expectedAuthority,
    revision: input.expectedAuthority.revision + 1,
    clients: input.expectedAuthority.clients.map((client, index) =>
      index === 1 ? { ...client, activityRevision: client.activityRevision + 1 } : client,
    ),
  };
  const second = assessCard5TuiFocusedPane(input).evidence;
  const observed = boundedCard5HostFailureObservation({
    reason: "stability-timeout",
    authorityViews: [
      {
        a: first,
        b: second,
        semanticEqual: true,
        revisionMonotonic: true,
        activityA: {
          count: 66,
          overflow: true,
          events: [
            { ordinal: 64, surface: "web", kind: "focus", outcome: "ok" },
            {
              ordinal: 65,
              surface: "web",
              kind: "geometry",
              outcome: "attempt",
              dimensionsHmac: "c".repeat(64),
            },
            {
              ordinal: 66,
              surface: "web",
              kind: "geometry",
              outcome: "ok",
              dimensionsHmac: "c".repeat(64),
              raw: "private",
            },
          ],
          geometrySettlements: [
            {
              ordinal: 1,
              requestHmac: "a".repeat(64),
              clientHmac: "b".repeat(64),
              dimensionsHmac: "c".repeat(64),
            },
          ],
        },
      },
    ],
  });
  assert.equal(observed.authorityViews.length, 1);
  assert.equal(observed.authorityViews[0].semanticEqual, true);
  assert.equal(
    observed.authorityViews[0].a.semanticHmac,
    observed.authorityViews[0].b.semanticHmac,
  );
  assert.notEqual(
    observed.authorityViews[0].a.mutationHmac,
    observed.authorityViews[0].b.mutationHmac,
  );
  assert.deepEqual(Object.keys(observed.authorityViews[0].a), [
    "valid",
    "reason",
    "axes",
    "counts",
    "ownerHmac",
    "clientsHmac",
    "recordTransitions",
    "revision",
    "semanticHmac",
    "topologyHmac",
    "mutationHmac",
    "mode",
    "relation",
    "grantRevision",
    "releaseRevision",
    "relationHmac",
    "sequenceHmac",
    "duplicateCount",
  ]);
  assert.deepEqual(observed.authorityViews[0].activityA.byKind, {
    focus: 1,
    geometry: 2,
    input: 0,
  });
  assert.equal(observed.authorityViews[0].activityA.events.length, 3);
  assert.equal(observed.authorityViews[0].activityA.geometrySettlements.length, 1);
  assert.equal(JSON.stringify(observed.authorityViews).includes("private"), false);
});

test("Card5 authority seal rejection is exact, bounded, and identity opaque", () => {
  const exact = assessCard5TuiFocusAuthority(focusAuthorityFixture(), "daemon-generation-a", KEY, [
    {
      ordinal: 1,
      revision: 10,
      inputOwner: "private-tui",
      focusOwner: "private-tui",
      geometryOwner: "private-web",
      clients: focusAuthorityFixture().clients,
    },
  ]);
  assert.equal(exact.valid, true);
  assert.equal(exact.reason, null);
  assert.equal(exact.recordTransitions.length, 1);
  assert.equal(JSON.stringify(exact).includes("private-"), false);
  const adversaries = [
    ["generation-mismatch", (value) => (value.generation = "other-generation")],
    ["session-invalid", (value) => (value.session = "")],
    ["revision-invalid", (value) => (value.revision = -1)],
    ["native-yield-invalid", (value) => (value.nativeGeometryYieldUntilMs = -1)],
    ["client-count-invalid", (value) => value.clients.pop()],
    ["client-schema-invalid", (value) => (value.clients[0].state = "unknown")],
    ["surface-cardinality-invalid", (value) => (value.clients[1].surface = "sdk")],
    ["duplicate-client", (value) => (value.clients[1].clientId = value.clients[0].clientId)],
    ["input-owner-invalid", (value) => (value.owners.input = value.clients[1].clientId)],
    ["focus-owner-invalid", (value) => (value.owners.focus = value.clients[1].clientId)],
  ];
  for (const [reason, mutate] of adversaries) {
    const authority = structuredClone(focusAuthorityFixture());
    mutate(authority);
    const assessed = assessCard5TuiFocusAuthority(authority, "daemon-generation-a", KEY);
    assert.equal(assessed.valid, false);
    assert.equal(assessed.reason, reason);
    assert.equal(
      assessed.axes[
        reason === "duplicate-client"
          ? "duplicateClients"
          : Object.keys(assessed.axes).find((key) => assessed.axes[key])
      ],
      true,
    );
  }
});

test("Card5 post-handoff authority accepts retained owner or causal later null", () => {
  const retained = focusAuthorityFixture();
  retained.revision = 12;
  const retainedRecord = {
    ordinal: 1,
    generation: "daemon-generation-a",
    session: retained.session,
    revision: 11,
    nativeGeometryYieldUntilMs: retained.nativeGeometryYieldUntilMs,
    inputOwner: "client-a",
    focusOwner: "client-a",
    geometryOwner: "client-a",
    clients: structuredClone(retained.clients),
  };
  const retainedCurrentRecord = {
    ...structuredClone(retainedRecord),
    ordinal: 2,
    revision: 12,
  };
  const retainedResult = assessCard5PostHandoffAuthority({
    authority: retained,
    authorityRecords: [retainedRecord, retainedCurrentRecord],
    generation: "daemon-generation-a",
    expectedClientId: "client-a",
    expectedSurface: "opentui",
    grantRevision: 11,
    inputProofHmac: HMAC,
    evidenceKey: KEY,
  });
  assert.equal(retainedResult.valid, true);
  assert.equal(retainedResult.relation, "retained-owner");

  const released = structuredClone(retained);
  released.revision = 13;
  released.owners = { input: null, focus: null, geometry: null };
  released.clients.find(({ clientId }) => clientId === "client-a").state = "background";
  const releaseRecord = {
    ordinal: 3,
    generation: "daemon-generation-a",
    session: released.session,
    revision: 13,
    nativeGeometryYieldUntilMs: released.nativeGeometryYieldUntilMs,
    inputOwner: null,
    focusOwner: null,
    geometryOwner: null,
    clients: structuredClone(released.clients),
  };
  const releasedResult = assessCard5PostHandoffAuthority({
    authority: released,
    authorityRecords: [retainedRecord, retainedCurrentRecord, releaseRecord],
    generation: "daemon-generation-a",
    expectedClientId: "client-a",
    expectedSurface: "opentui",
    grantRevision: 11,
    inputProofHmac: HMAC,
    evidenceKey: KEY,
  });
  assert.equal(releasedResult.valid, true);
  assert.equal(releasedResult.relation, "released-null");
  assert.equal(releasedResult.evidence.releaseRevision, 13);
});

test("Card5 post-handoff authority rejects unexplained null, rollback, and cross-client owners", () => {
  const authority = focusAuthorityFixture();
  authority.revision = 11;
  const grant = {
    ordinal: 1,
    generation: "daemon-generation-a",
    session: authority.session,
    revision: 11,
    nativeGeometryYieldUntilMs: authority.nativeGeometryYieldUntilMs,
    inputOwner: "client-a",
    focusOwner: "client-a",
    geometryOwner: "client-a",
    clients: structuredClone(authority.clients),
  };
  const input = {
    authority,
    authorityRecords: [grant],
    generation: "daemon-generation-a",
    expectedClientId: "client-a",
    expectedSurface: "opentui",
    grantRevision: 11,
    inputProofHmac: HMAC,
    evidenceKey: KEY,
  };
  const unexplained = structuredClone(input);
  unexplained.authority.owners = { input: null, focus: null, geometry: null };
  assert.equal(assessCard5PostHandoffAuthority(unexplained).valid, false);
  const rollback = structuredClone(input);
  rollback.authority.revision = 10;
  assert.equal(assessCard5PostHandoffAuthority(rollback).valid, false);
  const crossOwner = structuredClone(input);
  crossOwner.authority.owners.input = "client-b";
  assert.equal(assessCard5PostHandoffAuthority(crossOwner).valid, false);
  const crossGrant = structuredClone(input);
  crossGrant.authorityRecords[0].inputOwner = "client-b";
  assert.equal(assessCard5PostHandoffAuthority(crossGrant).valid, false);
  const topologyChange = structuredClone(input);
  topologyChange.authorityRecords[0].clients[1].connectedRevision += 1;
  assert.equal(assessCard5PostHandoffAuthority(topologyChange).valid, false);
  const arbitraryOwner = structuredClone(input);
  arbitraryOwner.authority.owners.geometry = "client-b";
  assert.equal(assessCard5PostHandoffAuthority(arbitraryOwner).valid, false);
});

test("Card5 post-handoff authority rejects every invalid post-grant state transition", () => {
  const make = () => {
    const authority = focusAuthorityFixture();
    authority.revision = 13;
    const record = (ordinal, revision, owners, state = "foreground") => {
      const clients = structuredClone(authority.clients);
      clients.find(({ clientId }) => clientId === "client-a").state = state;
      return {
        ordinal,
        generation: authority.generation,
        session: authority.session,
        revision,
        nativeGeometryYieldUntilMs: authority.nativeGeometryYieldUntilMs,
        inputOwner: owners.input,
        focusOwner: owners.focus,
        geometryOwner: owners.geometry,
        clients,
      };
    };
    const owned = { input: "client-a", focus: "client-a", geometry: "client-a" };
    const records = [record(1, 11, owned), record(2, 12, owned), record(3, 13, owned)];
    return {
      authority,
      authorityRecords: records,
      generation: authority.generation,
      expectedClientId: "client-a",
      expectedSurface: "opentui",
      grantRevision: 11,
      inputProofHmac: HMAC,
      evidenceKey: KEY,
    };
  };
  const rejected = (mutate) => {
    const input = make();
    mutate(input);
    assert.equal(assessCard5PostHandoffAuthority(input).valid, false);
  };
  rejected(({ authorityRecords }) => {
    authorityRecords[1].inputOwner = "client-b";
  });
  rejected(({ authority, authorityRecords }) => {
    authorityRecords[1].inputOwner = "client-b";
    authorityRecords[2].inputOwner = null;
    authorityRecords[2].focusOwner = null;
    authorityRecords[2].geometryOwner = null;
    authorityRecords[2].clients.find(({ clientId }) => clientId === "client-a").state =
      "background";
    authority.owners = { input: null, focus: null, geometry: null };
    authority.clients.find(({ clientId }) => clientId === "client-a").state = "background";
  });
  rejected(({ authority, authorityRecords }) => {
    authorityRecords[1].inputOwner = null;
    authorityRecords[1].focusOwner = null;
    authorityRecords[1].geometryOwner = null;
    authorityRecords[1].clients.find(({ clientId }) => clientId === "client-a").state =
      "background";
    authorityRecords[2].clients.find(({ clientId }) => clientId === "client-a").state =
      "foreground";
    authority.owners = authorityRecords[2].inputOwner
      ? { input: "client-a", focus: "client-a", geometry: "client-a" }
      : authority.owners;
  });
  rejected(({ authority, authorityRecords }) => {
    authorityRecords[2].inputOwner = null;
    authorityRecords[2].focusOwner = null;
    authorityRecords[2].geometryOwner = null;
    authority.owners = { input: null, focus: null, geometry: null };
  });
  rejected(({ authorityRecords }) => {
    authorityRecords[2].revision = authorityRecords[1].revision;
  });
  rejected(({ authorityRecords }) => {
    authorityRecords[2].revision = authorityRecords[1].revision - 1;
  });
  rejected(({ authorityRecords }) => {
    authorityRecords[1].clients.find(({ clientId }) => clientId === "client-b").state =
      "foreground";
  });
  rejected(({ authorityRecords }) => {
    authorityRecords[2].revision = 14;
  });
});

test("Card5 post-handoff authority accepts an exact Web transfer", () => {
  const authority = focusAuthorityFixture();
  const web = authority.clients.find(({ clientId }) => clientId === "client-b");
  web.state = "foreground";
  authority.clients.find(({ clientId }) => clientId === "client-a").state = "background";
  authority.owners = {
    input: "client-b",
    focus: "client-b",
    geometry: "client-b",
  };
  authority.revision = 15;
  const result = assessCard5PostHandoffAuthority({
    authority,
    authorityRecords: [
      {
        ordinal: 3,
        generation: "daemon-generation-a",
        session: authority.session,
        revision: 15,
        nativeGeometryYieldUntilMs: authority.nativeGeometryYieldUntilMs,
        inputOwner: "client-b",
        focusOwner: "client-b",
        geometryOwner: "client-b",
        clients: structuredClone(authority.clients),
      },
    ],
    generation: "daemon-generation-a",
    expectedClientId: "client-b",
    expectedSurface: "web",
    grantRevision: 15,
    inputProofHmac: HMAC,
    evidenceKey: KEY,
  });
  assert.equal(result.valid, true);
  assert.equal(result.relation, "retained-owner");
});

test("Card5 post-handoff authority collapses only bounded byte-exact revision replays", () => {
  const authority = focusAuthorityFixture();
  authority.revision = 12;
  const record = (ordinal, revision) => ({
    ordinal,
    generation: authority.generation,
    session: authority.session,
    revision,
    nativeGeometryYieldUntilMs: authority.nativeGeometryYieldUntilMs,
    inputOwner: "client-a",
    focusOwner: "client-a",
    geometryOwner: "client-a",
    clients: structuredClone(authority.clients),
  });
  const input = {
    authority,
    authorityRecords: [record(1, 11), record(2, 11), record(3, 12), record(4, 12)],
    generation: authority.generation,
    expectedClientId: "client-a",
    expectedSurface: "opentui",
    grantRevision: 11,
    inputProofHmac: HMAC,
    evidenceKey: KEY,
  };
  input.authorityRecords[1].clients.reverse();
  input.authorityRecords[3].clients.reverse();
  const exact = assessCard5PostHandoffAuthority(input);
  assert.equal(exact.valid, true);
  assert.equal(exact.evidence.authorityDuplicateCount, 2);
  assert.match(exact.evidence.authoritySequenceHmac, /^[0-9a-f]{64}$/u);

  for (const mutate of [
    (value) => (value.authorityRecords[1].inputOwner = null),
    (value) =>
      (value.authorityRecords[1].clients.find(({ clientId }) => clientId === "client-a").state =
        "background"),
    (value) => (value.authorityRecords[1].nativeGeometryYieldUntilMs += 1),
    (value) => (value.authorityRecords[1].generation = "other-generation"),
    (value) => (value.authorityRecords[1].session = "other-session"),
  ]) {
    const conflict = structuredClone(input);
    mutate(conflict);
    assert.equal(assessCard5PostHandoffAuthority(conflict).valid, false);
  }
  const storm = structuredClone(input);
  storm.authority.revision = 11;
  storm.authorityRecords = Array.from({ length: 10 }, (_, index) => record(index + 1, 11));
  assert.equal(assessCard5PostHandoffAuthority(storm).valid, false);
});

test("Card5 post-handoff authority returns typed failures for malformed raw records", () => {
  const authority = focusAuthorityFixture();
  authority.revision = 11;
  const exactRecord = {
    ordinal: 1,
    generation: authority.generation,
    session: authority.session,
    revision: 11,
    nativeGeometryYieldUntilMs: authority.nativeGeometryYieldUntilMs,
    inputOwner: "client-a",
    focusOwner: "client-a",
    geometryOwner: "client-a",
    clients: structuredClone(authority.clients),
  };
  const input = {
    authority,
    authorityRecords: [exactRecord],
    generation: authority.generation,
    expectedClientId: "client-a",
    expectedSurface: "opentui",
    grantRevision: 11,
    inputProofHmac: HMAC,
    evidenceKey: KEY,
  };
  const adversaries = [
    (record) => delete record.clients,
    (record) => (record.clients = null),
    (record) => (record.clients = {}),
    (record) => (record.clients[0] = null),
    (record) => (record.clients[0].clientId = ""),
    (record) => (record.nativeGeometryYieldUntilMs = Number.MAX_SAFE_INTEGER + 1),
    (record) => (record.revision = Number.MAX_SAFE_INTEGER + 1),
    (record) => (record.ordinal = Number.MAX_SAFE_INTEGER + 1),
    (record) => (record.extra = true),
    (record) => delete record.session,
  ];
  for (const mutate of adversaries) {
    const malformed = structuredClone(input);
    mutate(malformed.authorityRecords[0]);
    let result;
    assert.doesNotThrow(() => {
      result = assessCard5PostHandoffAuthority(malformed);
    });
    assert.deepEqual(result, {
      valid: false,
      reason: "post-handoff-contract-invalid",
      evidence: null,
    });
  }
});

test("Card5 authority activity cap fails closed at cap plus one and malformed evidence", () => {
  const events = Array.from({ length: 64 }, (_, index) => ({
    ordinal: index + 1,
    surface: "web",
    kind: "focus",
    outcome: "ok",
    operationOrdinal: null,
    dimensionsHmac: null,
  }));
  const activity = (source, settlements = []) => ({
    count: source.length,
    overflow: false,
    events: source,
    geometrySettlements: settlements,
  });
  assert.equal(card5AuthorityActivityWithinCap(activity(events)), true);
  const tuiClaims = events.slice(0, 2).map((event) => ({ ...event, surface: "opentui" }));
  assert.equal(card5AuthorityActivityWithinCap(activity(tuiClaims)), true);
  assert.equal(
    card5AuthorityActivityWithinCap(activity([tuiClaims[0], { ...tuiClaims[1], ordinal: 3 }])),
    false,
    "a gapped private OpenTUI claim ordinal must not be renumbered into validity",
  );
  assert.equal(
    card5AuthorityActivityWithinCap({ ...activity(events), count: 65, overflow: true }),
    false,
  );
  assert.equal(card5AuthorityActivityWithinCap({ ...activity(events.slice(1)), count: 64 }), false);
  assert.equal(
    card5AuthorityActivityWithinCap({ ...activity(events.slice(0, 1)), extra: true }),
    false,
  );
  for (const mutation of [
    (candidate) => (candidate[1].ordinal = 1),
    (candidate) => (candidate[1].surface = "unknown"),
    (candidate) => (candidate[1].kind = "unknown"),
    (candidate) => (candidate[1].outcome = "attempt"),
    (candidate) => (candidate[1].operationOrdinal = 1),
    (candidate) => (candidate[1].dimensionsHmac = "a".repeat(64)),
    (candidate) => (candidate[1].extra = true),
  ]) {
    const candidate = structuredClone(events.slice(0, 2));
    mutation(candidate);
    assert.equal(card5AuthorityActivityWithinCap(activity(candidate)), false);
  }
  const dimensionsHmac = "c".repeat(64);
  const geometry = [
    {
      ordinal: 1,
      surface: "web",
      kind: "geometry",
      outcome: "attempt",
      operationOrdinal: 1,
      dimensionsHmac,
    },
    {
      ordinal: 2,
      surface: "web",
      kind: "geometry",
      outcome: "ok",
      operationOrdinal: 1,
      dimensionsHmac,
    },
  ];
  const settlement = {
    ordinal: 0,
    operationOrdinal: 1,
    requestHmac: "a".repeat(64),
    clientHmac: "b".repeat(64),
    dimensionsHmac,
  };
  assert.equal(card5AuthorityActivityWithinCap(activity(geometry, [settlement])), true);
  assert.equal(
    card5AuthorityActivityWithinCap(
      activity(
        [{ ...geometry[0] }, { ...geometry[1], dimensionsHmac: "d".repeat(64) }],
        [settlement],
      ),
    ),
    false,
  );
  assert.equal(
    card5AuthorityActivityWithinCap(
      activity(geometry, [{ ...settlement, dimensionsHmac: "d".repeat(64) }]),
    ),
    false,
  );
  assert.equal(card5AuthorityActivityWithinCap(activity(geometry.slice(0, 1))), true);
  assert.equal(card5AuthorityActivityWithinCap(activity(geometry)), false);
  assert.equal(
    card5AuthorityActivityWithinCap(activity(geometry, [settlement, settlement])),
    false,
  );
  assert.equal(
    card5AuthorityActivityWithinCap(activity(geometry, [{ ...settlement, ordinal: 1 }])),
    false,
  );
  const twoSameDimensions = [
    ...geometry,
    { ...geometry[0], ordinal: 3, operationOrdinal: 2 },
    { ...geometry[1], ordinal: 4, operationOrdinal: 2 },
  ];
  assert.equal(card5AuthorityActivityWithinCap(activity(twoSameDimensions, [settlement])), false);
  assert.equal(
    card5AuthorityActivityWithinCap(
      activity(twoSameDimensions, [
        settlement,
        {
          ...settlement,
          ordinal: 1,
          operationOrdinal: 2,
          requestHmac: "d".repeat(64),
        },
      ]),
    ),
    true,
  );
  assert.equal(
    boundedCard5HostFailureObservation({ reason: "authority-activity-storm" }).reason,
    "authority-activity-storm",
  );
});

test("host failure evidence seals two bounded focus candidates and every divergence axis", () => {
  const focus = assessCard5TuiFocusedPane(tuiFocusedPaneFixture());
  const axes = { ...focus.axes, pane: true };
  const observed = boundedCard5HostFailureObservation({
    reason: "stability-timeout",
    focusDivergenceAxes: axes,
    focusCandidates: [focus.candidate, focus.candidate, { ...focus.candidate, secret: "raw" }],
  });
  assert.deepEqual(observed.focusDivergenceAxes, axes);
  assert.equal(observed.focusCandidates.length, 2);
  assert.deepEqual(Object.keys(observed.focusCandidates[0]), [
    "paneHmac",
    "generationHmac",
    "incarnationHmac",
    "processHmac",
    "clockHmac",
    "canonicalHashHmac",
    "revision",
    "cols",
    "rows",
    "viewportCols",
    "viewportRows",
    "presentationCount",
    "presentationHmac",
    "frameHmac",
    "authoritySequenceHmac",
  ]);
  assert.equal(JSON.stringify(observed).includes("raw"), false);
});

function card5WebReleaseFixture() {
  const expected = {
    expectedAuthorities: ["input", "focus"],
    workspaceHmac: "1".repeat(64),
    generationHmac: "2".repeat(64),
    runtimeSessionHmac: "3".repeat(64),
    paneHmac: "4".repeat(64),
    requestHmacs: ["5".repeat(64), "6".repeat(64)],
    clientHmacs: {
      input: "7".repeat(64),
      focus: "8".repeat(64),
      geometry: "9".repeat(64),
    },
  };
  const receipt = (authority, requestHmac, clientHmac, operationOrdinal) => ({
    authority,
    status: "released",
    operationOrdinal,
    beforeRevision: operationOrdinal + 10,
    afterRevision: operationOrdinal + 11,
    workspaceHmac: expected.workspaceHmac,
    generationHmac: expected.generationHmac,
    runtimeSessionHmac: expected.runtimeSessionHmac,
    paneHmac: expected.paneHmac,
    requestHmac,
    clientHmac,
  });
  const results = [
    {
      status: "exact",
      pageHmac: "a".repeat(64),
      localClientHmac: "b".repeat(64),
      preOwnerTupleHmac: "c".repeat(64),
      preRevisionHmac: "d".repeat(64),
      receipts: [receipt("input", expected.requestHmacs[0], expected.clientHmacs.input, 1)],
    },
    {
      status: "exact",
      pageHmac: "e".repeat(64),
      localClientHmac: null,
      preOwnerTupleHmac: "f".repeat(64),
      preRevisionHmac: "0".repeat(64),
      receipts: [receipt("focus", expected.requestHmacs[1], expected.clientHmacs.focus, 2)],
    },
  ];
  return { expected, results };
}

test("Web release evidence preserves exact bounded page and receipt joins", () => {
  const { expected, results } = card5WebReleaseFixture();
  const assessed = assessCard5WebAuthorityRelease({ ...expected, results });
  assert.equal(assessed.passed, true);
  assert.equal(assessed.observation.resultCount, 2);
  assert.equal(assessed.observation.expectedReceiptCount, 2);
  assert.equal(assessed.observation.actualReceiptCount, 2);
  assert.equal(assessed.observation.pages.length, 2);
  assert.equal(assessed.observation.receipts.length, 2);
  assert.equal(assessed.observation.pages[0].pageHmac, "a".repeat(64));
  assert.equal(assessed.observation.pages[0].localClientHmac, "b".repeat(64));
  assert.equal(assessed.observation.pages[1].preOwnerTupleHmac, "f".repeat(64));
  assert.deepEqual(Object.values(assessed.observation.axes), Array(17).fill(false));
  assert.equal(JSON.stringify(assessed).includes("raw-client"), false);
});

test("Web release evidence identifies every rejected acceptance conjunct", () => {
  const adversaries = [
    ["resultStatus", (value) => (value.results[0].status = "binding-invalid")],
    ["resultCount", (value) => value.results.pop()],
    ["receiptCount", (value) => value.results[1].receipts.pop()],
    ["inputCardinality", (value) => (value.results[1].receipts[0].authority = "input")],
    ["releasedStatus", (value) => (value.results[0].receipts[0].status = "rejected")],
    ["operationOrdinal", (value) => (value.results[0].receipts[0].operationOrdinal = 0)],
    ["revisionOrder", (value) => (value.results[0].receipts[0].afterRevision = 11)],
    ["workspace", (value) => (value.results[0].receipts[0].workspaceHmac = HMAC)],
    ["generation", (value) => (value.results[0].receipts[0].generationHmac = HMAC)],
    ["runtimeSession", (value) => (value.results[0].receipts[0].runtimeSessionHmac = HMAC)],
    ["pane", (value) => (value.results[0].receipts[0].paneHmac = HMAC)],
    ["request", (value) => (value.results[0].receipts[0].requestHmac = HMAC)],
    ["client", (value) => (value.results[0].receipts[0].clientHmac = HMAC)],
    ["overflow", (value) => value.results.push(structuredClone(value.results[0]))],
  ];
  for (const [axis, mutate] of adversaries) {
    const fixture = card5WebReleaseFixture();
    mutate(fixture);
    const assessed = assessCard5WebAuthorityRelease({
      ...fixture.expected,
      results: fixture.results,
    });
    assert.equal(assessed.passed, false, axis);
    assert.equal(assessed.observation.axes[axis], true, axis);
    assert.ok(assessed.observation.pages.length <= 2, axis);
    assert.ok(assessed.observation.receipts.length <= 3, axis);
  }
});

test("Web release compound failure remains HMAC-only and keeps the fixed reason", () => {
  const fixture = card5WebReleaseFixture();
  fixture.results[0].status = "binding-invalid";
  fixture.results[0].receipts[0].requestHmac = "raw-private-request";
  fixture.results.push({ status: "raw-private-status", receipts: Array(4).fill({}) });
  const assessed = assessCard5WebAuthorityRelease({
    ...fixture.expected,
    results: fixture.results,
  });
  const observed = boundedCard5TuiFocusFailureObservation({
    reason: "focus-web-release-invalid",
    axes: { authority: true },
    webRelease: assessed.observation,
    rawClientId: "raw-private-client",
  });
  assert.equal(observed.reason, "focus-web-release-invalid");
  assert.equal(observed.webRelease.axes.resultStatus, true);
  assert.equal(observed.webRelease.axes.request, true);
  assert.equal(observed.webRelease.axes.overflow, true);
  assert.equal(JSON.stringify(observed).includes("raw-private"), false);
});

test("focused-pane failure evidence preserves only the fixed HMAC axis vector", () => {
  const input = tuiFocusedPaneFixture();
  input.records[0].semanticPaneId = "pane-private";
  const failed = assessCard5TuiFocusedPane(input);
  const observed = boundedCard5TuiFocusFailureObservation({
    reason: failed.reason,
    axes: failed.axes,
    candidate: failed.candidate,
    rawPane: "pane-private",
  });
  assert.equal(observed.operation, "card5-tui-focused-pane");
  assert.equal(observed.reason, "focus-presentation-mismatch");
  assert.equal(observed.focusDivergenceAxes.pane, true);
  assert.equal(observed.focusCandidates.length, 1);
  assert.equal(JSON.stringify(observed).includes("pane-private"), false);
});

test("replacement evidence requires seed-first G2 and typed retirement with no late G1", () => {
  const lanes = [
    {
      replacementBoundary: {
        predecessorGeneration: "g1",
        replacementGeneration: "g2",
        acceptedOrdinal: 1,
        socketOrdinal: 2,
      },
      predecessorAcceptedAfterReplacement: 0,
      socketEvents: [
        { generation: "g1", outcome: "closed", ordinal: 2 },
        { generation: "g2", outcome: "open", ordinal: 1 },
      ],
      events: [
        { type: "terminal.patch", generation: "g1", acceptedOrdinal: 0 },
        { type: "terminal.seed", generation: "g2", acceptedOrdinal: 1 },
        { type: "terminal.patch", generation: "g2", acceptedOrdinal: 2 },
      ],
    },
    {
      replacementBoundary: {
        predecessorGeneration: "g1",
        replacementGeneration: "g2",
        acceptedOrdinal: 4,
        socketOrdinal: 7,
      },
      predecessorAcceptedAfterReplacement: 0,
      socketEvents: [
        { generation: "g2", outcome: "open", ordinal: 7 },
        { generation: "g1", outcome: "closed", ordinal: 8 },
      ],
      events: [{ type: "terminal.seed", generation: "g2", acceptedOrdinal: 4 }],
    },
    {
      replacementBoundary: {
        predecessorGeneration: "g1",
        replacementGeneration: "g2",
        acceptedOrdinal: 8,
      },
      predecessorAcceptedAfterReplacement: 0,
      events: [{ type: "terminal.seed", generation: "g2", acceptedOrdinal: 8 }],
    },
  ];
  assert.deepEqual(
    assessCard5ReplacementEnvelopeEvidence({
      predecessorGeneration: "g1",
      replacementGeneration: "g2",
      staleRedemptions: [
        { rejected: true, typed: true, reason: "ticket-expired" },
        { rejected: true, typed: true, reason: "redemption-rejected" },
      ],
      lanes,
    }),
    {
      passed: true,
      reason: null,
      staleGenerationError: "generation-replaced",
      replacementFirstEnvelope: "seed",
      replacementSeedGeneration: "g2",
      predecessorEnvelopeAcceptedAfterReplace: false,
    },
  );
  for (const change of [
    {
      lanes: [
        { ...lanes[0], events: [{ type: "terminal.patch", generation: "g2", acceptedOrdinal: 1 }] },
        lanes[1],
        lanes[2],
      ],
    },
    {
      lanes: [{ ...lanes[0], predecessorAcceptedAfterReplacement: 1 }, lanes[1], lanes[2]],
    },
    { staleRedemptions: [{ rejected: true, typed: false, reason: "closed" }] },
  ]) {
    assert.equal(
      assessCard5ReplacementEnvelopeEvidence({
        predecessorGeneration: "g1",
        replacementGeneration: "g2",
        staleRedemptions: [
          { rejected: true, typed: true, reason: "ticket-expired" },
          { rejected: true, typed: true, reason: "redemption-rejected" },
        ],
        lanes,
        ...change,
      }).passed,
      false,
    );
  }
});
