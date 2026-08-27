import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createCard5EnvelopeEvidenceRecorder,
  createCard5GeometryReceiptRecorder,
} from "../../apps/desktop-renderer/src/runtime/card5-envelope-evidence.ts";

import {
  activateCard5ExactTerminalSurface,
  boundedCard5InputGuardAxes,
  boundedCard5InputReceiptAxes,
  boundedCard5InputReceiptStartAxes,
  boundedCard5PointerDispatchAxes,
  card5InputGuardFailureReason,
  card5PointerDispatchFailureReason,
  createCard5ProductionWebHostLease,
  issueCard5PredecessorDescriptor,
  launchCard5ProductionWebHosts,
  observeCard5WebCanonical,
  observeCard5WebAuthorityReceipt,
} from "./product-card5-production-host-owner.mjs";
import { PRODUCT_JOURNEY_REGISTRY } from "../product-test-rig-journeys.mjs";
import { card5AuthorityActivityWithinCap } from "./product-cross-client-host-evidence.mjs";

function pageHarness(events, name) {
  const listeners = new Map();
  let closed = false;
  const session = { send: async (method, value) => events.push([name, method, value]) };
  const sink = {
    blocked: false,
    setBlocked(value) {
      this.blocked = value;
    },
    snapshot() {
      return { blocked: this.blocked };
    },
  };
  const qualifiedSurfaceHandle = {
    getAttribute: (attribute) =>
      attribute === "data-workspace-name"
        ? "workspace-b"
        : attribute === "data-semantic-pane-id"
          ? "pane-b"
          : attribute === "data-phase"
            ? "connected"
            : attribute === "data-preserves-frame"
              ? "true"
              : null,
    get isConnected() {
      return true;
    },
    get ownerDocument() {
      return globalThis.document;
    },
    dispose: async () => events.push([name, "qualified-surface-disposed"]),
  };
  return {
    on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    emit: (event, value) => {
      for (const listener of listeners.get(event) ?? []) listener(value);
    },
    isClosed: () => closed,
    markClosed: () => {
      closed = true;
      for (const listener of listeners.get("close") ?? []) listener();
    },
    addInitScript: async () => events.push([name, "init"]),
    goto: async (url) => events.push([name, "goto", url]),
    reload: async () => events.push([name, "reload"]),
    locator: () => ({
      waitFor: async () => events.push([name, "ready"]),
      first: () => ({ waitFor: async () => events.push([name, "ready"]) }),
    }),
    waitForFunction: async (_callback, _value, options) =>
      events.push([name, options?.timeout === 60_000 ? "terminal-ready" : "hidden"]),
    evaluateHandle: async () => qualifiedSurfaceHandle,
    evaluate: async (callback, value) => {
      if (
        value?.exactSurface === qualifiedSurfaceHandle &&
        /^[0-9a-f]{64}$/u.test(value.exactKey)
      ) {
        const previousResolver = globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__;
        globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__ = () => qualifiedSurfaceHandle;
        try {
          return await callback(value);
        } finally {
          globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__ = previousResolver;
        }
      }
      globalThis.__TMUX_IDE_CARD5_SINK_CONTROL__ = sink;
      try {
        return await callback(value);
      } finally {
        delete globalThis.__TMUX_IDE_CARD5_SINK_CONTROL__;
      }
    },
    qualifiedSurfaceHandle,
    context: () => ({ newCDPSession: async () => session }),
  };
}

test("input guard diagnostics classify every strict conjunct in acceptance order", () => {
  const passingOutcome = {
    beforeInputCount: 1,
    inputCount: 1,
    eventCount: 2,
    eventOverflow: false,
    mutationCount: 0,
    mutationOverflow: false,
    trusted: true,
    exactTarget: true,
    exactData: true,
    exactInputType: true,
    cancelableBeforeInput: true,
    restorationExact: true,
    rejected: false,
    exact: true,
  };
  const axes = boundedCard5InputGuardAxes(passingOutcome, {
    deadlineValid: true,
    settled: true,
  });
  assert.deepEqual(Object.keys(axes), [
    "beforeInputCount",
    "beforeInputCountOverflow",
    "inputCount",
    "inputCountOverflow",
    "eventCount",
    "eventCountOverflow",
    "eventOverflow",
    "mutationCount",
    "mutationCountOverflow",
    "mutationOverflow",
    "trusted",
    "exactTarget",
    "exactData",
    "exactInputType",
    "cancelableBeforeInput",
    "restorationExact",
    "rejected",
    "currentExact",
    "deadlineValid",
    "settled",
  ]);
  assert.equal(card5InputGuardFailureReason(axes), null);

  for (const [field, value, reason] of [
    ["inputCount", 0, "input-count-invalid"],
    ["beforeInputCount", 0, "beforeinput-count-invalid"],
    ["eventCount", 3, "event-count-invalid"],
    ["eventOverflow", true, "event-overflow"],
    ["mutationCount", 1, "mutation-count-invalid"],
    ["mutationOverflow", true, "mutation-overflow"],
    ["trusted", false, "event-untrusted"],
    ["exactTarget", false, "event-target-invalid"],
    ["exactData", false, "event-data-invalid"],
    ["exactInputType", false, "event-input-type-invalid"],
    ["cancelableBeforeInput", false, "beforeinput-not-cancelable"],
    ["restorationExact", false, "restoration-invalid"],
    ["rejected", true, "guard-rejected"],
    ["exact", false, "guard-current-invalid"],
  ]) {
    const observed = boundedCard5InputGuardAxes(
      { ...passingOutcome, [field]: value },
      { deadlineValid: true, settled: true },
    );
    assert.equal(card5InputGuardFailureReason(observed), reason, field);
  }

  const prioritized = boundedCard5InputGuardAxes({
    ...passingOutcome,
    inputCount: 0,
    mutationCount: 1,
    rejected: true,
  });
  assert.equal(card5InputGuardFailureReason(prioritized), "input-count-invalid");
  const capped = boundedCard5InputGuardAxes({
    ...passingOutcome,
    beforeInputCount: 9,
    inputCount: 9,
    eventCount: 17,
    mutationCount: 65,
  });
  assert.deepEqual(
    {
      beforeInputCount: capped.beforeInputCount,
      beforeInputCountOverflow: capped.beforeInputCountOverflow,
      inputCount: capped.inputCount,
      inputCountOverflow: capped.inputCountOverflow,
      eventCount: capped.eventCount,
      eventCountOverflow: capped.eventCountOverflow,
      mutationCount: capped.mutationCount,
      mutationCountOverflow: capped.mutationCountOverflow,
    },
    {
      beforeInputCount: 8,
      beforeInputCountOverflow: true,
      inputCount: 8,
      inputCountOverflow: true,
      eventCount: 16,
      eventCountOverflow: true,
      mutationCount: 64,
      mutationCountOverflow: true,
    },
  );
  assert.equal(
    boundedCard5InputGuardAxes({ ...passingOutcome, inputCount: Number.NaN }).inputCount,
    null,
  );
});

test("pointer dispatch diagnostics are fixed, bounded, raw-free, and prioritized", () => {
  const passing = {
    dispatched: true,
    trusted: true,
    buttonExact: true,
    pathExact: true,
    allowed: true,
    rejected: false,
    eventCount: 1,
    eventOverflow: false,
    mutationCount: 0,
    mutationOverflow: false,
    mutationCategories: {
      identityNode: 0,
      areaDescendant: 0,
      terminalAttribute: 0,
      paneAttribute: 0,
      childList: 0,
      inspectionOverflow: 0,
    },
    mutationTail: [],
    current: {
      areaConnected: true,
      surfaceConnected: true,
      targetConnected: true,
      surfaceAreaExact: true,
      targetAreaExact: true,
      surfaceCardinalityExact: true,
      compositorExact: true,
      topologyExact: true,
    },
  };
  const axes = boundedCard5PointerDispatchAxes(passing);
  assert.deepEqual(Object.keys(axes), [
    "dispatched",
    "trusted",
    "buttonExact",
    "pathExact",
    "allowed",
    "rejected",
    "eventCount",
    "eventOverflow",
    "mutationCount",
    "mutationOverflow",
    "mutationCategories",
    "mutationTail",
    "current",
  ]);
  assert.equal(card5PointerDispatchFailureReason(axes), null);
  for (const [path, value, reason] of [
    ["dispatched", false, "pointer-not-dispatched"],
    ["trusted", false, "pointer-untrusted"],
    ["buttonExact", false, "pointer-button-invalid"],
    ["pathExact", false, "pointer-path-invalid"],
    ["eventOverflow", true, "pointer-event-overflow"],
    ["mutationOverflow", true, "pointer-mutation-overflow"],
    ["mutationCount", 1, "pointer-mutation-detected"],
    ["current.areaConnected", false, "pointer-area-disconnected"],
    ["current.surfaceConnected", false, "pointer-surface-disconnected"],
    ["current.targetConnected", false, "pointer-target-disconnected"],
    ["current.surfaceAreaExact", false, "pointer-surface-area-changed"],
    ["current.targetAreaExact", false, "pointer-target-area-changed"],
    ["current.surfaceCardinalityExact", false, "pointer-surface-cardinality-changed"],
    ["current.compositorExact", false, "pointer-compositor-changed"],
    ["current.topologyExact", false, "pointer-topology-changed"],
    ["allowed", false, "pointer-not-allowed"],
    ["rejected", true, "pointer-rejected"],
  ]) {
    const changed = path.startsWith("current.")
      ? { ...passing, current: { ...passing.current, [path.slice(8)]: value } }
      : { ...passing, [path]: value };
    assert.equal(
      card5PointerDispatchFailureReason(boundedCard5PointerDispatchAxes(changed)),
      reason,
    );
  }
  const capped = boundedCard5PointerDispatchAxes({
    ...passing,
    eventCount: 9,
    mutationCount: 65,
    mutationCategories: Object.fromEntries(
      Object.keys(passing.mutationCategories).map((key) => [key, 65]),
    ),
    mutationTail: [
      { type: "childList", attribute: null, relevanceHmac: "a".repeat(64) },
      { type: "attributes", attribute: "data-pane", relevanceHmac: "b".repeat(64) },
      { type: "raw-private", attribute: "x".repeat(33), relevanceHmac: "raw" },
    ],
  });
  assert.equal(capped.eventCount, 8);
  assert.equal(capped.mutationCount, 64);
  assert.deepEqual(Object.values(capped.mutationCategories), [64, 64, 64, 64, 64, 64]);
  assert.deepEqual(capped.mutationTail, [
    { type: "attributes", attribute: "data-pane", relevanceHmac: "b".repeat(64) },
    { type: "invalid", attribute: null, relevanceHmac: null },
  ]);
  const prioritized = boundedCard5PointerDispatchAxes({
    ...passing,
    dispatched: false,
    mutationOverflow: true,
    rejected: true,
  });
  assert.equal(card5PointerDispatchFailureReason(prioritized), "pointer-not-dispatched");
});

test("input receipt waiter start diagnostics are fixed, bounded, and typed", () => {
  const initial = Object.fromEntries(
    [
      "surfaceExact",
      "textareaExact",
      "focusExact",
      "bindingEpochExact",
      "bindingGenerationExact",
      "bindingSessionExact",
      "bindingWorkspaceExact",
      "bindingPaneExact",
      "bindingPaneSetHmacExact",
      "bindingStageExact",
      "bindingClientExact",
      "bindingRequestExact",
      "authorityGenerationExact",
      "authoritySessionExact",
      "clientGenerationExact",
      "targetExact",
      "baselineCountSafe",
      "currentCountSafe",
      "currentCountExact",
      "operationBoundarySafe",
    ].map((field) => [field, true]),
  );
  const axes = boundedCard5InputReceiptStartAxes({
    status: "started",
    settledStatus: "pending",
    fixedDeadlineInstalled: true,
    fixedDeadlineFinite: true,
    browserRemainingMs: 4_250.9,
    reserveMs: 4_250,
    dispatchFresh: true,
    initial,
  });
  assert.deepEqual(Object.keys(axes), [
    "status",
    "settledStatus",
    "fixedDeadlineInstalled",
    "fixedDeadlineFinite",
    "browserRemainingMs",
    "reserveMs",
    "dispatchFresh",
    "initial",
  ]);
  assert.equal(axes.browserRemainingMs, 4_250);
  assert.deepEqual(Object.values(axes.initial), Array(20).fill(true));
  for (const status of [
    "started",
    "initial-invalid",
    "already-started",
    "deadline-invalid",
    "reserve-insufficient",
  ])
    assert.equal(boundedCard5InputReceiptStartAxes({ status, initial }).status, status);
  const invalid = boundedCard5InputReceiptStartAxes({
    status: "private-status",
    settledStatus: "x".repeat(33),
    browserRemainingMs: 10_001,
    reserveMs: Number.NaN,
    initial: { ...initial, focusExact: "yes" },
  });
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.settledStatus, "invalid");
  assert.equal(invalid.browserRemainingMs, 10_000);
  assert.equal(invalid.reserveMs, null);
  assert.equal(invalid.initial.focusExact, null);
});

test("input receipt diagnostics preserve exact long statuses and hash bounded stage identity", () => {
  const axes = boundedCard5InputReceiptAxes(
    {
      status: "input-authority-unobserved-timeout",
      operationCount: 1,
      operationOverflow: false,
      operationTail: [
        {
          ordinal: 7,
          stage: "authority-request",
          outcome: "sent",
          generation: "generation-a",
          lifecycleRequestId: "lifecycle-a",
          authorityRequestId: "authority-a",
          clientId: "client-a",
          pane: "pane-a",
          seq: null,
        },
      ],
    },
    "ab".repeat(32),
  );
  assert.equal(axes.status, "input-authority-unobserved-timeout");
  assert.equal(axes.operationCount, 1);
  assert.equal(axes.operationOverflow, false);
  assert.match(axes.operationTail[0].identityHmac, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(axes).includes("authority-a"), false);
});

function launchInput(overrides = {}) {
  const events = [];
  const chromiumPage = pageHarness(events, "chromium");
  const electronPage = pageHarness(events, "electron");
  const electronProcess = {
    pid: 222,
    exitCode: null,
    signalCode: null,
    kill: () => false,
  };
  const electronApp = {
    process: () => electronProcess,
    firstWindow: async () => electronPage,
    evaluate: async (callback) => {
      const window = {
        hide: () => events.push(["electron", "hide"]),
        show: () => events.push(["electron", "show"]),
      };
      await callback({ BrowserWindow: { getAllWindows: () => [window] } });
    },
    close: async () => {
      electronPage.markClosed();
      events.push(["electron", "close"]);
    },
  };
  const browser = {
    newBrowserCDPSession: async () => ({
      send: async () => ({ processInfo: [{ type: "browser", id: 111 }] }),
    }),
    newContext: async () => ({ newPage: async () => chromiumPage }),
    close: async () => {
      chromiumPage.markClosed();
      events.push(["chromium", "close"]);
    },
  };
  const input = {
    pageUrl: "http://127.0.0.1:4173/",
    runtimeRoot: "/tmp/card5-owner",
    electronUserData: "/tmp/card5-owner/electron",
    daemonInfoPath: "/tmp/card5-owner/daemon/daemon.json",
    daemonInfoDir: "/tmp/card5-owner/daemon",
    registryDir: "/tmp/card5-owner/registry",
    settingsDir: "/tmp/card5-owner/settings",
    cleanupToken: "product-test-rig:card5",
    evidenceKey: "ab".repeat(32),
    electronEntry: "/repo/apps/electron-shell/dist/main.cjs",
    repoRoot: "/repo",
    environment: { PATH: "/bin", TMUX_IDE_RIG_OWNER_TOKEN: "must-not-cross" },
    chromium: { launch: async () => browser },
    electron: {
      launch: async (options) => {
        events.push(["electron", "launch", options]);
        return electronApp;
      },
    },
    ...overrides,
  };
  return { input, events, browser, electronApp, electronProcess, chromiumPage, electronPage };
}

test("launches Chromium and the production Electron main/preload broker with owned paths", async () => {
  const { input, events } = launchInput();
  const owner = await launchCard5ProductionWebHosts(input);
  assert.equal(owner.chromiumProcessIdentity, "chromium:111");
  assert.equal(owner.electronProcessIdentity, "electron:222");
  const launch = events.find(
    ([host, operation]) => host === "electron" && operation === "launch",
  )[2];
  assert.deepEqual(launch.args, [
    "/repo/apps/electron-shell/dist/main.cjs",
    "--user-data-dir=/tmp/card5-owner/electron",
  ]);
  assert.equal(
    launch.env.TMUX_IDE_RENDERER_URL,
    "http://127.0.0.1:4173/?performanceHud=1&tmuxIdeResourceTelemetry=1&tmuxIdeCard5Evidence=1",
  );
  assert.equal(
    events.some(([, operation]) => operation === "reload"),
    false,
  );
  assert.equal(
    events.filter(([host, operation]) => host === "electron" && operation === "ready").length,
    1,
  );
  assert.equal(
    events.filter(([host, operation]) => host === "electron" && operation === "terminal-ready")
      .length,
    1,
  );
  assert.equal(launch.env.TMUX_IDE_DAEMON_INFO_DIR, "/tmp/card5-owner/daemon");
  assert.equal("TMUX_IDE_OWNER_TOKEN" in launch.env, false);
  assert.equal("TMUX_IDE_CAPABILITY" in launch.env, false);
  assert.equal("TMUX_IDE_RIG_OWNER_TOKEN" in launch.env, false);
  const slow = await owner.setElectronSlowHidden(4);
  assert.equal(slow.hidden, true);
  assert.deepEqual(await owner.setElectronSinkBlocked(true), { blocked: true });
  assert.deepEqual(await owner.observeElectronSink(), { blocked: true });
  await owner.restoreElectron(slow);
  const receipt = await owner.close();
  assert.equal(receipt.chromiumReason, "graceful-retirement");
  assert.equal(receipt.electronReason, "graceful-retirement");
  await owner.close();
  assert.equal(
    events.filter(([host, operation]) => host === "electron" && operation === "close").length,
    1,
  );
  assert.equal(
    events.filter(([host, operation]) => host === "chromium" && operation === "close").length,
    1,
  );
});

test("canonical capture stays bound to the exact terminal qualified at readiness", async () => {
  const daemonGeneration = "550e8400-e29b-41d4-a716-446655440000";
  const harness = launchInput();
  const owner = await launchCard5ProductionWebHosts(harness.input);
  const exactSurface = harness.electronPage.qualifiedSurfaceHandle;
  const replacementSurface = {
    ...exactSurface,
    getAttribute: exactSurface.getAttribute,
  };
  let qualifiedSurface = exactSurface;
  let replaceDuringProbe = false;
  let restoreDuringProbe = false;
  let queuedMutationsDuringProbe = 0;
  let probeSurface = exactSurface;
  let probeGeneration = daemonGeneration;
  let activeMutationObserver = null;
  let replacePhysicalBindingAfterRead = null;
  let replacementPhysicalBinding = undefined;
  let envelopeReadCount = 0;
  let documentVisibility = "visible";
  let activeLifecycleRequests = [
    {
      physicalEpoch: 1,
      generation: daemonGeneration,
      requestId: "private-active-request",
      firstSeedOrdinal: 4,
      workspaceName: "workspace-b",
      semanticPaneIds: ["pane-b"],
    },
  ];
  let descriptorEvents = [
    {
      physicalEpoch: 1,
      generation: daemonGeneration,
      requestId: "private-active-request",
      socketUrl: "ws://127.0.0.1/private-socket",
    },
    {
      physicalEpoch: 2,
      generation: daemonGeneration,
      requestId: "private-unused-candidate",
      socketUrl: "ws://127.0.0.1/private-unused",
    },
  ];
  let clientSnapshotGeneration = 7;
  let authorityDaemonGeneration = daemonGeneration;
  let targetDaemonGeneration = daemonGeneration;
  let workspaceReadCount = 0;
  let replaceClientGenerationAfterRead = null;
  const exactPhysicalBinding = {
    physicalEpoch: 1,
    generation: daemonGeneration,
    requestId: "private-active-request",
    runtimeSession: "runtime-a",
    workspaceName: "workspace-b",
    semanticPaneIds: ["pane-b"],
    clientId: "web-client-a",
    stage: "first-seed",
  };
  let currentPhysicalBinding = exactPhysicalBinding;
  globalThis.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
  createCard5EnvelopeEvidenceRecorder();
  createCard5GeometryReceiptRecorder()?.({
    generation: daemonGeneration,
    pane: "pane-b",
    cols: 140,
    rows: 46,
    requestId: "private-geometry-request",
    authorityClientId: "private-geometry-client",
  });
  const recordedEnvelopeEvidence = globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__;
  harness.electronPage.evaluate = async (callback, value) => {
    assert.match(value.expectedIdentity.workspaceHmac, /^[0-9a-f]{64}$/u);
    assert.match(value.expectedIdentity.paneHmac, /^[0-9a-f]{64}$/u);
    assert.equal(value.expectedSurface, exactSurface);
    const previous = {
      document: globalThis.document,
      resolver: globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__,
      probe: globalThis.__TMUX_IDE_PROBE_TERMINAL_RENDITION__,
      envelope: globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__,
      workspace: globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__,
      activity: globalThis.__TMUX_IDE_CARD5_AUTHORITY_ACTIVITY_EVIDENCE__,
      MutationObserver: globalThis.MutationObserver,
      Element: globalThis.Element,
      CSS: globalThis.CSS,
    };
    class ElementStub {
      contains(node) {
        return node === this;
      }
      matches() {
        return this === exactSurface || this === replacementSurface;
      }
      querySelector() {
        return null;
      }
    }
    Object.setPrototypeOf(exactSurface, ElementStub.prototype);
    Object.setPrototypeOf(replacementSurface, ElementStub.prototype);
    globalThis.Element = ElementStub;
    globalThis.CSS = { escape: (text) => String(text) };
    globalThis.MutationObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.records = [];
        activeMutationObserver = this;
      }
      observe() {}
      takeRecords() {
        return this.records.splice(0);
      }
      disconnect() {
        if (activeMutationObserver === this) activeMutationObserver = null;
      }
      deliver(records) {
        this.callback(records);
      }
    };
    globalThis.document = {
      visibilityState: documentVisibility,
      defaultView: globalThis,
      documentElement: {},
      querySelectorAll: () => [],
    };
    globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__ = (mode = "readiness") =>
      documentVisibility === "hidden" && mode === "readiness" ? null : qualifiedSurface;
    globalThis.__TMUX_IDE_PROBE_TERMINAL_RENDITION__ = async (paneId) => {
      if (replaceDuringProbe) {
        qualifiedSurface = replacementSurface;
        activeMutationObserver?.deliver([
          {
            type: "childList",
            target: globalThis.document.documentElement,
            addedNodes: [replacementSurface],
            removedNodes: [exactSurface],
          },
        ]);
        if (restoreDuringProbe) {
          qualifiedSurface = exactSurface;
          activeMutationObserver?.deliver([
            {
              type: "childList",
              target: globalThis.document.documentElement,
              addedNodes: [exactSurface],
              removedNodes: [replacementSurface],
            },
          ]);
        }
      }
      if (queuedMutationsDuringProbe > 0) {
        activeMutationObserver?.records.push(
          ...Array.from({ length: queuedMutationsDuringProbe }, (_, index) => ({
            type: "childList",
            target: globalThis.document.documentElement,
            addedNodes: [index % 2 === 0 ? replacementSurface : exactSurface],
            removedNodes: [index % 2 === 0 ? exactSurface : replacementSurface],
          })),
        );
      }
      return {
        surface: probeSurface,
        canonical: {
          incarnation: "incarnation-b",
          generation: probeGeneration,
          revision: 2,
          cols: 160,
          rows: 44,
          stateHash: "44".repeat(32),
        },
        rendition: { renditionHmac: paneId === "pane-b" ? "33".repeat(32) : null },
      };
    };
    const baseEnvelope = recordedEnvelopeEvidence();
    envelopeReadCount = 0;
    workspaceReadCount = 0;
    globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ = () => {
      envelopeReadCount += 1;
      const binding =
        replacePhysicalBindingAfterRead !== null &&
        envelopeReadCount >= replacePhysicalBindingAfterRead
          ? replacementPhysicalBinding === undefined
            ? { ...currentPhysicalBinding, generation: "g-foreign" }
            : replacementPhysicalBinding
          : currentPhysicalBinding;
      return {
        ...baseEnvelope,
        acceptedCount: 1,
        ackSentCount: 1,
        activeLifecycleRequests,
        activeLifecycleRequestOverflowGenerations: [],
        currentPhysicalBinding: binding,
        descriptorEvents,
        descriptorEventCount: descriptorEvents.length,
        events: [],
        replacementCount: 0,
        replacementBoundary: null,
        predecessorAcceptedAfterReplacement: 0,
        socketEvents: [],
        socketEventCount: 0,
        ackEvents: [],
        inputReceipts: [],
        inputReceiptCount: 0,
        geometryReceipts: baseEnvelope.geometryReceipts,
        geometryReceiptCount: baseEnvelope.geometryReceiptCount,
      };
    };
    globalThis.__TMUX_IDE_CARD5_AUTHORITY_ACTIVITY_EVIDENCE__ = () => ({
      count: 2,
      overflow: false,
      events: [
        {
          ordinal: 1,
          surface: "web",
          kind: "geometry",
          outcome: "attempt",
          operationOrdinal: 1,
          cols: 140,
          rows: 46,
        },
        {
          ordinal: 2,
          surface: "web",
          kind: "geometry",
          outcome: "ok",
          operationOrdinal: 1,
          cols: 140,
          rows: 46,
        },
      ],
    });
    globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__ = () => {
      workspaceReadCount += 1;
      return {
        snapshot: {
          generation:
            replaceClientGenerationAfterRead !== null &&
            workspaceReadCount >= replaceClientGenerationAfterRead
              ? clientSnapshotGeneration + 1
              : clientSnapshotGeneration,
          phase: "live",
          target:
            targetDaemonGeneration === null
              ? null
              : { daemon: { instanceId: targetDaemonGeneration }, workspaceName: "workspace-b" },
          authority: {
            generation: authorityDaemonGeneration,
            session: "runtime-a",
            clients: [{ clientId: "web-client-a", surface: "web" }],
          },
          operations: [],
        },
        authorityRecords: [],
        authorityRecordCount: 0,
      };
    };
    try {
      return await callback(value);
    } finally {
      globalThis.document = previous.document;
      globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__ = previous.resolver;
      globalThis.__TMUX_IDE_PROBE_TERMINAL_RENDITION__ = previous.probe;
      globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ = previous.envelope;
      globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__ = previous.workspace;
      globalThis.__TMUX_IDE_CARD5_AUTHORITY_ACTIVITY_EVIDENCE__ = previous.activity;
      globalThis.MutationObserver = previous.MutationObserver;
      globalThis.Element = previous.Element;
      globalThis.CSS = previous.CSS;
    }
  };
  const stable = await observeCard5WebCanonical(
    harness.electronPage,
    harness.input.evidenceKey,
    owner.electronProcessIdentity,
  );
  const stableEnvelopeReadCount = envelopeReadCount;
  assert.ok(stableEnvelopeReadCount > 4);
  assert.equal(stable?.semanticPaneId, "pane-b");
  assert.deepEqual(stable?.surfaceProbeIdentity, {
    qualifiedSurfaceExact: true,
    probeSurfaceExact: true,
    connected: true,
    documentExact: true,
    workspaceExact: true,
    paneExact: true,
    phaseExact: true,
    framePreserved: true,
    mutationCount: 0,
    mutationOverflow: false,
    physicalBindingStable: true,
    workspaceSnapshotStable: true,
    workspaceHmac: stable.surfaceProbeIdentity.workspaceHmac,
    paneHmac: stable.surfaceProbeIdentity.paneHmac,
  });
  assert.match(stable.surfaceProbeIdentity.workspaceHmac, /^[0-9a-f]{64}$/u);
  assert.match(stable.surfaceProbeIdentity.paneHmac, /^[0-9a-f]{64}$/u);
  const lightweightExact = await observeCard5WebAuthorityReceipt(
    harness.electronPage,
    harness.input.evidenceKey,
    owner.electronProcessIdentity,
  );
  assert.equal(lightweightExact?.semanticPaneId, "pane-b");
  assert.equal(stable?.workspaceEvidence?.generation, 7);
  assert.equal(lightweightExact?.generation, daemonGeneration);
  assert.deepEqual(
    {
      status: lightweightExact?.runtimeReplacement?.currentLifecycleRequest?.status,
      requestHmac: "<hmac>",
      activeCount: lightweightExact?.runtimeReplacement?.currentLifecycleRequest?.activeCount,
      descriptorCount:
        lightweightExact?.runtimeReplacement?.currentLifecycleRequest?.descriptorCount,
      overflow: lightweightExact?.runtimeReplacement?.currentLifecycleRequest?.overflow,
      physicalBindingExact:
        lightweightExact?.runtimeReplacement?.currentLifecycleRequest?.physicalBindingExact,
      physicalEpochHmacValid: /^[0-9a-f]{64}$/u.test(
        lightweightExact?.runtimeReplacement?.currentLifecycleRequest?.physicalEpochHmac ?? "",
      ),
    },
    {
      status: "exact",
      requestHmac: "<hmac>",
      activeCount: 1,
      descriptorCount: 1,
      overflow: false,
      physicalBindingExact: true,
      physicalEpochHmacValid: true,
    },
  );
  for (const observed of [stable, lightweightExact]) {
    const lifecycle = observed.runtimeReplacement.currentLifecycleRequest;
    assert.deepEqual(lifecycle.physicalBindingAxes, {
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
    });
    assert.equal(lifecycle.bindingRequestHmac, lifecycle.requestHmac);
    assert.match(lifecycle.bindingClientHmac, /^[0-9a-f]{64}$/u);
    assert.equal(lifecycle.activeTail.length, 1);
    assert.deepEqual(Object.keys(lifecycle.activeTail[0]).sort(), [
      "epochHmac",
      "generationHmac",
      "ordinal",
      "paneSetHmac",
      "requestHmac",
      "workspaceHmac",
    ]);
    assert.doesNotMatch(JSON.stringify(lifecycle), /private-active-request|workspace-b|pane-b/u);
  }
  for (const malformedGeneration of [
    "g1",
    "a".repeat(129),
    "550e8400-e29b-01d4-a716-446655440000",
    "550e8400-e29b-41d4-7716-446655440000",
  ]) {
    probeGeneration = malformedGeneration;
    authorityDaemonGeneration = malformedGeneration;
    targetDaemonGeneration = malformedGeneration;
    currentPhysicalBinding = { ...exactPhysicalBinding, generation: malformedGeneration };
    activeLifecycleRequests = activeLifecycleRequests.map((request) => ({
      ...request,
      generation: malformedGeneration,
    }));
    descriptorEvents = descriptorEvents.map((descriptor) => ({
      ...descriptor,
      generation: malformedGeneration,
    }));
    const malformedCanonical = await observeCard5WebCanonical(
      harness.electronPage,
      harness.input.evidenceKey,
      owner.electronProcessIdentity,
    );
    const malformedLightweight = await observeCard5WebAuthorityReceipt(
      harness.electronPage,
      harness.input.evidenceKey,
      owner.electronProcessIdentity,
    );
    assert.equal(
      malformedCanonical?.runtimeReplacement?.currentLifecycleRequest?.physicalBindingExact,
      false,
    );
    assert.equal(malformedLightweight?.generation, null);
    assert.equal(
      malformedLightweight?.runtimeReplacement?.currentLifecycleRequest?.physicalBindingExact,
      false,
    );
  }
  probeGeneration = daemonGeneration;
  authorityDaemonGeneration = daemonGeneration;
  targetDaemonGeneration = daemonGeneration;
  currentPhysicalBinding = exactPhysicalBinding;
  activeLifecycleRequests = activeLifecycleRequests.map((request) => ({
    ...request,
    generation: daemonGeneration,
  }));
  descriptorEvents = descriptorEvents.map((descriptor) => ({
    ...descriptor,
    generation: daemonGeneration,
  }));
  const uppercaseGeneration = daemonGeneration.toUpperCase();
  probeGeneration = uppercaseGeneration;
  authorityDaemonGeneration = uppercaseGeneration;
  targetDaemonGeneration = uppercaseGeneration;
  currentPhysicalBinding = { ...exactPhysicalBinding, generation: uppercaseGeneration };
  activeLifecycleRequests = activeLifecycleRequests.map((request) => ({
    ...request,
    generation: uppercaseGeneration,
  }));
  descriptorEvents = descriptorEvents.map((descriptor) => ({
    ...descriptor,
    generation: uppercaseGeneration,
  }));
  assert.equal(
    (
      await observeCard5WebAuthorityReceipt(
        harness.electronPage,
        harness.input.evidenceKey,
        owner.electronProcessIdentity,
      )
    )?.generation,
    uppercaseGeneration,
  );
  probeGeneration = daemonGeneration;
  authorityDaemonGeneration = daemonGeneration;
  targetDaemonGeneration = daemonGeneration;
  currentPhysicalBinding = exactPhysicalBinding;
  activeLifecycleRequests = activeLifecycleRequests.map((request) => ({
    ...request,
    generation: daemonGeneration,
  }));
  descriptorEvents = descriptorEvents.map((descriptor) => ({
    ...descriptor,
    generation: daemonGeneration,
  }));
  for (const [authorityGeneration, targetGeneration] of [
    ["", daemonGeneration],
    [daemonGeneration, null],
    [daemonGeneration, "g-foreign"],
  ]) {
    authorityDaemonGeneration = authorityGeneration;
    targetDaemonGeneration = targetGeneration;
    for (const observe of [observeCard5WebCanonical, observeCard5WebAuthorityReceipt]) {
      const rejected = await observe(
        harness.electronPage,
        harness.input.evidenceKey,
        owner.electronProcessIdentity,
      );
      assert.equal(
        rejected?.runtimeReplacement?.currentLifecycleRequest?.physicalBindingExact,
        false,
      );
      assert.equal(
        rejected?.runtimeReplacement?.currentLifecycleRequest?.physicalBindingAxes?.generationExact,
        false,
      );
    }
  }
  authorityDaemonGeneration = daemonGeneration;
  targetDaemonGeneration = daemonGeneration;
  activeLifecycleRequests = activeLifecycleRequests.map((request) => ({
    ...request,
    generation: "g-foreign",
  }));
  for (const observe of [observeCard5WebCanonical, observeCard5WebAuthorityReceipt]) {
    const rejected = await observe(
      harness.electronPage,
      harness.input.evidenceKey,
      owner.electronProcessIdentity,
    );
    assert.equal(rejected?.runtimeReplacement?.currentLifecycleRequest?.status, "missing");
    assert.equal(rejected?.runtimeReplacement?.currentLifecycleRequest?.rawActiveCount, 0);
  }
  activeLifecycleRequests = activeLifecycleRequests.map((request) => ({
    ...request,
    generation: daemonGeneration,
  }));
  descriptorEvents = descriptorEvents.map((descriptor) => ({
    ...descriptor,
    generation: "g-foreign",
  }));
  for (const observe of [observeCard5WebCanonical, observeCard5WebAuthorityReceipt]) {
    const rejected = await observe(
      harness.electronPage,
      harness.input.evidenceKey,
      owner.electronProcessIdentity,
    );
    assert.equal(rejected?.runtimeReplacement?.currentLifecycleRequest?.status, "exact");
    assert.equal(rejected?.runtimeReplacement?.currentLifecycleRequest?.descriptorCount, 0);
  }
  descriptorEvents = descriptorEvents.map((descriptor) => ({
    ...descriptor,
    generation: daemonGeneration,
  }));
  replaceClientGenerationAfterRead = 2;
  await assert.rejects(
    observeCard5WebCanonical(
      harness.electronPage,
      harness.input.evidenceKey,
      owner.electronProcessIdentity,
    ),
    (error) =>
      error.observation?.reason === "surface-probe-identity-invalid" &&
      error.observation.surfaceProbeIdentity?.workspaceSnapshotStable === false,
    "numeric WorkspaceClient generation churn must invalidate one canonical observation",
  );
  replaceClientGenerationAfterRead = null;
  for (const mismatchedBinding of [
    { ...exactPhysicalBinding, requestId: "private-spliced-request" },
    { ...exactPhysicalBinding, physicalEpoch: 2 },
    { ...exactPhysicalBinding, runtimeSession: "runtime-foreign" },
    { ...exactPhysicalBinding, workspaceName: "workspace-foreign" },
    { ...exactPhysicalBinding, semanticPaneIds: ["pane-foreign"] },
    { ...exactPhysicalBinding, clientId: "web-client-foreign" },
  ]) {
    currentPhysicalBinding = mismatchedBinding;
    for (const observe of [observeCard5WebCanonical, observeCard5WebAuthorityReceipt]) {
      const rejected = await observe(
        harness.electronPage,
        harness.input.evidenceKey,
        owner.electronProcessIdentity,
      );
      assert.equal(rejected?.runtimeReplacement?.currentLifecycleRequest?.status, "missing");
    }
  }
  currentPhysicalBinding = exactPhysicalBinding;
  activeLifecycleRequests = [];
  const lightweightMissing = await observeCard5WebAuthorityReceipt(
    harness.electronPage,
    harness.input.evidenceKey,
    owner.electronProcessIdentity,
  );
  assert.deepEqual(
    {
      status: lightweightMissing?.runtimeReplacement?.currentLifecycleRequest?.status,
      requestHmac: lightweightMissing?.runtimeReplacement?.currentLifecycleRequest?.requestHmac,
      activeCount: lightweightMissing?.runtimeReplacement?.currentLifecycleRequest?.activeCount,
      descriptorCount:
        lightweightMissing?.runtimeReplacement?.currentLifecycleRequest?.descriptorCount,
      overflow: lightweightMissing?.runtimeReplacement?.currentLifecycleRequest?.overflow,
    },
    {
      status: "missing",
      requestHmac: null,
      activeCount: 0,
      descriptorCount: 0,
      overflow: false,
    },
  );
  activeLifecycleRequests = [
    {
      physicalEpoch: 1,
      generation: daemonGeneration,
      requestId: "private-active-request",
      firstSeedOrdinal: 4,
      workspaceName: "workspace-b",
      semanticPaneIds: ["pane-b"],
    },
  ];
  descriptorEvents = [descriptorEvents[0], { ...descriptorEvents[0] }];
  const lightweightDuplicateDescriptor = await observeCard5WebAuthorityReceipt(
    harness.electronPage,
    harness.input.evidenceKey,
    owner.electronProcessIdentity,
  );
  assert.equal(
    lightweightDuplicateDescriptor?.runtimeReplacement?.currentLifecycleRequest.descriptorCount,
    2,
  );
  descriptorEvents = [];
  const lightweightRetainedRingLoss = await observeCard5WebAuthorityReceipt(
    harness.electronPage,
    harness.input.evidenceKey,
    owner.electronProcessIdentity,
  );
  assert.deepEqual(
    {
      status: lightweightRetainedRingLoss?.runtimeReplacement?.currentLifecycleRequest?.status,
      requestHmac: "<hmac>",
      activeCount:
        lightweightRetainedRingLoss?.runtimeReplacement?.currentLifecycleRequest?.activeCount,
      descriptorCount:
        lightweightRetainedRingLoss?.runtimeReplacement?.currentLifecycleRequest?.descriptorCount,
      overflow: lightweightRetainedRingLoss?.runtimeReplacement?.currentLifecycleRequest?.overflow,
    },
    {
      status: "exact",
      requestHmac: "<hmac>",
      activeCount: 1,
      descriptorCount: 0,
      overflow: false,
    },
    "an active request whose descriptor fell out of the retained ring must remain distinguishable",
  );
  descriptorEvents = [
    {
      generation: daemonGeneration,
      requestId: "private-active-request",
      socketUrl: "ws://127.0.0.1/private-socket",
    },
  ];
  assert.equal(
    card5AuthorityActivityWithinCap(stable?.workspaceEvidence?.authorityActivity),
    true,
    "the real zero-based receipt recorder must survive owner projection and exact validation",
  );
  assert.equal(stable.workspaceEvidence.authorityActivity.geometrySettlements[0].ordinal, 0);
  assert.deepEqual(
    {
      status: stable?.runtimeReplacement?.currentLifecycleRequest?.status,
      requestHmac: "<hmac>",
      socketHmac: "<hmac>",
      activeCount: stable?.runtimeReplacement?.currentLifecycleRequest?.activeCount,
      overflow: stable?.runtimeReplacement?.currentLifecycleRequest?.overflow,
      descriptorCount: stable?.runtimeReplacement?.currentLifecycleRequest?.descriptorCount,
      firstSeedOrdinal: stable?.runtimeReplacement?.currentLifecycleRequest?.firstSeedOrdinal,
    },
    {
      status: "exact",
      requestHmac: "<hmac>",
      socketHmac: "<hmac>",
      activeCount: 1,
      overflow: false,
      descriptorCount: 1,
      firstSeedOrdinal: 4,
    },
  );
  assert.match(stable.runtimeReplacement.currentLifecycleRequest.requestHmac, /^[0-9a-f]{64}$/u);
  assert.match(stable.runtimeReplacement.currentLifecycleRequest.socketHmac, /^[0-9a-f]{64}$/u);
  assert.match(
    stable.runtimeReplacement.currentLifecycleRequest.deliveryClientHmac,
    /^[0-9a-f]{64}$/u,
  );
  assert.doesNotMatch(
    JSON.stringify(stable.runtimeReplacement.currentLifecycleRequest),
    /private-/u,
  );
  activeLifecycleRequests = [
    ...activeLifecycleRequests,
    {
      physicalEpoch: 1,
      generation: daemonGeneration,
      requestId: "private-second-active",
      firstSeedOrdinal: 9,
      workspaceName: "workspace-b",
      semanticPaneIds: ["pane-b"],
    },
  ];
  assert.equal(
    (
      await observeCard5WebCanonical(
        harness.electronPage,
        harness.input.evidenceKey,
        owner.electronProcessIdentity,
      )
    )?.runtimeReplacement?.currentLifecycleRequest?.status,
    "ambiguous",
  );
  activeLifecycleRequests = [];
  assert.equal(
    (
      await observeCard5WebCanonical(
        harness.electronPage,
        harness.input.evidenceKey,
        owner.electronProcessIdentity,
      )
    )?.runtimeReplacement?.currentLifecycleRequest?.status,
    "missing",
  );
  activeLifecycleRequests = [
    {
      generation: daemonGeneration,
      requestId: "private-other-pane",
      firstSeedOrdinal: 10,
      workspaceName: "workspace-b",
      semanticPaneIds: ["pane-other"],
    },
  ];
  assert.equal(
    (
      await observeCard5WebCanonical(
        harness.electronPage,
        harness.input.evidenceKey,
        owner.electronProcessIdentity,
      )
    )?.runtimeReplacement?.currentLifecycleRequest?.status,
    "missing",
    "an activated request for another pane cannot bind the qualified surface",
  );
  activeLifecycleRequests = [
    {
      generation: daemonGeneration,
      requestId: "private-active-request",
      firstSeedOrdinal: 4,
      workspaceName: "workspace-b",
      semanticPaneIds: ["pane-b"],
    },
  ];
  qualifiedSurface = replacementSurface;
  await assert.rejects(
    observeCard5WebCanonical(
      harness.electronPage,
      harness.input.evidenceKey,
      owner.electronProcessIdentity,
    ),
    (error) =>
      error.observation?.reason === "surface-probe-identity-invalid" &&
      JSON.stringify(Object.keys(error.observation.surfaceProbeIdentity).sort()) ===
        JSON.stringify(
          [
            "connected",
            "documentExact",
            "framePreserved",
            "mutationCount",
            "mutationOverflow",
            "paneExact",
            "paneHmac",
            "phaseExact",
            "physicalBindingStable",
            "probeSurfaceExact",
            "qualifiedSurfaceExact",
            "workspaceExact",
            "workspaceHmac",
            "workspaceSnapshotStable",
          ].sort(),
        ) &&
      error.observation.surfaceProbeIdentity.workspaceHmac === null &&
      error.observation.surfaceProbeIdentity.paneHmac === null,
  );
  qualifiedSurface = null;
  await assert.rejects(
    observeCard5WebCanonical(
      harness.electronPage,
      harness.input.evidenceKey,
      owner.electronProcessIdentity,
    ),
    (error) => error.observation?.reason === "surface-probe-identity-invalid",
  );
  qualifiedSurface = exactSurface;
  assert.equal(
    (
      await observeCard5WebCanonical(
        harness.electronPage,
        harness.input.evidenceKey,
        owner.electronProcessIdentity,
      )
    )?.semanticPaneId,
    "pane-b",
    "DOM reordering around the same exact qualified element cannot change capture authority",
  );
  documentVisibility = "hidden";
  assert.equal(
    (
      await observeCard5WebCanonical(
        harness.electronPage,
        harness.input.evidenceKey,
        owner.electronProcessIdentity,
      )
    )?.presence,
    "background",
    "the exact latched surface remains observable while its document is hidden",
  );
  documentVisibility = "visible";
  probeSurface = replacementSurface;
  probeGeneration = "g-foreign";
  await assert.rejects(
    observeCard5WebCanonical(
      harness.electronPage,
      harness.input.evidenceKey,
      owner.electronProcessIdentity,
    ),
    (error) =>
      error.observation?.reason === "surface-probe-identity-invalid" &&
      error.observation.surfaceProbeIdentity?.probeSurfaceExact === false,
  );
  probeSurface = exactSurface;
  probeGeneration = daemonGeneration;
  replacePhysicalBindingAfterRead = 2;
  await assert.rejects(
    observeCard5WebCanonical(
      harness.electronPage,
      harness.input.evidenceKey,
      owner.electronProcessIdentity,
    ),
    (error) =>
      error.observation?.reason === "surface-probe-identity-invalid" &&
      error.observation.surfaceProbeIdentity?.physicalBindingStable === false,
    "a physical binding swap during observation must fail before correlation",
  );
  replacePhysicalBindingAfterRead = null;
  replacementPhysicalBinding = undefined;
  currentPhysicalBinding = null;
  replacePhysicalBindingAfterRead = 4;
  replacementPhysicalBinding = exactPhysicalBinding;
  await assert.rejects(
    observeCard5WebCanonical(
      harness.electronPage,
      harness.input.evidenceKey,
      owner.electronProcessIdentity,
    ),
    (error) =>
      error.observation?.reason === "surface-probe-identity-invalid" &&
      error.observation.surfaceProbeIdentity?.physicalBindingStable === false,
    "a captured null physical binding cannot become exact during later HMAC work",
  );
  replacePhysicalBindingAfterRead = 5;
  replacementPhysicalBinding = { ...exactPhysicalBinding, generation: "g-foreign" };
  await assert.rejects(
    observeCard5WebCanonical(
      harness.electronPage,
      harness.input.evidenceKey,
      owner.electronProcessIdentity,
    ),
    (error) =>
      error.observation?.reason === "surface-probe-identity-invalid" &&
      error.observation.surfaceProbeIdentity?.physicalBindingStable === false,
    "a captured null physical binding cannot become foreign during final observation",
  );
  currentPhysicalBinding = exactPhysicalBinding;
  replacePhysicalBindingAfterRead = null;
  replacementPhysicalBinding = undefined;
  replaceDuringProbe = true;
  await assert.rejects(
    observeCard5WebCanonical(
      harness.electronPage,
      harness.input.evidenceKey,
      owner.electronProcessIdentity,
    ),
    (error) =>
      error.observation?.reason === "surface-probe-identity-invalid" &&
      /^[0-9a-f]{64}$/u.test(error.observation.surfaceProbeIdentity?.workspaceHmac ?? "") &&
      /^[0-9a-f]{64}$/u.test(error.observation.surfaceProbeIdentity?.paneHmac ?? "") &&
      error.observation.surfaceProbeIdentity?.workspaceExact === true &&
      error.observation.surfaceProbeIdentity?.paneExact === true,
  );
  qualifiedSurface = exactSurface;
  replaceDuringProbe = true;
  restoreDuringProbe = true;
  await assert.rejects(
    observeCard5WebCanonical(
      harness.electronPage,
      harness.input.evidenceKey,
      owner.electronProcessIdentity,
    ),
    (error) =>
      error.observation?.reason === "surface-probe-identity-invalid" &&
      error.observation.surfaceProbeIdentity?.mutationCount === 2,
    "a callback-delivered A-to-B-to-A replacement must remain sticky",
  );
  replaceDuringProbe = false;
  restoreDuringProbe = false;
  qualifiedSurface = exactSurface;
  queuedMutationsDuringProbe = 2;
  await assert.rejects(
    observeCard5WebCanonical(
      harness.electronPage,
      harness.input.evidenceKey,
      owner.electronProcessIdentity,
    ),
    (error) =>
      error.observation?.reason === "surface-probe-identity-invalid" &&
      error.observation.surfaceProbeIdentity?.mutationCount === 2 &&
      error.observation.surfaceProbeIdentity?.mutationOverflow === false,
    "a takeRecords-only A-to-B-to-A replacement must retain truthful mutation axes",
  );
  queuedMutationsDuringProbe = 65;
  await assert.rejects(
    observeCard5WebCanonical(
      harness.electronPage,
      harness.input.evidenceKey,
      owner.electronProcessIdentity,
    ),
    (error) =>
      error.observation?.reason === "surface-probe-identity-invalid" &&
      error.observation.surfaceProbeIdentity?.mutationCount === 64 &&
      error.observation.surfaceProbeIdentity?.mutationOverflow === true,
    "takeRecords-only mutation overflow must remain bounded and truthful",
  );
  queuedMutationsDuringProbe = 0;
  await owner.close();
  await assert.rejects(
    observeCard5WebCanonical(
      harness.electronPage,
      harness.input.evidenceKey,
      owner.electronProcessIdentity,
    ),
    /qualified terminal readiness was not established/u,
  );
  delete globalThis.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__;
  delete globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__;
  delete globalThis.__TMUX_IDE_CARD5_ENVELOPE_STORE__;
  delete globalThis.__TMUX_IDE_CARD5_AUTHORITY_ACTIVITY_EVIDENCE__;
});

test("trusted Card5 terminal activation requires pointer click, xterm focus, and stable binding", async () => {
  const daemonGeneration = "550e8400-e29b-41d4-a716-446655440000";
  const evidenceKey = "ab".repeat(32);
  const paneSetHmac = (paneIds) =>
    createHmac("sha256", Buffer.from(evidenceKey, "hex"))
      .update(
        `pane-set\0${paneIds.length}\0${[...paneIds]
          .sort()
          .map((paneId) => `${paneId.length}\0${paneId}`)
          .join("")}`,
      )
      .digest("hex");
  assert.notEqual(
    paneSetHmac(["a", "b\0c"]),
    paneSetHmac(["a", "b", "c"]),
    "length framing must prevent delimiter aliases even before pane-id validation",
  );
  const previous = {
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    Node: globalThis.Node,
    MutationObserver: globalThis.MutationObserver,
    getComputedStyle: globalThis.getComputedStyle,
    envelopeEvidence: globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__,
    workspaceEvidence: globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__,
    qualifiedTerminal: globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__,
  };
  class ElementStub {
    children = [];
    isConnected = true;
    contains(value) {
      return this.children.some((child) => child === value || child.contains?.(value));
    }
    matches() {
      return false;
    }
    getAttribute() {
      return null;
    }
  }
  let bodyWidth = 300;
  let targetVisibility = "visible";
  class TextAreaStub extends ElementStub {
    classList = { contains: (value) => value === "xterm-helper-textarea" };
    value = "";
    readOnly = false;
    selectionStart = 0;
    selectionEnd = 0;
    throwOnSelectionRestore = false;
    setSelectionRange(start, end) {
      if (this.throwOnSelectionRestore) throw new Error("selection restore rejected");
      this.selectionStart = start;
      this.selectionEnd = end;
    }
  }
  class SurfaceStub extends ElementStub {
    isConnected = true;
    pane = "pane-b";
    phase = "connected";
    areaRef = null;
    getAttribute(name) {
      if (name === "data-semantic-pane-id") return this.pane;
      if (name === "data-phase") return this.phase;
      if (name === "data-workspace-name") return "workspace-b";
      return null;
    }
    contains(value) {
      return value === textarea;
    }
    closest(value) {
      return value === ".tiled-pane-area" ? this.areaRef : null;
    }
    matches(value) {
      return value === ".terminal-surface[data-phase='connected']" || value === ".terminal-surface";
    }
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 800, height: 500 };
    }
  }
  class BodyStub extends ElementStub {
    isConnected = true;
    pane = "pane-b";
    areaRef = null;
    parentElement = { getAttribute: (name) => (name === "data-pane" ? this.pane : null) };
    closest(value) {
      return value === ".tiled-pane-area" ? this.areaRef : null;
    }
    matches(value) {
      return value === ".pane-tile[data-composed='true'] > .pane-tile__body";
    }
    contains(value) {
      return value === bodyHit;
    }
    getBoundingClientRect() {
      return { left: 100, top: 80, width: bodyWidth, height: 200 };
    }
  }
  const textarea = new TextAreaStub();
  const surface = new SurfaceStub();
  const body = new BodyStub();
  const otherBody = new BodyStub();
  otherBody.pane = "pane-other";
  const bodyHit = new ElementStub();
  let compositor = false;
  let areaSurface = surface;
  let composedBodies = [otherBody, body];
  const area = new (class extends ElementStub {
    isConnected = true;
    contains(value) {
      return (
        value === surface || value === body || value === otherBody || composedBodies.includes(value)
      );
    }
    getAttribute(name) {
      if (name === "data-pane-compositor") return compositor ? "true" : "false";
      if (name === "data-pane-count") return compositor ? "2" : "1";
      return null;
    }
    querySelectorAll(selector) {
      if (selector.includes("terminal-surface")) return [areaSurface];
      if (selector.includes("pane-tile")) return compositor ? composedBodies : [];
      return [];
    }
  })();
  surface.areaRef = area;
  body.areaRef = area;
  let nodes = [surface];
  let hitTarget = surface;
  let clickCount = 0;
  let clickedNode = null;
  let clickOptions = null;
  let clickFailure = null;
  let clickBlockMs = 0;
  let insertBlockMs = 0;
  let insertDispatchDelayMs = 0;
  let insertNeverSettles = false;
  let releaseNeverSettlingInsert = null;
  let exactPageCloseCount = 0;
  let exactPageClosed = false;
  let exactPageCloseFailure = null;
  let insertCount = 0;
  let downstreamInputCount = 0;
  let clearFocusDuringInsert = false;
  let detachTargetDuringClick = false;
  let beforeHandleClick = null;
  let beforeFinalTargetCheck = null;
  let afterPreInsertObservation = null;
  let beforeKeyboardInsert = null;
  let keyboardEventPlan = null;
  let inputReceiptPlan = null;
  let receiptWaiterAwaitNeverSettles = false;
  let receiptWaiterRendererBlocked = false;
  let receiptWaiterBlockedResolvers = [];
  let disposedHandleCount = 0;
  let elementHandlesDelayMs = 0;
  let evaluateHandleDelayMs = 0;
  let inputGuardArmRequestDelayMs = 0;
  let evaluateHandleCallCount = 0;
  let observationSequence = [];
  let observationCallCount = 0;
  let clearFocusAfterBindingObservation = false;
  const documentCaptureListeners = new Map();
  let paneSelectionCount = 0;
  let focusRequestCount = 0;
  const mutationObservers = new Set();
  const recordIdentityMutation = (
    target = area,
    addedNodes = [],
    removedNodes = [],
    detail = {},
  ) => {
    for (const observer of mutationObservers)
      observer.records.push({ type: "childList", target, addedNodes, removedNodes, ...detail });
  };
  const deliverIdentityMutations = () => {
    for (const observer of mutationObservers) {
      const records = observer.takeRecords();
      if (records.length > 0) observer.callback(records, observer);
    }
  };
  class MutationObserverStub {
    records = [];
    constructor(callback) {
      this.callback = callback;
    }
    observe() {
      mutationObservers.add(this);
    }
    takeRecords() {
      return this.records.splice(0);
    }
    disconnect() {
      mutationObservers.delete(this);
    }
  }
  const dispatchBrowserEvent = ({
    type,
    node,
    trusted = true,
    data = null,
    cancelable = type === "beforeinput",
    inputType = type === "beforeinput" || type === "input" ? "insertText" : undefined,
  }) => {
    let prevented = false;
    let stopped = false;
    documentCaptureListeners.get(type)?.({
      type,
      button: 0,
      target: node,
      data,
      inputType,
      cancelable,
      isTrusted: trusted,
      composedPath: () => [node],
      preventDefault: () => {
        prevented = true;
      },
      stopImmediatePropagation: () => {
        stopped = true;
      },
    });
    if (!stopped && type === "pointerdown") paneSelectionCount += 1;
    if (!stopped && type === "pointerup") focusRequestCount += 1;
    if (!stopped && type === "input") downstreamInputCount += 1;
    return { prevented, stopped };
  };
  const dispatchPointer = ({ node, trusted = true }) =>
    dispatchBrowserEvent({ type: "pointerdown", node, trusted });
  const binding = Object.freeze({
    workspaceName: "workspace-b",
    semanticPaneId: "pane-b",
    processIdentity: "chromium:1",
    generation: daemonGeneration,
    runtimeReplacement: {
      inputReceipts: [],
      inputReceiptCount: 0,
      currentLifecycleRequest: {
        status: "exact",
        requestHmac: "aa".repeat(32),
        paneSetHmac: paneSetHmac(["pane-b"]),
        physicalBindingExact: true,
        physicalEpochHmac: "bb".repeat(32),
        activeCount: 1,
        descriptorCount: 1,
        overflow: false,
      },
    },
    workspaceEvidence: {
      generation: 7,
      target: { session: "session-a", daemon: { instanceId: daemonGeneration } },
      authority: {
        generation: daemonGeneration,
        session: "session-a",
        owners: { input: null, focus: null, geometry: null },
        clients: [{ clientId: "web-a", surface: "web" }],
      },
    },
  });
  const physicalBinding = {
    physicalEpoch: 1,
    generation: daemonGeneration,
    runtimeSession: "session-a",
    workspaceName: "workspace-b",
    semanticPaneIds: ["pane-b"],
    stage: "first-seed",
    clientId: "web-a",
    requestId: "request-a",
  };
  let envelopeEvidence = {
    currentPhysicalBinding: physicalBinding,
    inputReceiptCount: 0,
    inputReceipts: [],
    inputOperationCount: 0,
    inputOperations: [],
  };
  let workspaceSnapshot = binding.workspaceEvidence;
  const unwrapHandleArgument = (value) => {
    if (value instanceof HandleStub) return value.node;
    if (Array.isArray(value)) return value.map(unwrapHandleArgument);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, unwrapHandleArgument(entry)]),
      );
    return value;
  };
  const clickNode = async (node, options) => {
    beforeHandleClick?.();
    beforeHandleClick = null;
    if (!node?.isConnected) {
      const error = new Error("detached");
      error.name = "TimeoutError";
      throw error;
    }
    const gesture = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].map((type) =>
      dispatchBrowserEvent({ type, node }),
    );
    if (gesture.some(({ prevented, stopped }) => prevented || stopped)) return;
    clickedNode = node;
    clickCount += 1;
    clickOptions = options;
    const blockedUntil = performance.now() + clickBlockMs;
    while (performance.now() < blockedUntil) {
      // Deliberately block timer delivery to test the post-settlement clock fence.
    }
    if (clickFailure) throw clickFailure;
    if (detachTargetDuringClick) body.isConnected = false;
    globalThis.document.activeElement = textarea;
  };
  class HandleStub {
    constructor(node, kind = null) {
      this.node = node;
      this.kind = kind;
    }
    evaluate(callback, value) {
      if (
        receiptWaiterAwaitNeverSettles &&
        this.kind === "input-receipt-waiter" &&
        (receiptWaiterRendererBlocked || callback.toString().includes("awaitOutcome"))
      ) {
        receiptWaiterRendererBlocked = true;
        return new Promise((resolve) => receiptWaiterBlockedResolvers.push(resolve));
      }
      return callback(this.node, unwrapHandleArgument(value));
    }
    async evaluateHandle(callback, value) {
      evaluateHandleCallCount += 1;
      if (evaluateHandleDelayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, evaluateHandleDelayMs));
      if (inputGuardArmRequestDelayMs > 0 && callback.toString().includes("browserArmSample"))
        await new Promise((resolve) => setTimeout(resolve, inputGuardArmRequestDelayMs));
      return new HandleStub(
        await callback(this.node, unwrapHandleArgument(value)),
        callback.toString().includes("expectedClientGeneration") ? "input-receipt-waiter" : null,
      );
    }
    asElement() {
      return this.node instanceof ElementStub ? this : null;
    }
    click(options) {
      return clickNode(this.node, options);
    }
    async dispose() {
      disposedHandleCount += 1;
    }
  }
  const page = {
    bringToFront: async () => {},
    close: async () => {
      exactPageCloseCount += 1;
      if (exactPageCloseFailure) throw exactPageCloseFailure;
      exactPageClosed = true;
      releaseNeverSettlingInsert?.();
      releaseNeverSettlingInsert = null;
      receiptWaiterAwaitNeverSettles = false;
      receiptWaiterRendererBlocked = false;
      for (const resolveWaiter of receiptWaiterBlockedResolvers) resolveWaiter(null);
      receiptWaiterBlockedResolvers = [];
    },
    locator: () => ({
      evaluateAll: async (callback, value) => callback(nodes, value),
      elementHandles: async () => {
        if (elementHandlesDelayMs > 0)
          await new Promise((resolve) => setTimeout(resolve, elementHandlesDelayMs));
        return nodes.map((node) => new HandleStub(node));
      },
    }),
    keyboard: {
      insertText: async (text) => {
        if (insertNeverSettles) {
          await new Promise((resolve) => {
            releaseNeverSettlingInsert = resolve;
          });
          if (exactPageClosed) return;
        }
        if (insertDispatchDelayMs > 0)
          await new Promise((resolve) => setTimeout(resolve, insertDispatchDelayMs));
        if (exactPageClosed) return;
        beforeKeyboardInsert?.();
        beforeKeyboardInsert = null;
        const inputTarget = globalThis.document.activeElement;
        const plan = keyboardEventPlan ?? {};
        keyboardEventPlan = null;
        const beforeInputs = Array.from({ length: plan.beforeInputCount ?? 1 }, () =>
          dispatchBrowserEvent({
            type: "beforeinput",
            node: plan.beforeInputTarget ?? inputTarget,
            data: Object.hasOwn(plan, "beforeInputData") ? plan.beforeInputData : text,
            trusted: plan.beforeInputTrusted ?? true,
            cancelable: plan.beforeInputCancelable ?? true,
            inputType: plan.beforeInputType ?? "insertText",
          }),
        );
        if (beforeInputs.some(({ prevented, stopped }) => prevented || stopped)) return;
        if (clearFocusDuringInsert) globalThis.document.activeElement = null;
        if (typeof inputTarget?.value === "string" && inputTarget.readOnly !== true)
          inputTarget.value += text;
        const inputs = Array.from({ length: plan.inputCount ?? 1 }, () =>
          dispatchBrowserEvent({
            type: "input",
            node: plan.inputTarget ?? inputTarget,
            data: Object.hasOwn(plan, "inputData") ? plan.inputData : text,
            trusted: plan.inputTrusted ?? true,
            cancelable: false,
            inputType: plan.inputType ?? "insertText",
          }),
        );
        if (inputs.length !== 1 || inputs.some(({ prevented, stopped }) => prevented || stopped))
          return;
        insertCount += 1;
        const receiptPlan = inputReceiptPlan ?? {};
        inputReceiptPlan = null;
        const baseline = envelopeEvidence.inputReceiptCount;
        const operationBoundary = envelopeEvidence.inputOperationCount;
        workspaceSnapshot = receiptPlan.workspaceSnapshot ?? {
          ...workspaceSnapshot,
          authority: {
            ...workspaceSnapshot.authority,
            owners: {
              ...workspaceSnapshot.authority.owners,
              input: Object.hasOwn(receiptPlan, "authorityOwner")
                ? receiptPlan.authorityOwner
                : "web-a",
            },
          },
        };
        envelopeEvidence = {
          ...envelopeEvidence,
          currentPhysicalBinding: receiptPlan.binding ?? envelopeEvidence.currentPhysicalBinding,
          inputReceiptCount: receiptPlan.count ?? baseline + 1,
          inputReceipts: receiptPlan.receipts ?? [
            ...envelopeEvidence.inputReceipts,
            {
              ordinal: baseline,
              generation: daemonGeneration,
              pane: "pane-b",
              inputSha256: "ef".repeat(32),
              requestId: "request-a",
              authorityClientId: "web-a",
            },
          ],
          inputOperationCount: receiptPlan.operationCount ?? operationBoundary + 10,
          inputOperations: receiptPlan.operations ?? [
            ...envelopeEvidence.inputOperations,
            {
              physicalEpoch: 1,
              generation: daemonGeneration,
              lifecycleRequestId: "request-a",
              authorityRequestId: null,
              clientId: "web-a",
              pane: "pane-b",
              seq: null,
              stage: "xterm-enqueue",
              outcome: "ok",
              ordinal: operationBoundary,
            },
            {
              physicalEpoch: 1,
              generation: daemonGeneration,
              lifecycleRequestId: "request-a",
              authorityRequestId: null,
              clientId: "web-a",
              pane: "pane-b",
              seq: null,
              stage: "surface-write",
              outcome: "attempt",
              ordinal: operationBoundary + 1,
            },
            {
              physicalEpoch: 1,
              generation: daemonGeneration,
              lifecycleRequestId: "request-a",
              authorityRequestId: "authority-a",
              clientId: "web-a",
              pane: null,
              seq: null,
              stage: "authority-request",
              outcome: "attempt",
              ordinal: operationBoundary + 2,
            },
            {
              physicalEpoch: 1,
              generation: daemonGeneration,
              lifecycleRequestId: "request-a",
              authorityRequestId: "authority-a",
              clientId: "web-a",
              pane: null,
              seq: null,
              stage: "authority-request",
              outcome: "sent",
              ordinal: operationBoundary + 3,
            },
            {
              physicalEpoch: 1,
              generation: daemonGeneration,
              lifecycleRequestId: "request-a",
              authorityRequestId: "authority-a",
              clientId: "web-a",
              pane: null,
              seq: null,
              stage: "authority-result",
              outcome: "granted",
              ordinal: operationBoundary + 4,
            },
            ...[
              ["input-send", "attempt"],
              ["input-send", "sent"],
              ["input-ack", "ok"],
              ["receipt-published", "ok"],
            ].map(([stage, outcome], index) => ({
              physicalEpoch: 1,
              generation: daemonGeneration,
              lifecycleRequestId: "request-a",
              authorityRequestId: null,
              clientId: "web-a",
              pane: "pane-b",
              seq: 1,
              stage,
              outcome,
              ordinal: operationBoundary + index + 5,
            })),
            {
              physicalEpoch: 1,
              generation: daemonGeneration,
              lifecycleRequestId: "request-a",
              authorityRequestId: null,
              clientId: "web-a",
              pane: "pane-b",
              seq: null,
              stage: "surface-write",
              outcome: "ok",
              ordinal: operationBoundary + 9,
            },
          ],
        };
        const blockedUntil = performance.now() + insertBlockMs;
        while (performance.now() < blockedUntil) {
          // Deliberately block timer delivery to test the post-settlement clock fence.
        }
      },
    },
  };
  const activate = (sequence = [binding, binding, binding, binding], input = null) => {
    observationSequence = [...sequence];
    observationCallCount = 0;
    if (input?.inputText !== undefined) {
      const initial = sequence.find((entry) => entry?.runtimeReplacement)?.runtimeReplacement;
      envelopeEvidence = {
        currentPhysicalBinding: physicalBinding,
        inputReceiptCount: initial?.inputReceiptCount ?? 0,
        inputReceipts: initial?.inputReceipts ?? [],
        inputOperationCount: 0,
        inputOperations: [],
      };
      workspaceSnapshot =
        sequence.find((entry) => entry?.workspaceEvidence)?.workspaceEvidence ??
        binding.workspaceEvidence;
    }
    return activateCard5ExactTerminalSurface({
      mode: input === null || input?.inputText === undefined ? "focus" : "input",
      page,
      keyHex: evidenceKey,
      processIdentity: "chromium:1",
      expectedPane: "pane-b",
      expectedPaneHmac: "cd".repeat(32),
      ...(input ?? {}),
      ...(input?.inputText === undefined ? {} : { inputHostRole: "chromium", inputOrdinal: 1 }),
      observeAuthorityReceipt: async () => {
        observationCallCount += 1;
        const observed = observationSequence.shift() ?? null;
        if (observationCallCount === 3) {
          beforeFinalTargetCheck?.();
          beforeFinalTargetCheck = null;
        }
        if (clearFocusAfterBindingObservation && observationSequence.length === 0) {
          globalThis.document.activeElement = null;
        }
        if (observationCallCount === 5) {
          afterPreInsertObservation?.();
          afterPreInsertObservation = null;
        }
        return observed;
      },
    });
  };
  globalThis.HTMLElement = ElementStub;
  globalThis.Element = ElementStub;
  globalThis.HTMLTextAreaElement = TextAreaStub;
  globalThis.Node = ElementStub;
  globalThis.MutationObserver = MutationObserverStub;
  globalThis.getComputedStyle = () => ({
    display: "block",
    visibility: targetVisibility,
    opacity: "1",
  });
  globalThis.document = {
    activeElement: null,
    documentElement: new ElementStub(),
    elementFromPoint: () => hitTarget,
    querySelectorAll: (selector) =>
      selector === ".terminal-surface[data-phase='connected']"
        ? nodes.filter((node) => node.phase === "connected")
        : [],
    addEventListener: (type, listener, capture) => {
      if (capture === true) documentCaptureListeners.set(type, listener);
    },
    removeEventListener: (type, listener, capture) => {
      if (capture === true && documentCaptureListeners.get(type) === listener)
        documentCaptureListeners.delete(type);
    },
  };
  globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ = () => envelopeEvidence;
  globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__ = () => ({ snapshot: workspaceSnapshot });
  globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__ = () => surface;
  try {
    await activate();
    assert.equal(clickCount, 1, "activation must use the trusted locator click path");
    assert.equal(clickOptions.force, undefined, "activation must never force the trusted click");
    assert.ok(clickOptions.timeout > 0 && clickOptions.timeout < 3_000);
    clickBlockMs = 30;
    await activate([binding, binding, binding, binding], { deadline: performance.now() + 200 });
    clickBlockMs = 0;
    compositor = true;
    composedBodies = [otherBody, body];
    hitTarget = bodyHit;
    await activate();
    assert.equal(clickedNode, body, "compositor activation must click the latched exact pane body");
    const clicksBeforeReorder = clickCount;
    beforeHandleClick = () => {
      composedBodies = [body, otherBody];
      recordIdentityMutation(area);
    };
    await assert.rejects(activate(), (error) => {
      assert.equal(error.observation?.reason, "trusted-pointer-topology-rejected");
      assert.equal(error.observation.pointerDispatchReason, "pointer-mutation-detected");
      assert.equal(error.observation.pointerDispatchAxes?.mutationCount, 1);
      assert.equal(error.observation.pointerDispatchAxes?.mutationCategories.identityNode, 1);
      assert.equal(error.observation.pointerDispatchAxes?.mutationTail.length, 1);
      assert.match(
        error.observation.pointerDispatchAxes?.mutationTail[0]?.relevanceHmac ?? "",
        /^[0-9a-f]{64}$/u,
      );
      assert.equal(
        Object.hasOwn(error.observation.pointerDispatchAxes?.mutationTail[0] ?? {}, "relevance"),
        false,
      );
      return true;
    });
    assert.equal(clickCount, clicksBeforeReorder, "a dispatch-window reorder must not click");
    composedBodies = [otherBody, body];
    const insertedForeignBody = new BodyStub();
    insertedForeignBody.pane = "pane-foreign";
    insertedForeignBody.areaRef = area;
    const clicksBeforeInsertion = clickCount;
    const inputsBeforeTopologyRaces = insertCount;
    const selectionsBeforeTopologyRaces = paneSelectionCount;
    const focusRequestsBeforeTopologyRaces = focusRequestCount;
    beforeHandleClick = () => {
      composedBodies = [otherBody, insertedForeignBody, body];
      recordIdentityMutation(area, [insertedForeignBody]);
    };
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "trusted-pointer-topology-rejected",
    );
    assert.equal(clickCount, clicksBeforeInsertion, "an insertion must prevent every click");
    composedBodies = [otherBody, body];
    const replacementBody = new BodyStub();
    replacementBody.areaRef = area;
    const replacementSurface = new SurfaceStub();
    replacementSurface.areaRef = area;
    const clicksBeforeReplacement = clickCount;
    beforeFinalTargetCheck = () => {
      surface.isConnected = false;
      body.isConnected = false;
      areaSurface = replacementSurface;
      composedBodies = [otherBody, replacementBody];
    };
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "pointer-target-changed",
    );
    assert.equal(
      clickCount,
      clicksBeforeReplacement,
      "a detached replacement must receive no click",
    );
    surface.isConnected = true;
    body.isConnected = true;
    areaSurface = surface;
    composedBodies = [otherBody, body];
    beforeHandleClick = () => {
      surface.isConnected = false;
      body.isConnected = false;
      areaSurface = replacementSurface;
      composedBodies = [otherBody, replacementBody];
      surface.isConnected = true;
      body.isConnected = true;
      areaSurface = surface;
      composedBodies = [otherBody, body];
      recordIdentityMutation(area, [replacementSurface, replacementBody], [surface, body]);
      recordIdentityMutation(area, [surface, body], [replacementSurface, replacementBody]);
      deliverIdentityMutations();
    };
    const clicksBeforeAba = clickCount;
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "trusted-pointer-topology-rejected",
    );
    assert.equal(clickCount, clicksBeforeAba, "A→B→A identity replacement must prevent clicking");
    areaSurface = surface;
    composedBodies = [otherBody, body];
    const reparentedArea = new ElementStub();
    const clicksBeforeReparent = clickCount;
    beforeHandleClick = () => {
      body.areaRef = reparentedArea;
      recordIdentityMutation(area, [], [body]);
    };
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "trusted-pointer-topology-rejected",
    );
    assert.equal(
      clickCount,
      clicksBeforeReparent,
      "connected target reparent must prevent clicking",
    );
    body.areaRef = area;
    const clicksBeforePaneMutation = clickCount;
    beforeHandleClick = () => {
      body.pane = "pane-other";
      recordIdentityMutation(body);
    };
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "trusted-pointer-topology-rejected",
    );
    assert.equal(
      clickCount,
      clicksBeforePaneMutation,
      "parent pane mutation must prevent clicking",
    );
    body.pane = "pane-b";
    const clicksBeforeAreaMutation = clickCount;
    beforeHandleClick = () => {
      compositor = false;
      recordIdentityMutation(area);
    };
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "trusted-pointer-topology-rejected",
    );
    assert.equal(clickCount, clicksBeforeAreaMutation, "area mode mutation must prevent clicking");
    compositor = true;
    const lateDuplicateSurface = new SurfaceStub();
    lateDuplicateSurface.areaRef = area;
    const clicksBeforeGlobalDuplicate = clickCount;
    beforeHandleClick = () => {
      nodes = [surface, lateDuplicateSurface];
      recordIdentityMutation(globalThis.document.documentElement, [lateDuplicateSurface]);
    };
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "trusted-pointer-topology-rejected",
    );
    assert.equal(
      clickCount,
      clicksBeforeGlobalDuplicate,
      "a late global same-pane surface must prevent clicking",
    );
    nodes = [surface];
    const restoredGlobalSurface = new SurfaceStub();
    restoredGlobalSurface.pane = "pane-other";
    restoredGlobalSurface.phase = "idle";
    const clicksBeforeGlobalAba = clickCount;
    beforeHandleClick = () => {
      nodes = [surface, restoredGlobalSurface];
      restoredGlobalSurface.pane = "pane-b";
      recordIdentityMutation(restoredGlobalSurface, [], [], {
        type: "attributes",
        attributeName: "data-semantic-pane-id",
        oldValue: "pane-other",
      });
      restoredGlobalSurface.phase = "connected";
      recordIdentityMutation(restoredGlobalSurface, [], [], {
        type: "attributes",
        attributeName: "data-phase",
        oldValue: "idle",
      });
      restoredGlobalSurface.phase = "idle";
      recordIdentityMutation(restoredGlobalSurface, [], [], {
        type: "attributes",
        attributeName: "data-phase",
        oldValue: "connected",
      });
      restoredGlobalSurface.pane = "pane-other";
      recordIdentityMutation(restoredGlobalSurface, [], [], {
        type: "attributes",
        attributeName: "data-semantic-pane-id",
        oldValue: "pane-b",
      });
      deliverIdentityMutations();
    };
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "trusted-pointer-topology-rejected",
    );
    assert.equal(
      clickCount,
      clicksBeforeGlobalAba,
      "callback-delivered global pane/phase ABA must prevent clicking",
    );
    nodes = [surface];
    const clicksBeforeMutationOverflow = clickCount;
    beforeHandleClick = () => {
      for (let index = 0; index < 65; index += 1) recordIdentityMutation(area);
      deliverIdentityMutations();
    };
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "trusted-pointer-topology-rejected",
    );
    assert.equal(clickCount, clicksBeforeMutationOverflow, "mutation overflow must fail closed");
    const ancestorWrapper = new ElementStub();
    ancestorWrapper.children = [area];
    const clicksBeforeAncestorAba = clickCount;
    beforeHandleClick = () => {
      recordIdentityMutation(globalThis.document.documentElement, [], [ancestorWrapper]);
      recordIdentityMutation(globalThis.document.documentElement, [ancestorWrapper], []);
      deliverIdentityMutations();
    };
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "trusted-pointer-topology-rejected",
    );
    assert.equal(
      clickCount,
      clicksBeforeAncestorAba,
      "callback-delivered ancestor wrapper ABA must prevent clicking",
    );
    const foreignWrapper = new ElementStub();
    const wrappedDuplicateSurface = new SurfaceStub();
    foreignWrapper.children = [wrappedDuplicateSurface];
    const clicksBeforeForeignWrapperAba = clickCount;
    beforeHandleClick = () => {
      recordIdentityMutation(globalThis.document.documentElement, [foreignWrapper], []);
      recordIdentityMutation(globalThis.document.documentElement, [], [foreignWrapper]);
      deliverIdentityMutations();
    };
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "trusted-pointer-topology-rejected",
    );
    assert.equal(
      clickCount,
      clicksBeforeForeignWrapperAba,
      "callback-delivered foreign wrapper ABA must prevent clicking",
    );
    let preliminaryOutcome = null;
    const clicksBeforeUntrusted = clickCount;
    beforeHandleClick = () => {
      preliminaryOutcome = dispatchPointer({ node: body, trusted: false });
      dispatchBrowserEvent({ type: "pointercancel", node: body, trusted: false });
    };
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "trusted-pointer-topology-rejected",
    );
    assert.deepEqual(preliminaryOutcome, { prevented: true, stopped: true });
    assert.equal(clickCount, clicksBeforeUntrusted, "untrusted-first must poison intended click");
    const wrongPointerTarget = new ElementStub();
    const clicksBeforeWrongTarget = clickCount;
    beforeHandleClick = () => {
      preliminaryOutcome = dispatchPointer({ node: wrongPointerTarget, trusted: true });
    };
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "trusted-pointer-topology-rejected",
    );
    assert.deepEqual(preliminaryOutcome, { prevented: true, stopped: true });
    assert.equal(
      clickCount,
      clicksBeforeWrongTarget,
      "wrong-target-first must poison intended click",
    );
    assert.equal(insertCount, inputsBeforeTopologyRaces, "topology races must send zero input");
    assert.equal(
      paneSelectionCount,
      selectionsBeforeTopologyRaces,
      "rejected full gestures must cause zero pane selections",
    );
    assert.equal(
      focusRequestCount,
      focusRequestsBeforeTopologyRaces,
      "rejected full gestures must cause zero focus requests",
    );
    assert.equal(documentCaptureListeners.size, 0, "every gesture guard listener must be removed");
    nodes = [surface];
    body.pane = "pane-other";
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "pointer-target-cardinality-invalid",
    );
    body.pane = "pane-b";
    const duplicateBody = new BodyStub();
    duplicateBody.areaRef = area;
    composedBodies = [otherBody, body, duplicateBody];
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "pointer-target-cardinality-invalid",
    );
    composedBodies = [otherBody, body];
    targetVisibility = "hidden";
    await assert.rejects(
      activate(),
      (error) =>
        error.observation?.reason === "pointer-target-actionability-invalid" &&
        error.observation?.targetKind === "compositor-pane-body" &&
        error.observation?.targetAxes?.visible === false,
    );
    targetVisibility = "visible";
    bodyWidth = 0;
    await assert.rejects(
      activate(),
      (error) =>
        error.observation?.reason === "pointer-target-actionability-invalid" &&
        error.observation?.targetAxes?.nonempty === false,
    );
    bodyWidth = 300;
    hitTarget = new ElementStub();
    await assert.rejects(
      activate(),
      (error) =>
        error.observation?.reason === "pointer-target-actionability-invalid" &&
        error.observation?.targetAxes?.hitTarget === false,
    );
    hitTarget = bodyHit;
    body.isConnected = false;
    await assert.rejects(
      activate(),
      (error) =>
        error.observation?.reason === "pointer-target-actionability-invalid" &&
        error.observation?.targetAxes?.connected === false,
    );
    body.isConnected = true;
    detachTargetDuringClick = true;
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "pointer-target-changed",
    );
    detachTargetDuringClick = false;
    body.isConnected = true;
    compositor = false;
    hitTarget = surface;
    const foreignArea = new ElementStub();
    const foreignSurface = new SurfaceStub();
    foreignSurface.areaRef = foreignArea;
    const clicksBeforeForeignArea = clickCount;
    nodes = [surface, foreignSurface];
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "surface-handle-cardinality-invalid",
    );
    assert.equal(clickCount, clicksBeforeForeignArea, "a foreign same-pane area must not click");
    nodes = [surface];
    const missingLifecycleBinding = {
      ...binding,
      runtimeReplacement: {
        inputReceipts: [],
        inputReceiptCount: 0,
        currentLifecycleRequest: {
          status: "missing",
          requestHmac: null,
          activeCount: 0,
          descriptorCount: 0,
          overflow: false,
        },
      },
    };
    await activate([
      missingLifecycleBinding,
      missingLifecycleBinding,
      missingLifecycleBinding,
      missingLifecycleBinding,
    ]);
    const clicksBeforeInvalidGeneration = clickCount;
    const inputsBeforeInvalidGeneration = insertCount;
    for (const invalidGenerationBinding of [
      { ...missingLifecycleBinding, generation: null },
      {
        ...missingLifecycleBinding,
        workspaceEvidence: { ...binding.workspaceEvidence, authority: null },
      },
      {
        ...missingLifecycleBinding,
        workspaceEvidence: {
          ...binding.workspaceEvidence,
          authority: { generation: "g-foreign" },
        },
      },
      {
        ...missingLifecycleBinding,
        workspaceEvidence: {
          ...binding.workspaceEvidence,
          target: { ...binding.workspaceEvidence.target, daemon: { instanceId: "g-foreign" } },
        },
      },
      ...[
        "g1",
        "a".repeat(129),
        "550e8400-e29b-01d4-a716-446655440000",
        "550e8400-e29b-41d4-7716-446655440000",
      ].map((malformedGeneration) => ({
        ...missingLifecycleBinding,
        generation: malformedGeneration,
        workspaceEvidence: {
          ...binding.workspaceEvidence,
          authority: { generation: malformedGeneration },
          target: {
            ...binding.workspaceEvidence.target,
            daemon: { instanceId: malformedGeneration },
          },
        },
      })),
    ]) {
      await assert.rejects(
        activate([invalidGenerationBinding]),
        (error) => error.observation?.reason === "activation-lifecycle-invalid",
      );
    }
    assert.equal(clickCount, clicksBeforeInvalidGeneration);
    assert.equal(insertCount, inputsBeforeInvalidGeneration);
    const clientGenerationChanged = {
      ...binding,
      workspaceEvidence: { ...binding.workspaceEvidence, generation: 8 },
    };
    await assert.rejects(
      activate([binding, clientGenerationChanged], {
        inputText: "payload\n",
        inputSha256: "ef".repeat(32),
        deadline: performance.now() + 100,
      }),
      (error) => error.observation?.reason === "input-activation-binding-changed",
    );
    assert.equal(clickCount, clicksBeforeInvalidGeneration);
    assert.equal(insertCount, inputsBeforeInvalidGeneration);
    const ambiguousLifecycleBinding = {
      ...binding,
      runtimeReplacement: {
        ...binding.runtimeReplacement,
        currentLifecycleRequest: {
          status: "ambiguous",
          requestHmac: null,
          activeCount: 2,
          descriptorCount: 2,
          overflow: false,
        },
      },
    };
    await assert.rejects(
      activate([ambiguousLifecycleBinding]),
      (error) => error.observation?.reason === "activation-lifecycle-ambiguous",
    );
    const overflowLifecycleBinding = {
      ...binding,
      runtimeReplacement: {
        ...binding.runtimeReplacement,
        currentLifecycleRequest: {
          status: "overflow",
          requestHmac: null,
          activeCount: 8,
          descriptorCount: 8,
          overflow: true,
        },
      },
    };
    await assert.rejects(
      activate([overflowLifecycleBinding]),
      (error) => error.observation?.reason === "activation-lifecycle-overflow",
    );
    await assert.rejects(
      activate([binding, missingLifecycleBinding]),
      (error) => error.observation?.reason === "activation-binding-unstable",
    );
    const changedLifecycleHmacBinding = {
      ...binding,
      runtimeReplacement: {
        ...binding.runtimeReplacement,
        currentLifecycleRequest: {
          ...binding.runtimeReplacement.currentLifecycleRequest,
          requestHmac: "bb".repeat(32),
        },
      },
    };
    await assert.rejects(
      activate([binding, changedLifecycleHmacBinding]),
      (error) => error.observation?.reason === "activation-binding-unstable",
    );
    await assert.rejects(
      activate(
        Array.from({ length: 32 }, () => missingLifecycleBinding),
        {
          inputText: "payload\n",
          inputSha256: "ef".repeat(32),
          deadline: performance.now() + 100,
        },
      ),
      (error) =>
        error.observation?.reason === "input-activation-request-timeout" &&
        error.observation?.lifecycleAxes?.status === "missing" &&
        error.observation?.lifecycleAxes?.countValid === true,
    );
    await assert.rejects(
      activate([ambiguousLifecycleBinding], {
        inputText: "payload\n",
        inputSha256: "ef".repeat(32),
        deadline: performance.now() + 100,
      }),
      (error) => error.observation?.reason === "activation-lifecycle-ambiguous",
    );
    globalThis.document.activeElement = null;
    clickFailure = new Error("overlay");
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "trusted-pointer-rejected",
    );
    const actionabilityTimeout = new Error("hidden");
    actionabilityTimeout.name = "TimeoutError";
    clickFailure = actionabilityTimeout;
    await assert.rejects(
      activate(),
      (error) =>
        error.observation?.reason === "trusted-pointer-actionability-timeout" &&
        error.observation?.phase === "trusted-pointer" &&
        Number.isSafeInteger(error.observation?.elapsedMs) &&
        Number.isSafeInteger(error.observation?.remainingMs),
    );
    clickFailure = null;
    const duplicateSurface = new SurfaceStub();
    duplicateSurface.areaRef = area;
    nodes = [surface, duplicateSurface];
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "surface-handle-cardinality-invalid",
    );
    nodes = [surface];
    surface.isConnected = false;
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "surface-handle-cardinality-invalid",
    );
    surface.isConnected = true;
    await assert.rejects(
      activate([binding, { ...binding, generation: "g2" }]),
      (error) => error.observation?.reason === "activation-binding-unstable",
    );
    clearFocusAfterBindingObservation = true;
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "xterm-focus-changed",
    );
    clearFocusAfterBindingObservation = false;
    const receipt = {
      ordinal: 0,
      generation: daemonGeneration,
      pane: "pane-b",
      inputSha256: "ef".repeat(32),
      requestId: "request-a",
      authorityClientId: "web-a",
    };
    const requestHmac = createHmac("sha256", Buffer.from("ab".repeat(32), "hex"))
      .update("request\0request-a")
      .digest("hex");
    const requestBinding = {
      ...binding,
      runtimeReplacement: {
        ...binding.runtimeReplacement,
        currentLifecycleRequest: {
          status: "exact",
          requestHmac,
          paneSetHmac: paneSetHmac(["pane-b"]),
          physicalBindingExact: true,
          physicalEpochHmac: "bb".repeat(32),
          activeCount: 1,
          descriptorCount: 1,
          overflow: false,
        },
      },
    };
    const afterInput = {
      ...requestBinding,
      runtimeReplacement: {
        ...requestBinding.runtimeReplacement,
        inputReceipts: [receipt],
        inputReceiptCount: 1,
      },
    };
    const changedPaneSetBinding = {
      ...requestBinding,
      runtimeReplacement: {
        ...requestBinding.runtimeReplacement,
        currentLifecycleRequest: {
          ...requestBinding.runtimeReplacement.currentLifecycleRequest,
          paneSetHmac: paneSetHmac(["pane-b", "pane-foreign"]),
        },
      },
    };
    const clicksBeforePaneSetChurn = clickCount;
    const insertsBeforePaneSetChurn = insertCount;
    await assert.rejects(
      activate([requestBinding, changedPaneSetBinding, requestBinding], {
        inputText: "payload\n",
        inputSha256: "ef".repeat(32),
        deadline: performance.now() + 5_000,
      }),
      (error) => error.observation?.reason === "input-activation-pane-set-changed",
    );
    assert.equal(clickCount, clicksBeforePaneSetChurn);
    assert.equal(insertCount, insertsBeforePaneSetChurn);
    compositor = true;
    composedBodies = [otherBody, body];
    hitTarget = bodyHit;
    const clicksBeforeInputReplacement = clickCount;
    const insertsBeforeInputReplacement = insertCount;
    beforeHandleClick = () => {
      body.isConnected = false;
      composedBodies = [otherBody, replacementBody];
    };
    await assert.rejects(
      activate(
        [
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          afterInput,
        ],
        {
          inputText: "payload\n",
          inputSha256: "ef".repeat(32),
          deadline: performance.now() + 100,
        },
      ),
      (error) => error.observation?.reason === "trusted-pointer-actionability-timeout",
    );
    assert.equal(clickCount, clicksBeforeInputReplacement);
    assert.equal(insertCount, insertsBeforeInputReplacement, "replacement must receive no input");
    body.isConnected = true;
    composedBodies = [otherBody, body];
    compositor = false;
    hitTarget = surface;
    const transientReady = await activate(
      [
        missingLifecycleBinding,
        requestBinding,
        requestBinding,
        requestBinding,
        requestBinding,
        requestBinding,
        afterInput,
      ],
      {
        inputText: "payload\n",
        inputSha256: "ef".repeat(32),
        deadline: performance.now() + 5_000,
      },
    );
    assert.equal(transientReady.requestHmac, requestHmac);
    let clicksBeforeInputPreconditionFailures = clickCount;
    let insertsBeforeInputPreconditionFailures = insertCount;
    await assert.rejects(
      activate([requestBinding, changedLifecycleHmacBinding], {
        inputText: "payload\n",
        inputSha256: "ef".repeat(32),
        deadline: performance.now() + 100,
      }),
      (error) => error.observation?.reason === "input-activation-request-changed",
    );
    const advancedReceiptBinding = {
      ...requestBinding,
      runtimeReplacement: { ...requestBinding.runtimeReplacement, inputReceiptCount: 2 },
    };
    await assert.rejects(
      activate([advancedReceiptBinding, requestBinding], {
        inputText: "payload\n",
        inputSha256: "ef".repeat(32),
        deadline: performance.now() + 100,
      }),
      (error) => error.observation?.reason === "input-receipt-boundary-regressed",
    );
    const malformedDescriptorBinding = {
      ...requestBinding,
      runtimeReplacement: {
        ...requestBinding.runtimeReplacement,
        currentLifecycleRequest: {
          ...requestBinding.runtimeReplacement.currentLifecycleRequest,
          descriptorCount: 0,
        },
      },
    };
    await assert.rejects(
      activate([malformedDescriptorBinding], {
        inputText: "payload\n",
        inputSha256: "ef".repeat(32),
        deadline: performance.now() + 100,
      }),
      (error) => error.observation?.reason === "activation-lifecycle-invalid",
    );
    for (const malformedMissing of [
      {
        ...missingLifecycleBinding,
        runtimeReplacement: {
          ...missingLifecycleBinding.runtimeReplacement,
          currentLifecycleRequest: {
            ...missingLifecycleBinding.runtimeReplacement.currentLifecycleRequest,
            requestHmac: "aa".repeat(32),
          },
        },
      },
      {
        ...missingLifecycleBinding,
        runtimeReplacement: {
          ...missingLifecycleBinding.runtimeReplacement,
          currentLifecycleRequest: {
            ...missingLifecycleBinding.runtimeReplacement.currentLifecycleRequest,
            activeCount: 1,
            descriptorCount: 1,
          },
        },
      },
    ]) {
      await assert.rejects(
        activate([malformedMissing], {
          inputText: "payload\n",
          inputSha256: "ef".repeat(32),
          deadline: performance.now() + 100,
        }),
        (error) => error.observation?.reason === "activation-lifecycle-invalid",
      );
    }
    const duplicateDescriptorBinding = {
      ...requestBinding,
      runtimeReplacement: {
        ...requestBinding.runtimeReplacement,
        currentLifecycleRequest: {
          ...requestBinding.runtimeReplacement.currentLifecycleRequest,
          descriptorCount: 2,
        },
      },
    };
    await assert.rejects(
      activate([duplicateDescriptorBinding], {
        inputText: "payload\n",
        inputSha256: "ef".repeat(32),
        deadline: performance.now() + 100,
      }),
      (error) => error.observation?.reason === "activation-lifecycle-invalid",
    );
    const advancedBeforeClick = {
      ...requestBinding,
      runtimeReplacement: {
        ...requestBinding.runtimeReplacement,
        inputReceipts: [receipt],
        inputReceiptCount: 1,
      },
    };
    const clicksBeforeBoundaryAdvance = clickCount;
    const insertsBeforeBoundaryAdvance = insertCount;
    await assert.rejects(
      activate([requestBinding, requestBinding, advancedBeforeClick], {
        inputText: "payload\n",
        inputSha256: "ef".repeat(32),
        deadline: performance.now() + 100,
      }),
      (error) => error.observation?.reason === "activation-binding-unstable",
    );
    assert.equal(clickCount, clicksBeforeBoundaryAdvance);
    assert.equal(insertCount, insertsBeforeBoundaryAdvance);
    await assert.rejects(
      activate(
        [requestBinding, requestBinding, requestBinding, requestBinding, advancedBeforeClick],
        {
          inputText: "payload\n",
          inputSha256: "ef".repeat(32),
          deadline: performance.now() + 100,
        },
      ),
      (error) => error.observation?.reason === "pre-input-receipt-boundary-changed",
    );
    assert.equal(insertCount, insertsBeforeBoundaryAdvance);
    const insertsBeforeFinalFocusFence = insertCount;
    afterPreInsertObservation = () => {
      globalThis.document.activeElement = null;
    };
    await assert.rejects(
      activate(
        [
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          afterInput,
        ],
        {
          inputText: "payload\n",
          inputSha256: "ef".repeat(32),
          deadline: performance.now() + 100,
        },
      ),
      (error) => error.observation?.reason === "pre-input-focus-changed",
    );
    assert.equal(insertCount, insertsBeforeFinalFocusFence);
    globalThis.document.activeElement = textarea;
    const insertsBeforeDispatchGap = insertCount;
    const foreignTextarea = new TextAreaStub();
    foreignTextarea.value = "foreign-before";
    beforeKeyboardInsert = () => {
      dispatchBrowserEvent({ type: "focusout", node: textarea });
      globalThis.document.activeElement = foreignTextarea;
      dispatchBrowserEvent({ type: "focusin", node: globalThis.document.activeElement });
    };
    await assert.rejects(
      activate(
        [
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
        ],
        {
          inputText: "payload\n",
          inputSha256: "ef".repeat(32),
          deadline: performance.now() + 5_000,
        },
      ),
      (error) => {
        assert.equal(error.observation?.reason, "input-dispatch-rejected");
        assert.equal(error.observation?.inputGuardReason, "input-count-invalid");
        assert.deepEqual(error.observation?.inputGuardAxes, {
          beforeInputCount: 0,
          beforeInputCountOverflow: false,
          inputCount: 0,
          inputCountOverflow: false,
          eventCount: 1,
          eventCountOverflow: false,
          eventOverflow: false,
          mutationCount: 0,
          mutationCountOverflow: false,
          mutationOverflow: false,
          trusted: true,
          exactTarget: false,
          exactData: true,
          exactInputType: true,
          cancelableBeforeInput: true,
          restorationExact: true,
          rejected: true,
          currentExact: false,
          deadlineValid: true,
          settled: true,
        });
        return true;
      },
    );
    assert.equal(
      insertCount,
      insertsBeforeDispatchGap,
      "dispatch-window focus loss must block input",
    );
    assert.equal(foreignTextarea.value, "foreign-before");
    globalThis.document.activeElement = textarea;
    keyboardEventPlan = { beforeInputCount: 0 };
    beforeKeyboardInsert = () => {
      dispatchBrowserEvent({ type: "focusout", node: textarea });
      globalThis.document.activeElement = foreignTextarea;
      dispatchBrowserEvent({ type: "focusin", node: foreignTextarea });
    };
    await assert.rejects(
      activate(
        [
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
        ],
        {
          inputText: "payload\n",
          inputSha256: "ef".repeat(32),
          deadline: performance.now() + 5_000,
        },
      ),
      (error) => error.observation?.reason === "input-dispatch-rejected",
    );
    assert.equal(insertCount, insertsBeforeDispatchGap);
    assert.equal(
      foreignTextarea.value,
      "foreign-before",
      "a no-beforeinput foreign mutation must be restored before product input",
    );
    for (const foreign of [
      Object.assign(new TextAreaStub(), { value: "x".repeat(16_385) }),
      Object.assign(new TextAreaStub(), {
        value: "selection-before",
        throwOnSelectionRestore: true,
      }),
    ]) {
      globalThis.document.activeElement = textarea;
      keyboardEventPlan = { beforeInputCount: 0 };
      const beforeValue = foreign.value;
      beforeKeyboardInsert = () => {
        dispatchBrowserEvent({ type: "focusout", node: textarea });
        globalThis.document.activeElement = foreign;
        dispatchBrowserEvent({ type: "focusin", node: foreign });
      };
      await assert.rejects(
        activate(
          [
            requestBinding,
            requestBinding,
            requestBinding,
            requestBinding,
            requestBinding,
            requestBinding,
          ],
          {
            inputText: "payload\n",
            inputSha256: "ef".repeat(32),
            deadline: performance.now() + 5_000,
          },
        ),
        (error) => error.observation?.reason === "input-dispatch-rejected",
      );
      assert.equal(foreign.value, beforeValue);
      assert.equal(foreign.readOnly, false);
    }
    for (const plan of [
      { beforeInputCount: 2 },
      { beforeInputTrusted: false },
      { beforeInputCancelable: false },
      { beforeInputTarget: foreignTextarea },
      { beforeInputData: "wrong" },
      { beforeInputData: null },
      { inputCount: 0 },
      { inputData: "wrong" },
      { inputData: null },
    ]) {
      globalThis.document.activeElement = textarea;
      const textareaValue = textarea.value;
      keyboardEventPlan = plan;
      await assert.rejects(
        activate(
          [
            requestBinding,
            requestBinding,
            requestBinding,
            requestBinding,
            requestBinding,
            requestBinding,
          ],
          {
            inputText: "payload\n",
            inputSha256: "ef".repeat(32),
            deadline: performance.now() + 5_000,
          },
        ),
        (error) => error.observation?.reason === "input-dispatch-rejected",
      );
      assert.equal(insertCount, insertsBeforeDispatchGap);
      assert.equal(textarea.value, textareaValue);
    }
    globalThis.document.activeElement = textarea;
    keyboardEventPlan = { inputCount: 2 };
    const downstreamBeforeDuplicate = downstreamInputCount;
    await assert.rejects(
      activate(
        [
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
        ],
        {
          inputText: "payload\n",
          inputSha256: "ef".repeat(32),
          deadline: performance.now() + 5_000,
        },
      ),
      (error) => error.observation?.reason === "input-dispatch-rejected",
    );
    assert.equal(
      downstreamInputCount,
      downstreamBeforeDuplicate + 1,
      "the synthetic duplicate adversary must expose the irreversible first downstream event",
    );
    globalThis.document.activeElement = textarea;
    beforeKeyboardInsert = () => {
      surface.phase = "stale";
      recordIdentityMutation(surface, [], [], {
        type: "attributes",
        attributeName: "data-phase",
        oldValue: "connected",
      });
      deliverIdentityMutations();
      surface.phase = "connected";
      recordIdentityMutation(surface, [], [], {
        type: "attributes",
        attributeName: "data-phase",
        oldValue: "stale",
      });
      deliverIdentityMutations();
    };
    await assert.rejects(
      activate(
        [
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
        ],
        {
          inputText: "payload\n",
          inputSha256: "ef".repeat(32),
          deadline: performance.now() + 5_000,
        },
      ),
      (error) => error.observation?.reason === "input-dispatch-rejected",
    );
    assert.equal(insertCount, insertsBeforeDispatchGap, "restored topology churn must block input");
    clicksBeforeInputPreconditionFailures = clickCount;
    insertsBeforeInputPreconditionFailures = insertCount;
    await assert.rejects(
      activate([requestBinding, { ...requestBinding, generation: "g2" }], {
        inputText: "payload\n",
        inputSha256: "ef".repeat(32),
        deadline: performance.now() + 100,
      }),
      (error) => error.observation?.reason === "input-activation-binding-changed",
    );
    assert.equal(clickCount, clicksBeforeInputPreconditionFailures);
    assert.equal(insertCount, insertsBeforeInputPreconditionFailures);
    const inserted = await activate(
      [requestBinding, requestBinding, requestBinding, requestBinding, requestBinding, afterInput],
      {
        inputText: "payload\n",
        inputSha256: "ef".repeat(32),
        deadline: performance.now() + 5_000,
      },
    );
    assert.equal(inserted.authorityClientId, "web-a");
    assert.equal(inserted.requestHmac, requestHmac);
    const insertsBeforeMultiPane = insertCount;
    physicalBinding.semanticPaneIds = ["pane-a", "pane-b"];
    const multiPaneRequestBinding = {
      ...requestBinding,
      runtimeReplacement: {
        ...requestBinding.runtimeReplacement,
        currentLifecycleRequest: {
          ...requestBinding.runtimeReplacement.currentLifecycleRequest,
          paneSetHmac: paneSetHmac(["pane-a", "pane-b"]),
        },
      },
    };
    const multiPaneInserted = await activate(
      [
        multiPaneRequestBinding,
        multiPaneRequestBinding,
        multiPaneRequestBinding,
        multiPaneRequestBinding,
        multiPaneRequestBinding,
      ],
      {
        inputText: "payload\n",
        inputSha256: "ef".repeat(32),
        deadline: performance.now() + 5_000,
      },
    );
    assert.equal(multiPaneInserted.authorityClientId, "web-a");
    assert.equal(
      insertCount,
      insertsBeforeMultiPane + 1,
      "the exact full physical pane inventory must admit one input",
    );
    for (const paneIds of [
      ["pane-b", "pane-foreign"],
      ["pane-a"],
      ["pane-b", "pane-b"],
      ["pane-b", "pane-a"],
      ["pane-b", 7],
      ["", "pane-b"],
      ["pane b", "pane-b"],
      ["pane-b", "pane\0foreign"],
      ["__proto__", "pane-b"],
      ["pane-b", "terminal.discovered.foreign"],
      ["pane-b", "päné"],
      ["pane-b", `p${"x".repeat(128)}`],
      ["pane-b", "x".repeat(513)],
      [],
      [
        ...Array.from({ length: 64 }, (_, index) => `pane-${String(index).padStart(2, "0")}`),
        "pane-b",
      ].sort(),
    ]) {
      const insertsBeforeInvalidPaneSet = insertCount;
      physicalBinding.semanticPaneIds = paneIds;
      await assert.rejects(
        activate(
          [
            multiPaneRequestBinding,
            multiPaneRequestBinding,
            multiPaneRequestBinding,
            multiPaneRequestBinding,
            multiPaneRequestBinding,
          ],
          {
            inputText: "payload\n",
            inputSha256: "ef".repeat(32),
            deadline: performance.now() + 5_000,
          },
        ),
        (error) =>
          error.observation?.reason === "input-receipt-invalid" &&
          error.observation?.inputReceiptStartAxes?.status === "initial-invalid" &&
          (error.observation?.inputReceiptStartAxes?.initial?.bindingPaneExact === false ||
            error.observation?.inputReceiptStartAxes?.initial?.bindingPaneSetHmacExact === false),
      );
      assert.equal(insertCount, insertsBeforeInvalidPaneSet);
    }
    physicalBinding.semanticPaneIds = ["pane-b"];
    const closesBeforeHungReceiptWaiter = exactPageCloseCount;
    receiptWaiterAwaitNeverSettles = true;
    await assert.rejects(
      activate([requestBinding, requestBinding, requestBinding, requestBinding, requestBinding], {
        inputText: "payload\n",
        inputSha256: "ef".repeat(32),
        deadline: performance.now() + 4_500,
      }),
      (error) => error.observation?.reason === "input-receipt-timeout",
    );
    assert.equal(exactPageCloseCount, closesBeforeHungReceiptWaiter + 1);
    assert.equal(receiptWaiterBlockedResolvers.length, 0);
    exactPageClosed = false;
    const disposedBeforeRejectedClose = disposedHandleCount;
    exactPageCloseFailure = new Error("exact page close rejected");
    receiptWaiterAwaitNeverSettles = true;
    await assert.rejects(
      activate([requestBinding, requestBinding, requestBinding, requestBinding, requestBinding], {
        inputText: "payload\n",
        inputSha256: "ef".repeat(32),
        deadline: performance.now() + 4_500,
      }),
      (error) => error.observation?.reason === "input-receipt-timeout",
    );
    exactPageCloseFailure = null;
    receiptWaiterAwaitNeverSettles = false;
    receiptWaiterRendererBlocked = false;
    for (const resolveWaiter of receiptWaiterBlockedResolvers) resolveWaiter(null);
    receiptWaiterBlockedResolvers = [];
    await new Promise((resolveWait) => setImmediate(resolveWait));
    await new Promise((resolveWait) => setImmediate(resolveWait));
    assert.ok(
      disposedHandleCount > disposedBeforeRejectedClose,
      "late waiter settlement must dispose handles after an exact page-close rejection",
    );
    for (const [field, changedSnapshot] of [
      ["clientGenerationExact", { ...requestBinding.workspaceEvidence, generation: 8 }],
      [
        "targetExact",
        {
          ...requestBinding.workspaceEvidence,
          target: { ...requestBinding.workspaceEvidence.target, session: "session-b" },
        },
      ],
    ]) {
      inputReceiptPlan = { workspaceSnapshot: changedSnapshot };
      await assert.rejects(
        activate([requestBinding, requestBinding, requestBinding, requestBinding, requestBinding], {
          inputText: "payload\n",
          inputSha256: "ef".repeat(32),
          deadline: performance.now() + 5_000,
        }),
        (error) =>
          error.observation?.reason === "input-receipt-invalid" &&
          error.observation?.inputReceiptAxes?.[field] === false,
      );
    }
    inputReceiptPlan = { receipts: [receipt, { ...receipt }] };
    await assert.rejects(
      activate([requestBinding, requestBinding, requestBinding, requestBinding, requestBinding], {
        inputText: "payload\n",
        inputSha256: "ef".repeat(32),
        deadline: performance.now() + 5_000,
      }),
      (error) =>
        error.observation?.reason === "input-receipt-invalid" &&
        error.observation?.inputReceiptAxes?.candidateCount === 2,
    );
    inputReceiptPlan = {
      operationCount: 65,
      operations: Array.from({ length: 64 }, (_, index) => ({
        physicalEpoch: 1,
        generation: daemonGeneration,
        lifecycleRequestId: "request-a",
        authorityRequestId: null,
        clientId: "web-a",
        pane: "pane-b",
        seq: null,
        stage: "xterm-enqueue",
        outcome: "ok",
        ordinal: index + 1,
      })),
    };
    await assert.rejects(
      activate([requestBinding, requestBinding, requestBinding, requestBinding, requestBinding], {
        inputText: "payload\n",
        inputSha256: "ef".repeat(32),
        deadline: performance.now() + 5_000,
      }),
      (error) =>
        error.observation?.reason === "input-receipt-invalid" &&
        error.observation?.inputReceiptAxes?.operationOverflow === true,
    );
    const splicedOperations = [
      ["xterm-enqueue", "ok", null, null, "pane-b"],
      ["surface-write", "attempt", null, null, "pane-b"],
      ["authority-request", "attempt", "authority-a", null, null],
      ["authority-request", "sent", "authority-a", null, null],
      ["authority-result", "granted", "authority-b", null, null],
    ].map(([stage, outcome, authorityRequestId, seq, pane], ordinal) => ({
      physicalEpoch: 1,
      generation: daemonGeneration,
      lifecycleRequestId: "request-a",
      authorityRequestId,
      clientId: "web-a",
      pane,
      seq,
      stage,
      outcome,
      ordinal,
    }));
    inputReceiptPlan = {
      operationCount: splicedOperations.length,
      operations: splicedOperations,
    };
    await assert.rejects(
      activate([requestBinding, requestBinding, requestBinding, requestBinding, requestBinding], {
        inputText: "payload\n",
        inputSha256: "ef".repeat(32),
        deadline: performance.now() + 5_000,
      }),
      (error) =>
        error.observation?.reason === "input-receipt-invalid" &&
        error.observation?.inputReceiptAxes?.operationOverflow === true,
    );
    for (const tokens of [
      [
        ["xterm-enqueue", "ok"],
        ["surface-write", "attempt"],
        ["surface-write", "ok"],
      ],
      [
        ["xterm-enqueue", "ok"],
        ["surface-write", "attempt"],
        ["authority-request", "attempt"],
        ["authority-request", "sent"],
        ["authority-request", "send-failed"],
      ],
      [
        ["xterm-enqueue", "ok"],
        ["surface-write", "attempt"],
        ["authority-request", "attempt"],
        ["authority-request", "sent"],
        ["authority-result", "granted"],
        ["authority-result", "rejected"],
      ],
      [
        ["xterm-enqueue", "ok"],
        ["surface-write", "attempt"],
        ["input-send", "attempt"],
        ["input-send", "sent"],
        ["input-ack", "ok"],
        ["input-ack", "ack-timeout"],
      ],
    ]) {
      const operations = tokens.map(([stage, outcome], ordinal) => ({
        physicalEpoch: 1,
        generation: daemonGeneration,
        lifecycleRequestId: "request-a",
        authorityRequestId: stage.startsWith("authority-") ? "authority-a" : null,
        clientId: "web-a",
        pane: stage.startsWith("authority-") ? null : "pane-b",
        seq: ["input-send", "input-ack", "receipt-published"].includes(stage) ? 1 : null,
        stage,
        outcome,
        ordinal,
      }));
      inputReceiptPlan = { operationCount: operations.length, operations };
      await assert.rejects(
        activate([requestBinding, requestBinding, requestBinding, requestBinding, requestBinding], {
          inputText: "payload\n",
          inputSha256: "ef".repeat(32),
          deadline: performance.now() + 5_000,
        }),
        (error) =>
          error.observation?.reason === "input-receipt-invalid" &&
          error.observation?.inputReceiptAxes?.operationOverflow === true,
      );
    }
    const lostAuthorityAfterAck = [
      ["xterm-enqueue", "ok"],
      ["surface-write", "attempt"],
      ["input-send", "attempt"],
      ["input-send", "sent"],
      ["input-ack", "ok"],
      ["surface-write", "failed"],
    ].map(([stage, outcome], ordinal) => ({
      physicalEpoch: 1,
      generation: daemonGeneration,
      lifecycleRequestId: "request-a",
      authorityRequestId: null,
      clientId: "web-a",
      pane: "pane-b",
      seq: ["input-send", "input-ack"].includes(stage) ? 1 : null,
      stage,
      outcome,
      ordinal,
    }));
    inputReceiptPlan = {
      count: 0,
      receipts: [],
      operationCount: lostAuthorityAfterAck.length,
      operations: lostAuthorityAfterAck,
    };
    await assert.rejects(
      activate([requestBinding, requestBinding, requestBinding, requestBinding, requestBinding], {
        inputText: "payload\n",
        inputSha256: "ef".repeat(32),
        deadline: performance.now() + 5_000,
      }),
      (error) =>
        error.observation?.reason === "input-receipt-invalid" &&
        error.observation?.inputReceiptAxes?.operationOverflow === false &&
        error.observation?.inputReceiptAxes?.operationTail?.at(-1)?.stage === "surface-write",
    );
    const gappedAfterInput = {
      ...afterInput,
      runtimeReplacement: {
        ...afterInput.runtimeReplacement,
        inputReceipts: [{ ...receipt, ordinal: 1 }],
        inputReceiptCount: 2,
      },
    };
    inputReceiptPlan = {
      count: 2,
      receipts: [{ ...receipt, ordinal: 1 }],
    };
    await assert.rejects(
      activate(
        [
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          gappedAfterInput,
        ],
        {
          inputText: "payload\n",
          inputSha256: "ef".repeat(32),
          deadline: performance.now() + 5_000,
        },
      ),
      (error) =>
        error.observation?.reason === "input-receipt-invalid" &&
        error.observation?.inputReceiptAxes?.countAdvanced === true,
    );
    const priorReceiptBoundary = {
      ...requestBinding,
      runtimeReplacement: {
        ...requestBinding.runtimeReplacement,
        inputReceipts: [receipt],
        inputReceiptCount: 1,
      },
    };
    const priorOnlyAfterInput = {
      ...priorReceiptBoundary,
      runtimeReplacement: {
        ...priorReceiptBoundary.runtimeReplacement,
        inputReceiptCount: 2,
      },
    };
    inputReceiptPlan = {
      count: 2,
      receipts: [receipt],
    };
    await assert.rejects(
      activate(
        [
          priorReceiptBoundary,
          priorReceiptBoundary,
          priorReceiptBoundary,
          priorReceiptBoundary,
          priorReceiptBoundary,
          priorOnlyAfterInput,
        ],
        {
          inputText: "payload\n",
          inputSha256: "ef".repeat(32),
          deadline: performance.now() + 5_000,
        },
      ),
      (error) => error.observation?.reason === "input-receipt-invalid",
    );
    clearFocusDuringInsert = true;
    await assert.rejects(
      activate(
        [
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          afterInput,
        ],
        {
          inputText: "payload\n",
          inputSha256: "ef".repeat(32),
          deadline: performance.now() + 5_000,
        },
      ),
      (error) => error.observation?.reason === "input-dispatch-rejected",
    );
    clearFocusDuringInsert = false;
    inputReceiptPlan = {
      binding: { ...physicalBinding, generation: "660e8400-e29b-41d4-a716-446655440000" },
    };
    await assert.rejects(
      activate(
        [
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          { ...afterInput, generation: "g2" },
        ],
        {
          inputText: "payload\n",
          inputSha256: "ef".repeat(32),
          deadline: performance.now() + 5_000,
        },
      ),
      (error) =>
        error.observation?.reason === "input-receipt-invalid" &&
        error.observation?.inputReceiptAxes?.bindingExact === false,
    );
    await assert.rejects(
      activateCard5ExactTerminalSurface({
        mode: "focus",
        page,
        keyHex: "ab".repeat(32),
        processIdentity: "chromium:1",
        expectedPane: "pane-b",
        expectedPaneHmac: "cd".repeat(32),
        deadline: performance.now() + 5,
        observeAuthorityReceipt: () => new Promise(() => {}),
      }),
      (error) => error.observation?.reason === "authority-observation-timeout",
    );
    assert.ok(disposedHandleCount > 0, "every latched surface/target handle must be disposed");
    clickBlockMs = 10;
    await assert.rejects(
      activate([binding, binding, binding], { deadline: performance.now() + 20 }),
      (error) => error.observation?.reason === "trusted-pointer-deadline",
    );
    clickBlockMs = 0;
    insertBlockMs = 60;
    await assert.rejects(
      activate(
        [
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          afterInput,
        ],
        {
          inputText: "payload\n",
          inputSha256: "ef".repeat(32),
          deadline: performance.now() + 50,
        },
      ),
      (error) => error.observation?.reason === "input-product-path-reserve-insufficient",
    );
    insertBlockMs = 0;
    const downstreamBeforeLateDispatch = downstreamInputCount;
    insertDispatchDelayMs = 120;
    await assert.rejects(
      activate(
        [
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
        ],
        {
          inputText: "payload\n",
          inputSha256: "ef".repeat(32),
          deadline: performance.now() + 80,
        },
      ),
      (error) => error.observation?.reason === "input-product-path-reserve-insufficient",
    );
    insertDispatchDelayMs = 0;
    assert.equal(downstreamInputCount, downstreamBeforeLateDispatch);
    assert.equal(documentCaptureListeners.size, 0);
    assert.equal(mutationObservers.size, 0);
    const downstreamBeforeDelayedGuardArm = downstreamInputCount;
    exactPageClosed = false;
    inputGuardArmRequestDelayMs = 60;
    insertDispatchDelayMs = 165;
    await assert.rejects(
      activate(
        [
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
        ],
        {
          inputText: "payload\n",
          inputSha256: "ef".repeat(32),
          deadline: performance.now() + 220,
        },
      ),
      (error) => error.observation?.reason === "input-product-path-reserve-insufficient",
    );
    inputGuardArmRequestDelayMs = 0;
    insertDispatchDelayMs = 0;
    assert.equal(
      downstreamInputCount,
      downstreamBeforeDelayedGuardArm,
      "a dispatch after the Node deadline must be blocked despite delayed guard-arm IPC",
    );
    assert.equal(documentCaptureListeners.size, 0);
    assert.equal(mutationObservers.size, 0);
    const closesBeforeNeverSettlingInsert = exactPageCloseCount;
    exactPageClosed = false;
    insertNeverSettles = true;
    await assert.rejects(
      activate(
        [
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
          requestBinding,
        ],
        {
          inputText: "payload\n",
          inputSha256: "ef".repeat(32),
          deadline: performance.now() + 80,
        },
      ),
      (error) => error.observation?.reason === "input-product-path-reserve-insufficient",
    );
    insertNeverSettles = false;
    assert.equal(exactPageCloseCount, closesBeforeNeverSettlingInsert);
    assert.equal(documentCaptureListeners.size, 0);
    assert.equal(mutationObservers.size, 0);
    exactPageClosed = false;
    await assert.rejects(
      activateCard5ExactTerminalSurface({
        mode: "focus",
        page,
        keyHex: "ab".repeat(32),
        processIdentity: "chromium:1",
        expectedPane: "pane-b",
        expectedPaneHmac: "cd".repeat(32),
        deadline: performance.now() + 5,
        observeAuthorityReceipt: () => {
          const blockedUntil = performance.now() + 10;
          while (performance.now() < blockedUntil) {
            // Deliberately resolve after the absolute deadline before timers can run.
          }
          return binding;
        },
      }),
      (error) => error.observation?.reason === "authority-observation-timeout",
    );
    const disposedBeforeLateSurfaces = disposedHandleCount;
    elementHandlesDelayMs = 20;
    await assert.rejects(
      activate([binding, binding], { deadline: performance.now() + 5 }),
      (error) => error.observation?.reason === "surface-observation-timeout",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(
      disposedHandleCount > disposedBeforeLateSurfaces,
      "surface handles resolving after timeout must be consumed and disposed",
    );
    elementHandlesDelayMs = 0;
    const disposedBeforeLateEvaluate = disposedHandleCount;
    evaluateHandleCallCount = 0;
    evaluateHandleDelayMs = 20;
    await assert.rejects(
      activate([binding, binding], { deadline: performance.now() + 5 }),
      (error) => error.observation?.reason === "surface-observation-timeout",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(evaluateHandleCallCount > 0);
    assert.ok(
      disposedHandleCount > disposedBeforeLateEvaluate,
      "evaluateHandle results resolving after timeout must be consumed and disposed",
    );
    evaluateHandleDelayMs = 0;
    assert.equal(documentCaptureListeners.size, 0, "every input guard listener must be removed");
    assert.equal(mutationObservers.size, 0, "every input guard observer must be disconnected");
  } finally {
    globalThis.document = previous.document;
    globalThis.Element = previous.Element;
    globalThis.HTMLElement = previous.HTMLElement;
    globalThis.HTMLTextAreaElement = previous.HTMLTextAreaElement;
    globalThis.Node = previous.Node;
    globalThis.MutationObserver = previous.MutationObserver;
    globalThis.getComputedStyle = previous.getComputedStyle;
    globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ = previous.envelopeEvidence;
    globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__ = previous.workspaceEvidence;
    globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__ = previous.qualifiedTerminal;
  }
});

test("the pinned Chromium insertText route emits one trusted beforeinput and one input", async (t) => {
  const { chromium } = await import(
    new URL("../../apps/desktop-renderer/node_modules/playwright/index.mjs", import.meta.url)
  );
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent("<textarea id='target'></textarea>");
  await page.locator("#target").focus();
  await page.evaluate(() => {
    const target = globalThis.document.querySelector("#target");
    globalThis.__card5PinnedInsertEvents = [];
    for (const type of ["beforeinput", "input"]) {
      target.addEventListener(type, (event) => {
        globalThis.__card5PinnedInsertEvents.push({
          type,
          trusted: event.isTrusted,
          cancelable: event.cancelable,
          inputType: event.inputType,
          data: event.data,
        });
      });
    }
  });
  await page.keyboard.insertText("card5-pinned-input");
  assert.deepEqual(await page.evaluate(() => globalThis.__card5PinnedInsertEvents), [
    {
      type: "beforeinput",
      trusted: true,
      cancelable: true,
      inputType: "insertText",
      data: "card5-pinned-input",
    },
    {
      type: "input",
      trusted: true,
      cancelable: false,
      inputType: "insertText",
      data: "card5-pinned-input",
    },
  ]);
  const playwrightInputSource = readFileSync(
    new URL(
      "../../node_modules/.pnpm/playwright-core@1.59.1/node_modules/playwright-core/lib/server/input.js",
      import.meta.url,
    ),
    "utf8",
  );
  const chromiumInputSource = readFileSync(
    new URL(
      "../../node_modules/.pnpm/playwright-core@1.59.1/node_modules/playwright-core/lib/server/chromium/crInput.js",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    playwrightInputSource,
    /async _insertText\(progress, text\) \{\s*await this\._raw\.sendText\(progress, text\);/u,
  );
  assert.match(
    chromiumInputSource,
    /async sendText\(progress, text\) \{\s*await progress\.race\(this\._client\.send\("Input\.insertText", \{ text \}\)\);/u,
  );
});

test("the pinned Chromium insertText route emits one exact xterm marker-only input", async (t) => {
  const { chromium } = await import(
    new URL("../../apps/desktop-renderer/node_modules/playwright/index.mjs", import.meta.url)
  );
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent("<div id='terminal' style='width:800px;height:400px'></div>");
  await page.addStyleTag({
    path: new URL(
      "../../node_modules/.pnpm/@xterm+xterm@6.0.0/node_modules/@xterm/xterm/css/xterm.css",
      import.meta.url,
    ).pathname,
  });
  await page.addScriptTag({
    path: new URL(
      "../../node_modules/.pnpm/@xterm+xterm@6.0.0/node_modules/@xterm/xterm/lib/xterm.js",
      import.meta.url,
    ).pathname,
  });
  await page.evaluate(() => {
    const terminal = new globalThis.Terminal();
    terminal.open(globalThis.document.querySelector("#terminal"));
    globalThis.__card5PinnedXtermData = [];
    terminal.onData((data) => globalThis.__card5PinnedXtermData.push(data));
    terminal.focus();
    const target = globalThis.document.querySelector(".xterm-helper-textarea");
    globalThis.__card5PinnedXtermEvents = [];
    for (const type of ["beforeinput", "input"]) {
      target.addEventListener(
        type,
        (event) => {
          globalThis.__card5PinnedXtermEvents.push({
            type,
            trusted: event.isTrusted,
            cancelable: event.cancelable,
            inputType: event.inputType,
            data: event.data,
          });
        },
        true,
      );
    }
  });
  const marker = "CARD5_HANDOFF_1_0123abcd";
  await page.keyboard.insertText(marker);
  assert.deepEqual(await page.evaluate(() => globalThis.__card5PinnedXtermEvents), [
    {
      type: "beforeinput",
      trusted: true,
      cancelable: true,
      inputType: "insertText",
      data: marker,
    },
    {
      type: "input",
      trusted: true,
      cancelable: false,
      inputType: "insertText",
      data: marker,
    },
  ]);
  assert.deepEqual(await page.evaluate(() => globalThis.__card5PinnedXtermData), [marker]);
});

test("the pinned Chromium insertText route exposes real xterm marker-newline composition", async (t) => {
  const { chromium } = await import(
    new URL("../../apps/desktop-renderer/node_modules/playwright/index.mjs", import.meta.url)
  );
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent("<div id='terminal' style='width:800px;height:400px'></div>");
  await page.addStyleTag({
    path: new URL(
      "../../node_modules/.pnpm/@xterm+xterm@6.0.0/node_modules/@xterm/xterm/css/xterm.css",
      import.meta.url,
    ).pathname,
  });
  await page.addScriptTag({
    path: new URL(
      "../../node_modules/.pnpm/@xterm+xterm@6.0.0/node_modules/@xterm/xterm/lib/xterm.js",
      import.meta.url,
    ).pathname,
  });
  await page.evaluate(() => {
    const terminal = new globalThis.Terminal();
    terminal.open(globalThis.document.querySelector("#terminal"));
    globalThis.__card5PinnedXtermData = [];
    terminal.onData((data) => globalThis.__card5PinnedXtermData.push(data));
    terminal.focus();
    const target = globalThis.document.querySelector(".xterm-helper-textarea");
    globalThis.__card5PinnedXtermEvents = [];
    for (const type of ["beforeinput", "input"]) {
      target.addEventListener(
        type,
        (event) => {
          globalThis.__card5PinnedXtermEvents.push({
            type,
            trusted: event.isTrusted,
            cancelable: event.cancelable,
            inputType: event.inputType,
            data: event.data,
          });
        },
        true,
      );
    }
  });
  const marker = "card5-pinned-marker\n";
  await page.keyboard.insertText(marker);
  assert.deepEqual(await page.evaluate(() => globalThis.__card5PinnedXtermEvents), [
    {
      type: "beforeinput",
      trusted: true,
      cancelable: true,
      inputType: "insertText",
      data: marker,
    },
    {
      type: "input",
      trusted: true,
      cancelable: false,
      inputType: "insertText",
      data: "card5-pinned-marker",
    },
    {
      type: "input",
      trusted: true,
      cancelable: false,
      inputType: "insertText",
      data: null,
    },
  ]);
  assert.deepEqual(await page.evaluate(() => globalThis.__card5PinnedXtermData), [
    "card5-pinned-marker",
  ]);
});

test("predecessor issuance is exact-generation and exact-pane bound", async () => {
  const expected = {
    workspaceName: "workspace-b",
    generation: "generation-g1",
    semanticPaneId: "pane-b",
  };
  const issuedRequest = [];
  let descriptor = {
    protocolVersion: 1,
    webSocketUrl: "ws://127.0.0.1/predecessor",
    redemptionTicket: "private-ticket",
    daemonInstanceId: expected.generation,
    requestId: "request-predecessor",
    expiresAt: Date.now() + 1_000,
    panes: [expected.semanticPaneId],
    effectiveViewerMode: "read-only",
  };
  const page = {
    evaluate: async (callback, value) => {
      const previousHost = globalThis.tmuxIdeHost;
      globalThis.tmuxIdeHost = {
        daemon: {
          fetchApplicationShell: async ({ workspaceName }) => {
            assert.equal(workspaceName, expected.workspaceName);
            return {
              status: "ok",
              envelope: {
                resource: {
                  terminalInventory: {
                    resources: [
                      {
                        attachability: {
                          status: "available",
                          semanticPaneId: expected.semanticPaneId,
                        },
                      },
                    ],
                  },
                },
              },
            };
          },
          issuePaneStream: async (request) => {
            issuedRequest.push(request);
            return { status: "issued", descriptor };
          },
        },
      };
      try {
        return await callback(value);
      } finally {
        globalThis.tmuxIdeHost = previousHost;
      }
    },
  };
  assert.equal(await issueCard5PredecessorDescriptor(page, expected), descriptor);
  assert.deepEqual(issuedRequest, [
    {
      protocolVersion: 1,
      workspaceName: expected.workspaceName,
      panes: [expected.semanticPaneId],
      viewerMode: "read-only",
    },
  ]);
  descriptor = { ...descriptor, daemonInstanceId: "generation-g2" };
  assert.equal(await issueCard5PredecessorDescriptor(page, expected), null);
  descriptor = { ...descriptor, daemonInstanceId: expected.generation, panes: ["other-pane"] };
  assert.equal(await issueCard5PredecessorDescriptor(page, expected), null);
  await assert.rejects(issueCard5PredecessorDescriptor(page, {}), /identity is malformed/u);
});

test("launch failure closes every owner created before the failure", async () => {
  const { input, events } = launchInput();
  input.electron.launch = async () => {
    throw new Error("electron launch failed");
  };
  await assert.rejects(launchCard5ProductionWebHosts(input), (error) => {
    assert.match(error.message, /electron launch failed/u);
    assert.deepEqual(error.observation, {
      operation: "card5-production-host-launch",
      reason: "host-unavailable",
      stage: "electron-launch",
      chromiumCreated: true,
      electronCreated: false,
    });
    return true;
  });
  assert.equal(
    events.filter(([host, operation]) => host === "chromium" && operation === "close").length,
    1,
  );
});

test("every staged acquisition/readiness error retires all resources acquired so far", async (t) => {
  const cases = [
    [
      "chromium-identity",
      ({ browser }) => {
        browser.newBrowserCDPSession = async () => {
          throw new Error("identity");
        };
      },
    ],
    [
      "chromium-context",
      ({ browser }) => {
        browser.newContext = async () => {
          throw new Error("context");
        };
      },
    ],
    [
      "chromium-readiness",
      ({ chromiumPage }) => {
        chromiumPage.goto = async () => {
          throw new Error("chromium readiness");
        };
      },
    ],
    [
      "electron-window",
      ({ electronApp }) => {
        electronApp.firstWindow = async () => {
          throw new Error("window");
        };
      },
    ],
    [
      "electron-readiness",
      ({ electronPage }) => {
        electronPage.locator = () => ({
          first: () => ({
            waitFor: async () => {
              throw new Error("electron readiness");
            },
          }),
          waitFor: async () => {
            throw new Error("electron readiness");
          },
        });
      },
    ],
  ];
  for (const [stage, arrange] of cases) {
    await t.test(stage, async () => {
      const harness = launchInput();
      arrange(harness);
      await assert.rejects(launchCard5ProductionWebHosts(harness.input), (error) => {
        assert.equal(error.observation.stage, stage);
        return true;
      });
      assert.equal(
        harness.events.filter(([host, operation]) => host === "chromium" && operation === "close")
          .length,
        1,
      );
      if (["electron-window", "electron-readiness"].includes(stage)) {
        assert.equal(
          harness.events.filter(([host, operation]) => host === "electron" && operation === "close")
            .length,
          1,
        );
      }
    });
  }
});

test("Electron readiness failure seals bounded leaf evidence before cleanup", async () => {
  const harness = launchInput();
  harness.electronPage.waitForFunction = async () => {
    harness.electronPage.emit("pageerror", new Error("private renderer content"));
    harness.electronPage.emit("crash");
    throw new Error("electron terminal readiness");
  };
  harness.electronPage.evaluate = async () => {
    harness.events.push(["electron", "readiness-observed"]);
    return {
      candidateCount: 2,
      candidateOverflow: 0,
      candidates: [
        {
          phase: "measuring",
          attachPhase: "waiting-for-viewport",
          attempt: 1,
          reason: "viewport-unavailable",
          visible: true,
          bbox: { width: 640, height: 360 },
          hasXterm: true,
          preservesFrame: false,
          sourceDimensions: "160x44",
          clientDimensions: null,
          workspaceHmac: "11".repeat(32),
          paneHmac: "22".repeat(32),
        },
      ],
      documentVisibility: "visible",
      activePanelPresent: true,
      shellPresent: true,
      bootstrapPhase: "connected",
      clientPhase: "live",
    };
  };
  await assert.rejects(launchCard5ProductionWebHosts(harness.input), (error) => {
    assert.equal(error.observation.stage, "electron-readiness");
    assert.equal(error.observation.electronReadiness.candidateCount, 2);
    assert.equal(error.observation.electronReadiness.candidates[0].reason, "viewport-unavailable");
    assert.equal(error.observation.electronReadiness.clientPhase, "live");
    assert.deepEqual(error.observation.electronReadiness.pageEvents, {
      pageErrorCount: 1,
      closeCount: 0,
      crashCount: 1,
      events: ["pageError", "crash"],
      eventOverflow: 0,
    });
    return true;
  });
  const observed = harness.events.findIndex(([, operation]) => operation === "readiness-observed");
  const closed = harness.events.findIndex(
    ([host, operation]) => host === "electron" && operation === "close",
  );
  assert.ok(observed >= 0 && closed > observed, "readiness evidence must precede cleanup");
});

test("Chromium readiness failure seals bounded leaf evidence before cleanup", async () => {
  const harness = launchInput();
  harness.chromiumPage.waitForFunction = async () => {
    for (let index = 0; index < 20; index += 1)
      harness.chromiumPage.emit("pageerror", new Error(`private renderer content ${index}`));
    harness.chromiumPage.emit("crash");
    throw new Error("chromium terminal readiness");
  };
  harness.chromiumPage.evaluate = async () => {
    harness.events.push(["chromium", "readiness-observed"]);
    return {
      probeInstalled: true,
      candidateCount: 1,
      candidateOverflow: 0,
      candidates: [
        {
          phase: "connecting",
          attachPhase: "transport-ready",
          failureCode: "none",
          attempt: 3,
          reason: "attachment-handle-pending",
          qualified: false,
          visible: true,
          bbox: { width: 640, height: 360 },
          hasXterm: true,
          preservesFrame: false,
          sourceDimensions: "160x44",
          clientDimensions: "160x44",
          workspaceHmac: "11".repeat(32),
          paneHmac: "22".repeat(32),
        },
      ],
      documentVisibility: "visible",
      activePanelPresent: true,
      shellPresent: true,
      bootstrapPhase: "connected",
      clientPhase: "loading",
      transport: {
        descriptorEventCount: 4,
        socketEventCount: 3,
        socketEventOverflow: 0,
        socketOutcomes: [],
        replacementCount: 0,
        predecessorAcceptedAfterReplacement: 0,
        reconnectOutcome: "issued-without-socket",
      },
    };
  };
  await assert.rejects(launchCard5ProductionWebHosts(harness.input), (error) => {
    assert.equal(error.message, "chromium terminal readiness");
    assert.equal(error.observation.stage, "chromium-readiness");
    assert.equal(error.observation.chromiumReadiness.probeInstalled, true);
    assert.equal(error.observation.chromiumReadiness.candidates[0].phase, "connecting");
    assert.equal(
      error.observation.chromiumReadiness.transport.reconnectOutcome,
      "issued-without-socket",
    );
    assert.deepEqual(error.observation.chromiumReadiness.pageEvents, {
      pageErrorCount: 20,
      closeCount: 0,
      crashCount: 1,
      events: Array.from({ length: 16 }, () => "pageError"),
      eventOverflow: 5,
    });
    return true;
  });
  assert.equal(
    harness.events.some(([host, operation]) => host === "electron" && operation === "launch"),
    false,
  );
  const observed = harness.events.findIndex(([, operation]) => operation === "readiness-observed");
  const closed = harness.events.findIndex(
    ([host, operation]) => host === "chromium" && operation === "close",
  );
  assert.ok(observed >= 0 && closed > observed, "readiness evidence must precede cleanup");
});

test("hung Chromium evidence capture times out without replacing the original error or cleanup", async (t) => {
  for (const lateOutcome of ["resolve", "reject"]) {
    await t.test(lateOutcome, async () => {
      let settleDiagnostic;
      const diagnostic = new Promise((resolve, reject) => {
        settleDiagnostic = lateOutcome === "resolve" ? () => resolve({ private: true }) : reject;
      });
      let expireDiagnostic;
      const harness = launchInput({
        cleanupRuntime: {
          readinessObservationTimeoutMs: 1_000,
          scheduleReadinessObservationTimeout: (callback, milliseconds) => {
            assert.equal(milliseconds, 1_000);
            expireDiagnostic = callback;
            return () => undefined;
          },
        },
      });
      const original = new Error("original chromium readiness failure");
      harness.chromiumPage.waitForFunction = async () => {
        throw original;
      };
      harness.chromiumPage.evaluate = async () => await diagnostic;
      const lease = createCard5ProductionWebHostLease(harness.input);
      for (let turn = 0; turn < 100 && !expireDiagnostic; turn += 1)
        await new Promise((resolve) => setImmediate(resolve));
      assert.equal(typeof expireDiagnostic, "function");
      expireDiagnostic();
      let observation;
      await assert.rejects(lease.ready, (error) => {
        assert.equal(error, original);
        observation = error.observation.chromiumReadiness;
        assert.equal(observation.readReason, "read-timeout");
        assert.equal(observation.transport.reconnectOutcome, "unknown");
        assert.deepEqual(observation.transport.socketOutcomes, []);
        assert.equal(Object.isFrozen(observation), true);
        return true;
      });
      const serialized = JSON.stringify(observation);
      if (lateOutcome === "resolve") settleDiagnostic();
      else settleDiagnostic(new Error("late private diagnostic rejection"));
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(JSON.stringify(observation), serialized);
      assert.equal(
        harness.events.filter(([host, operation]) => host === "chromium" && operation === "close")
          .length,
        1,
      );
      assert.equal((await lease.close()).chromiumRetired, true);
    });
  }
});

test("Electron readiness projection applies production whitelists and candidate caps", async () => {
  const harness = launchInput();
  harness.electronPage.waitForFunction = async () => {
    throw new Error("electron terminal readiness");
  };
  harness.electronPage.evaluate = async (callback, value) => {
    const candidates = Array.from({ length: 70 }, (_, index) => ({
      getAttribute: (name) => {
        if (name === "data-phase") return index === 0 ? "invented-phase" : "connecting";
        if (name === "data-attach-phase")
          return index === 0 ? "invented-attach" : "transport-ready";
        if (name === "data-attach-failure-code")
          return index === 0 ? "private-unbounded-error" : "geometry-authority-conflict";
        if (name === "data-attach-attempt") return index === 0 ? "9999999999" : null;
        return null;
      },
      getBoundingClientRect: () =>
        index === 0
          ? { width: Number.NaN, height: Number.POSITIVE_INFINITY }
          : { width: 1, height: 1 },
      getClientRects: () => [],
      querySelector: () => null,
    }));
    const panel = { querySelectorAll: () => candidates };
    const app = { getAttribute: (name) => (name === "data-shell-source" ? "runtime" : null) };
    const previous = {
      document: globalThis.document,
      getComputedStyle: globalThis.getComputedStyle,
      resolver: globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__,
      workspace: globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__,
      envelope: globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__,
    };
    globalThis.document = {
      visibilityState: "visible",
      querySelector: (selector) =>
        selector === value.panelSelector ? panel : selector === ".app" ? app : null,
      querySelectorAll: () => [],
    };
    globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });
    globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__ = () => null;
    globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__ = () => ({ snapshot: { phase: "invented" } });
    globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ = () => ({
      socketEvents: Array.from({ length: 18 }, (_, index) => ({
        generation: `generation-${index}`,
        outcome: index === 17 ? "invented" : index % 2 === 0 ? "open" : "closed",
        ordinal: index,
      })),
      socketEventCount: 20,
      lifecycleEvents: Array.from({ length: 70 }, (_, index) => ({
        generation: `generation-${index}`,
        requestId: `private-request-${index}`,
        stage: index === 69 ? "invented-stage" : index % 2 === 0 ? "issued" : "terminal",
        code: index === 69 ? "PRIVATE REASON" : index % 2 === 0 ? "none" : "topology-changed",
        origin: index === 69 ? "invented-origin" : index % 2 === 0 ? "client" : "peer",
        closeCode: index % 2 === 0 ? null : 1012,
        closeReason: index === 69 ? "PRIVATE REASON" : "topology-changed",
        ordinal: index,
      })),
      lifecycleEventCount: 72,
      descriptorEventCount: 59,
      replacementCount: 1,
      predecessorAcceptedAfterReplacement: 0,
    });
    try {
      return await callback(value);
    } finally {
      globalThis.document = previous.document;
      globalThis.getComputedStyle = previous.getComputedStyle;
      globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__ = previous.resolver;
      globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__ = previous.workspace;
      globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ = previous.envelope;
    }
  };
  await assert.rejects(launchCard5ProductionWebHosts(harness.input), (error) => {
    const readiness = error.observation.electronReadiness;
    assert.equal(readiness.candidateCount, 70);
    assert.equal(readiness.candidateOverflow, 6);
    assert.equal(readiness.candidates.length, 64);
    assert.equal(readiness.candidates[0].phase, "unknown");
    assert.equal(readiness.candidates[0].attachPhase, "unknown");
    assert.equal(readiness.candidates[0].failureCode, "unknown");
    assert.equal(readiness.candidates[1].failureCode, "geometry-authority-conflict");
    assert.equal(readiness.candidates[0].attempt, 0xffff);
    assert.deepEqual(readiness.candidates[0].bbox, { width: null, height: null });
    assert.equal(readiness.clientPhase, "unknown");
    assert.equal(readiness.probeInstalled, true);
    assert.equal(readiness.transport.socketOutcomes.length, 16);
    assert.equal(readiness.transport.socketEventOverflow, 4);
    assert.equal(readiness.transport.socketOutcomes.at(-1).outcome, "unknown");
    assert.match(readiness.transport.socketOutcomes[0].generationHmac, /^[0-9a-f]{64}$/u);
    assert.equal(readiness.transport.reconnectOutcome, "replacement-observed");
    assert.equal(readiness.transport.lifecycle.length, 64);
    assert.equal(readiness.transport.lifecycleEventOverflow, 8);
    assert.equal(readiness.transport.lifecycle.at(-1).stage, "unknown");
    assert.equal(readiness.transport.lifecycle.at(-1).code, "unknown");
    assert.equal(readiness.transport.lifecycle.at(-1).origin, "unknown");
    assert.equal(readiness.transport.lifecycle.at(-1).closeReason, "unknown");
    assert.match(readiness.transport.lifecycle[0].requestHmac, /^[0-9a-f]{64}$/u);
    assert.doesNotMatch(JSON.stringify(readiness), /private-request|PRIVATE REASON/u);
    return true;
  });
});

test("Electron page close is observed and fails readiness before cleanup", async () => {
  const harness = launchInput();
  harness.electronPage.waitForFunction = async () => {
    harness.electronPage.markClosed();
    throw new Error("initial Electron page closed");
  };
  await assert.rejects(launchCard5ProductionWebHosts(harness.input), (error) => {
    assert.equal(error.observation.stage, "electron-readiness");
    assert.equal(error.observation.electronReadiness.readReason, "page-closed");
    assert.equal(error.observation.electronReadiness.pageEvents.closeCount, 1);
    return true;
  });
  assert.equal(
    harness.events.filter(([host, operation]) => host === "electron" && operation === "close")
      .length,
    1,
  );
});

test("Electron readiness abort fails closed and preserves the abort as the earliest cause", async () => {
  const controller = new AbortController();
  const harness = launchInput({ signal: controller.signal });
  let enteredReadiness;
  const entered = new Promise((resolve) => {
    enteredReadiness = resolve;
  });
  harness.electronPage.waitForFunction = async () => {
    enteredReadiness();
    return new Promise(() => {});
  };
  harness.electronPage.evaluate = async () => ({
    candidateCount: 0,
    candidateOverflow: 0,
    candidates: [],
    documentVisibility: "visible",
    activePanelPresent: false,
    shellPresent: true,
    bootstrapPhase: "connected",
    clientPhase: "loading",
  });
  const lease = createCard5ProductionWebHostLease(harness.input);
  await entered;
  controller.abort();
  await assert.rejects(lease.ready, (error) => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.observation.stage, "electron-readiness");
    assert.equal(error.observation.electronReadiness.readReason, "read-aborted");
    assert.equal(error.observation.electronReadiness.candidateCount, null);
    return true;
  });
  const receipt = await lease.close();
  assert.equal(receipt.chromiumRetired, true);
  assert.equal(receipt.electronRetired, true);
});

test("partial lease is externally reachable and cleanup aborts readiness before launch returns", async () => {
  const { input, events } = launchInput();
  let releaseReadiness;
  const pending = new Promise((resolve) => {
    releaseReadiness = resolve;
  });
  const originalLocator = input.chromium.launch;
  input.chromium.launch = async (...args) => {
    const browser = await originalLocator(...args);
    const context = await browser.newContext();
    const page = await context.newPage();
    page.locator = () => ({
      waitFor: async () => pending,
      first: () => ({ waitFor: async () => pending }),
    });
    browser.newContext = async () => ({ newPage: async () => page });
    return browser;
  };
  const lease = createCard5ProductionWebHostLease(input);
  assert.equal(typeof lease.close, "function");
  const cleanup = await lease.close();
  await assert.rejects(lease.ready, { name: "AbortError" });
  assert.equal(cleanup.chromiumRetired, true);
  assert.equal(cleanup.electronOwned, false);
  assert.match(cleanup.launchStage, /chromium-(?:launch|readiness)/u);
  releaseReadiness();
  assert.equal(
    events.filter(([host, operation]) => host === "chromium" && operation === "close").length,
    1,
  );
});

test("graceful hang escalates only direct acquired process handles and leaves unrelated processes", async () => {
  const { input, browser, electronProcess } = launchInput();
  const live = new Set([111, 112, 222, 223, 999]);
  const signals = [];
  input.cleanupRuntime = {
    closeGraceMs: 5,
    closeTermMs: 1,
    sleep: async () => {},
    processAlive: (pid) => live.has(pid),
    signalProcess: (pid, signal) => {
      signals.push([pid, signal]);
      live.delete(pid);
      if (pid === 111) live.delete(112);
      if (pid === 222) live.delete(223);
    },
    processRows: () => [
      { pid: 111, ppid: 1, pgid: 111, startToken: "a", command: "chromium" },
      { pid: 112, ppid: 111, pgid: 111, startToken: "b", command: "chromium helper" },
      {
        pid: 222,
        ppid: 1,
        pgid: 222,
        startToken: "c",
        command: "electron --user-data-dir=/tmp/card5-owner/electron",
      },
      {
        pid: 223,
        ppid: 222,
        pgid: 222,
        startToken: "d",
        command: "electron helper /tmp/card5-owner/electron",
      },
      {
        pid: 999,
        ppid: 1,
        pgid: 999,
        startToken: "e",
        command: "unrelated /tmp/card5-owner/electron",
      },
    ],
  };
  const chromiumProcess = { pid: 111, exitCode: null, signalCode: null };
  chromiumProcess.kill = (signal) => {
    signals.push([111, signal]);
    live.delete(111);
    live.delete(112);
    chromiumProcess.signalCode = signal;
  };
  electronProcess.kill = (signal) => {
    signals.push([222, signal]);
    live.delete(222);
    live.delete(223);
    electronProcess.signalCode = signal;
  };
  browser.process = () => chromiumProcess;
  const owner = await launchCard5ProductionWebHosts(input);
  const receipt = await owner.close();
  assert.equal(receipt.chromiumRetired, true);
  assert.equal(receipt.electronRetired, true);
  assert.deepEqual(new Set(signals.map(([pid]) => pid)), new Set([111, 112, 222, 223]));
  assert.equal(live.has(999), true);
  assert.equal(
    signals.some(([pid]) => pid === 999),
    false,
  );
});

test("cleanup escalates retained identities when Playwright handles are marked exited", async () => {
  const { input, browser, electronProcess } = launchInput();
  const live = new Set([111, 222]);
  const signals = [];
  browser.process = () => ({ pid: 111, exitCode: 0, signalCode: null });
  electronProcess.exitCode = 0;
  input.cleanupRuntime = {
    closeGraceMs: 1,
    closeTermMs: 1,
    sleep: async () => {},
    processAlive: (pid) => live.has(pid),
    processRows: () => [
      { pid: 111, ppid: 1, pgid: 111, state: "S", startToken: "a", command: "chromium" },
      {
        pid: 222,
        ppid: 1,
        pgid: 222,
        state: "S",
        startToken: "b",
        command: "electron --user-data-dir=/tmp/card5-owner/electron",
      },
    ],
    signalProcess: (pid, signal) => {
      signals.push([pid, signal]);
      live.delete(pid);
    },
    lsofCount: () => 0,
  };
  const owner = await launchCard5ProductionWebHosts(input);
  const receipt = await owner.close();
  assert.equal(receipt.chromiumRetired, true);
  assert.equal(receipt.electronRetired, true);
  assert.deepEqual(new Set(signals.map(([pid]) => pid)), new Set([111, 222]));
});

test("cleanup signals exact descendants before roots and escalates TERM-resistant identities", async () => {
  const { input } = launchInput();
  const live = new Set([111, 112, 222, 223]);
  const signals = [];
  input.cleanupRuntime = {
    closeGraceMs: 1,
    closeTermMs: 1,
    sleep: async () => {},
    processAlive: (pid) => live.has(pid),
    processRows: () => [
      { pid: 111, ppid: 1, pgid: 111, state: "S", startToken: "a", command: "chromium" },
      { pid: 112, ppid: 111, pgid: 111, state: "S", startToken: "b", command: "chromium helper" },
      {
        pid: 222,
        ppid: 1,
        pgid: 222,
        state: "S",
        startToken: "c",
        command: "electron --user-data-dir=/tmp/card5-owner/electron",
      },
      {
        pid: 223,
        ppid: 222,
        pgid: 222,
        state: "S",
        startToken: "d",
        command: "electron helper /tmp/card5-owner/electron",
      },
    ],
    signalProcess: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") live.delete(pid);
    },
    lsofCount: () => 0,
  };
  const owner = await launchCard5ProductionWebHosts(input);
  const receipt = await owner.close();
  assert.equal(receipt.chromiumRetired, true);
  assert.equal(receipt.electronRetired, true);
  assert.deepEqual(
    signals.filter(([, signal]) => signal === "SIGTERM").map(([pid]) => pid),
    [112, 223, 111, 222],
  );
  assert.deepEqual(
    signals.filter(([, signal]) => signal === "SIGKILL").map(([pid]) => pid),
    [112, 223, 111, 222],
  );
});

test("cleanup accepts an exact TERM-to-E transition without sending KILL", async () => {
  const { input } = launchInput();
  const live = new Set([222]);
  const signals = [];
  let state = "S";
  input.cleanupRuntime = {
    closeGraceMs: 1,
    closeTermMs: 1,
    sleep: async () => {},
    processAlive: (pid) => live.has(pid),
    processRows: () => [
      {
        pid: 222,
        ppid: 1,
        pgid: 222,
        state,
        startToken: "transition",
        command: "electron --user-data-dir=/tmp/card5-owner/electron",
      },
    ],
    signalProcess: (pid, signal) => {
      signals.push([pid, signal]);
      if (pid === 222 && signal === "SIGTERM") state = "?Es";
    },
    lsofCount: () => 0,
  };
  const owner = await launchCard5ProductionWebHosts(input);
  const receipt = await owner.close();
  assert.equal(receipt.electronRetired, true);
  assert.equal(receipt.electronTerminalProcessCount, 1);
  assert.deepEqual(signals, [[222, "SIGTERM"]]);
});

test("terminal E process is quiescent only with zero process resources", async () => {
  const { input } = launchInput();
  const live = new Set([222]);
  let handleCount = 0;
  input.cleanupRuntime = {
    closeGraceMs: 1,
    closeTermMs: 1,
    sleep: async () => {},
    processAlive: (pid) => live.has(pid),
    processRows: () => [
      {
        pid: 222,
        ppid: 1,
        pgid: 222,
        state: "?Es",
        startToken: "e",
        command: "electron --user-data-dir=/tmp/card5-owner/electron",
      },
    ],
    signalProcess: () => assert.fail("terminal process must not be signaled again"),
    lsofCount: (args) => (args.includes("-iTCP") ? 0 : handleCount),
  };
  const lease = createCard5ProductionWebHostLease(input);
  await lease.ready;
  const clean = await lease.close();
  assert.equal(clean.electronRetired, true);
  assert.equal(clean.electronProcessCount, 0);
  assert.equal(clean.electronTerminalProcessCount, 1);
  assert.match(clean.electronProcessEvidence[0].identityHmac, /^[0-9a-f]{64}$/u);

  handleCount = 1;
  const dirty = lease.snapshot();
  assert.equal(dirty.electronRetired, false);
  assert.equal(dirty.electronOpenHandleCount, 1);
});

test("active zero-resource process never qualifies as quiescent", async () => {
  const { input } = launchInput();
  const live = new Set([222]);
  input.cleanupRuntime = {
    closeGraceMs: 1,
    closeTermMs: 1,
    sleep: async () => {},
    processAlive: (pid) => live.has(pid),
    processRows: () => [
      {
        pid: 222,
        ppid: 1,
        pgid: 222,
        state: "S",
        startToken: "s",
        command: "electron --user-data-dir=/tmp/card5-owner/electron",
      },
    ],
    signalProcess: () => {},
    lsofCount: () => 0,
  };
  const owner = await launchCard5ProductionWebHosts(input);
  const receipt = await owner.close();
  assert.equal(receipt.electronRetired, false);
  assert.equal(receipt.electronProcessCount, 1);
  assert.equal(receipt.electronTerminalProcessCount, 0);
});

test("late Electron acquisition remains owned and a retry retires its direct handle", async () => {
  const { input } = launchInput();
  const live = new Set([999]);
  const signals = [];
  let resolveElectron;
  input.electron.launch = () =>
    new Promise((resolve) => {
      resolveElectron = resolve;
    });
  input.cleanupRuntime = {
    closeGraceMs: 5,
    closeTermMs: 1,
    sleep: async () => {},
    processAlive: (pid) => live.has(pid),
    signalProcess: (pid, signal) => {
      signals.push([pid, signal]);
      live.delete(pid);
    },
    processRows: () => [
      {
        pid: 222,
        ppid: 1,
        pgid: 222,
        startToken: "late",
        command: "electron --user-data-dir=/tmp/card5-owner/electron",
      },
      {
        pid: 999,
        ppid: 1,
        pgid: 999,
        startToken: "other",
        command: "unrelated /tmp/card5-owner/electron",
      },
    ],
  };
  const lease = createCard5ProductionWebHostLease(input);
  while (!resolveElectron) await new Promise((resolve) => setImmediate(resolve));
  const first = await lease.close();
  assert.equal(first.acquisitionPendingCount, 1);
  assert.equal(first.electronRetired, false);
  live.add(222);
  const electronPage = pageHarness([], "late-electron");
  const lateProcess = { pid: 222, exitCode: null, signalCode: null };
  lateProcess.kill = (signal) => {
    signals.push([222, signal]);
    live.delete(222);
    lateProcess.signalCode = signal;
  };
  resolveElectron({
    process: () => lateProcess,
    firstWindow: async () => electronPage,
    close: async () => {},
  });
  await assert.rejects(lease.ready, { name: "AbortError" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await lease.close();
  assert.equal(second.acquisitionPendingCount, 0);
  assert.equal(second.electronRetired, true);
  assert.equal(
    signals.some(([pid]) => pid === 222),
    true,
  );
  assert.equal(
    signals.some(([pid]) => pid === 999),
    false,
  );
  assert.equal(live.has(999), true);
});

test("PID identity reuse is rejected immediately before escalation", async () => {
  const { input } = launchInput();
  const live = new Set([111]);
  const command = "chromium-owned";
  let startToken = "first-start";
  const signals = [];
  input.cleanupRuntime = {
    closeGraceMs: 1,
    closeTermMs: 1,
    sleep: async () => {},
    processAlive: (pid) => live.has(pid),
    signalProcess: (pid, signal) => signals.push([pid, signal]),
    processRows: () => [{ pid: 111, ppid: 1, pgid: 111, startToken, command }],
  };
  const owner = await launchCard5ProductionWebHosts(input);
  startToken = "reused-start";
  const receipt = await owner.close();
  assert.equal(receipt.chromiumRetired, true);
  assert.deepEqual(signals, []);
  assert.equal(live.has(111), true);
});

test("each TERM revalidates identity after an earlier owned signal causes PID reuse", async () => {
  const { input } = launchInput();
  const live = new Set([111, 222]);
  let electronStart = "electron-owned";
  const signals = [];
  input.cleanupRuntime = {
    closeGraceMs: 1,
    closeTermMs: 1,
    sleep: async () => {},
    processAlive: (pid) => live.has(pid),
    processRows: () => [
      { pid: 111, ppid: 1, pgid: 111, state: "S", startToken: "chromium", command: "chromium" },
      {
        pid: 222,
        ppid: 1,
        pgid: 222,
        state: "S",
        startToken: electronStart,
        command: "electron --user-data-dir=/tmp/card5-owner/electron",
      },
    ],
    signalProcess: (pid, signal) => {
      signals.push([pid, signal]);
      if (pid === 111) {
        live.delete(111);
        electronStart = "electron-reused";
      }
    },
    lsofCount: () => 0,
  };
  const owner = await launchCard5ProductionWebHosts(input);
  const receipt = await owner.close();
  assert.equal(receipt.chromiumRetired, true);
  assert.equal(receipt.electronRetired, true);
  assert.deepEqual(signals, [[111, "SIGTERM"]]);
  assert.equal(live.has(222), true);
});

test("abort after Chromium acquisition never retires an unknown hung process inventory", async () => {
  const { input, browser } = launchInput();
  let releaseIdentity;
  const identity = new Promise((resolve) => {
    releaseIdentity = resolve;
  });
  browser.newBrowserCDPSession = async () => ({ send: async () => identity });
  browser.close = async () => new Promise(() => {});
  input.cleanupRuntime = {
    closeGraceMs: 2,
    closeTermMs: 1,
    sleep: async () => {},
    processAlive: () => false,
    processRows: () => [],
  };
  const lease = createCard5ProductionWebHostLease(input);
  await new Promise((resolve) => setImmediate(resolve));
  const receipt = await lease.close();
  assert.equal(receipt.chromiumOwned, true);
  assert.equal(receipt.chromiumRetired, false);
  assert.equal(receipt.chromiumProcessCount, 0);
  releaseIdentity({ processInfo: [] });
  await assert.rejects(lease.ready, { name: "AbortError" });
});

test("fulfilled browser close cannot substitute for a missing acquired PID identity", async () => {
  const { input, browser } = launchInput();
  browser.newBrowserCDPSession = async () => ({
    send: async () => ({ processInfo: [] }),
  });
  const lease = createCard5ProductionWebHostLease(input);
  await assert.rejects(lease.ready);
  const receipt = await lease.close();
  assert.equal(receipt.chromiumOwned, true);
  assert.equal(receipt.chromiumRetired, false);
});

test("rejects unowned Electron entry and runtime paths before launch", async () => {
  const { input } = launchInput({ electronEntry: "/foreign/main.cjs" });
  await assert.rejects(launchCard5ProductionWebHosts(input), /ProductRig-owned/u);
});

test("ProductRig routes enabled Card5 executors through real hosts before the synthetic oracle", () => {
  const source = readFileSync(new URL("../product-test-rig.mjs", import.meta.url), "utf8");
  const topologySource = readFileSync(
    new URL("./product-card5-host-topology.mjs", import.meta.url),
    "utf8",
  );
  const rendererMain = readFileSync(
    new URL("../../apps/desktop-renderer/src/main.tsx", import.meta.url),
    "utf8",
  );
  const probeBootstrap = rendererMain.indexOf("installCard5ProbeBootstrap(window.location.href)");
  const appImport = rendererMain.indexOf('await import("./App.tsx")');
  assert.ok(probeBootstrap >= 0 && appImport >= 0 && probeBootstrap < appImport);
  assert.match(source, /_electron: electron/u);
  assert.match(source, /createCard5ProductionWebHostLease/u);
  assert.match(
    source,
    /card5Journey[\s\S]*prepareOwnedTuiRuntime\([\s\S]*createRuntimeDir:\s*createIsolatedTargetedTuiCwd/u,
  );
  assert.match(
    source,
    /if \(card5Journey\) prepareIsolatedTargetedTuiCwd\(state\.tui\.runtimeDir\);\s*const launchedTui = JSON\.parse\(\s*tuiCommand\(state, \["start"/u,
  );
  assert.match(source, /runCrossClientHandoffOwnerBoot/u);
  assert.match(source, /runDaemonRestartOwnerBoot/u);
  assert.doesNotMatch(
    source,
    /latestCard5TuiCanonical\(\s*(?:hosts\.)?(?:card5)?[Tt]uiEvidence\s*\)/u,
  );
  assert.match(
    source,
    /exactSharedCard5WebPane\(initialWebIdentity\.value\)[\s\S]*latestCard5TuiCanonical\(card5TuiEvidence, initialPaneId\)/u,
  );
  assert.match(
    source,
    /replacementTuiIdentity = latestCard5TuiCanonical\(\s*card5TuiEvidence,\s*acceptedConvergencePaneId/u,
  );
  assert.match(
    source,
    /proveCard5SlowWebIsolation\([\s\S]*card5TuiEvidence,\s*acceptedConvergencePaneId/u,
  );
  const handoffSource = source.slice(
    source.indexOf("async function driveCard5AuthorityHandoff"),
    source.indexOf("async function proveCard5PassiveGeometry"),
  );
  assert.match(handoffSource, /exactAttachablePane\(daemon, state\.session, expectedPane\)/u);
  assert.match(handoffSource, /activateCard5ExactTerminalSurface/u);
  assert.match(
    handoffSource,
    /hosts\.chromiumPage,[\s\S]*?ordinal:\s*1,[\s\S]*?hosts\.electronPage,[\s\S]*?ordinal:\s*2,/u,
  );
  assert.match(handoffSource, /observeCard5WebAuthorityReceipt/u);
  assert.match(handoffSource, /retainedFocusAssessment/u);
  assert.match(handoffSource, /tuiInputMark = retainedFocusMark/u);
  assert.match(handoffSource, /acceptedFocusEvidence/u);
  assert.match(handoffSource, /retainedAuthorityEvidence/u);
  assert.match(handoffSource, /sealCard5TuiFocusAuthority/u);
  assert.match(handoffSource, /Promise\.all\(\[\s*observeCard5WebCanonical\(/u);
  assert.match(handoffSource, /acceptedAuthorityEvidence\.authorityTopologyHmac/u);
  assert.match(handoffSource, /focus-convergence-changed/u);
  assert.match(handoffSource, /driveExactTuiFocus\("blur",\s*hostFocusBinding\)/u);
  assert.equal(
    (handoffSource.match(/driveExactTuiFocus\("focus",\s*hostFocusBinding\)/gu) ?? []).length,
    2,
  );
  assert.match(handoffSource, /assessCard5TuiFocusTransition/u);
  assert.match(handoffSource, /assessCard5NullAuthorityPair/u);
  assert.match(handoffSource, /releaseCard5WebOwnedAuthorities/u);
  assert.ok(
    handoffSource.indexOf('driveExactTuiFocus("blur", hostFocusBinding)') <
      handoffSource.indexOf("while (performance.now() < releaseTransactionDeadline)"),
  );
  assert.match(handoffSource, /invokeCard5TuiHostFocusControl/u);
  assert.match(source, /TMUX_IDE_TUI_PERF_LOG:\s*state\.tui\.hostFocusLifecyclePath/u);
  assert.match(source, /hostFocusLifecyclePath:\s*join\(rigRoot, "tui", "performance\.jsonl"\)/u);
  assert.match(source, /createCard5TuiEvidenceStream\([\s\S]*lifecyclePath/u);
  assert.match(
    source,
    /createProductJsonlTailReader\(lifecyclePath,\s*\{\s*recordKind: "lifecycle"/u,
  );
  assert.match(source, /processLifecycleRecords\(lifecycleReader\.read\(\)\)/u);
  assert.match(handoffSource, /lifecycleReader\.confirmCaughtUp\(\)/u);
  assert.match(handoffSource, /bindingStableSamples\s*>=\s*2/u);
  assert.doesNotMatch(handoffSource, /dispatchEvent\(new Event\("blur"\)\)/u);
  assert.match(
    handoffSource,
    /assessCard5TuiHandoffInput[\s\S]*recordsThrough\(postInputMark\)[\s\S]*slice\(focusTransitionMark\.recordCount\)/u,
  );
  assert.match(handoffSource, /nullOwnerObserved/u);
  assert.match(handoffSource, /tuiFocusTransition/u);
  assert.doesNotMatch(source, /\["key",\s*"C-o"\]/u);
  assert.doesNotMatch(handoffSource, /terminal-focus-fence/u);
  assert.doesNotMatch(handoffSource, /firstAttachablePane/u);
  const convergenceSource = source.slice(
    source.indexOf("async function waitForCard5ProductionClientConvergence"),
    source.indexOf("function card5Percentile"),
  );
  assert.match(convergenceSource, /expectedAuthority: webA\?\.workspaceEvidence\?\.authority/u);
  assert.match(convergenceSource, /advanceCard5FocusedConvergenceStability/u);
  assert.match(convergenceSource, /focusedPaneEvidence: focusAssessment\.evidence/u);
  const slowSource = source.slice(
    source.indexOf("async function proveCard5SlowWebIsolation"),
    source.indexOf("async function proveCard5NativeObserver"),
  );
  assert.match(slowSource, /\{ expectedPane: semanticPaneId \}/u);
  assert.match(slowSource, /caughtUp\.semanticPaneId === semanticPaneId/u);
  const nativeSource = source.slice(
    source.indexOf("async function proveCard5NativeObserver"),
    source.indexOf("async function start(json"),
  );
  assert.match(
    nativeSource,
    /selectExactCard5PaneGeometry\(activeWindowPaneGeometry\(state\), expectedPane\)/u,
  );
  assert.doesNotMatch(nativeSource, /activeWindowPaneGeometry\(state\)\[0\]/u);
  assert.match(
    source,
    /proveCard5NativeObserver\([\s\S]*acceptedConvergencePaneId,[\s\S]*card5NativeExpectedMarker/u,
  );
  const branch = source.slice(
    source.indexOf("if (card5Journey) {", source.indexOf("tui-coherent-terminal-frame")),
    source.indexOf(
      "const beforeRestart = await proveMultiClientConvergence",
      source.indexOf("tui-coherent-terminal-frame"),
    ),
  );
  assert.match(branch, /await new Promise\(\(\) => undefined\);\s+return;/u);
  assert.doesNotMatch(branch, /product-test-rig-multiclient/u);
  const initialLifecycle = branch.indexOf('stage: "initial-host-lifecycle"');
  const issuePredecessors = branch.indexOf("issueCard5PredecessorDescriptor", initialLifecycle);
  const stopDaemon = branch.indexOf("await daemon.stop()", issuePredecessors);
  const redeemPredecessors = branch.indexOf("rejectCard5PredecessorDescriptor", stopDaemon);
  assert.ok(
    initialLifecycle >= 0 &&
      issuePredecessors > initialLifecycle &&
      stopDaemon > issuePredecessors &&
      redeemPredecessors > stopDaemon,
    "unopened predecessor descriptors must be issued after initial lifecycle proof and immediately before replacement",
  );
  assert.doesNotMatch(branch.slice(0, initialLifecycle), /issueCard5PredecessorDescriptor/u);
  assert.match(
    branch.slice(issuePredecessors, stopDaemon),
    /generation: before\.generation[\s\S]*semanticPaneId: tuiIdentity\.semanticPaneId/u,
  );

  const diagnoseCard5 = source.slice(
    source.indexOf("async function diagnoseCard5Journey"),
    source.indexOf("const diagnoseCrossClientHandoff"),
  );
  assert.match(diagnoseCard5, /const captureEvidence = state\.card5CaptureEvidence;/u);
  assert.doesNotMatch(diagnoseCard5, /captureArtifacts\(/u);
  assert.match(diagnoseCard5, /journeyEvidence\?\.correlation\?\.complete === true/u);
  assert.match(diagnoseCard5, /artifactCorrelation\.complete === true/u);
  assert.match(diagnoseCard5, /artifactCorrelation\.missing/u);
  assert.doesNotMatch(diagnoseCard5, /correlationComplete:\s*artifactCorrelation\.complete/u);

  assert.doesNotMatch(source, /function card5CanonicalContentHmac/u);
  assert.match(topologySource, /Card5 production host lifecycle is incomplete or ambiguous/u);
  assert.match(
    source,
    /record\.terminalDelivery\?\.transactionId === delivery\.ackEvent\?\.transactionId/u,
  );
  assert.match(source, /sinkAfterRelease\.pendingCurrent === 0/u);
  assert.match(source, /timeoutMs > 5_000/u);
  assert.match(
    source,
    /card5ArtifactIdentity: await card5ArtifactIdentity\([\s\S]*replacementTuiIdentity\.semanticPaneId/u,
  );
  assert.match(
    source,
    /function card5ArtifactCorrelation[\s\S]*"artifact-correlation"[\s\S]*journeyEvidence\?\.correlation\?\.journeyHmac/u,
  );

  const card5Owner = source.slice(
    source.indexOf("if (card5Journey) {", source.indexOf("tui-coherent-terminal-frame")),
    source.indexOf(
      "const beforeRestart = await proveMultiClientConvergence",
      source.indexOf("tui-coherent-terminal-frame"),
    ),
  );
  assert.match(
    card5Owner,
    /captureArtifacts\([\s\S]*card5WebHosts\.chromiumPage[\s\S]*publish\(\{ card5CaptureEvidence \}\)/u,
  );

  const prepareFailure = source.slice(
    source.indexOf("async function prepareDiagnosticFailure"),
    source.indexOf("async function executeDiagnosticAttempt"),
  );
  assert.match(
    prepareFailure,
    /\["cross-client-handoff", "daemon-restart"\]\.includes\(planEntry\.journey\.id\)[\s\S]*state\?\.card5CaptureEvidence/u,
  );
  assert.match(
    prepareFailure,
    /!\["cross-client-handoff", "daemon-restart"\]\.includes\(planEntry\.journey\.id\)/u,
  );
  assert.match(
    prepareFailure,
    /!truth[\s\S]*!\["cross-client-handoff", "daemon-restart"\]\.includes\(planEntry\.journey\.id\)[\s\S]*truth = tmuxTruth/u,
  );

  for (const id of ["cross-client-handoff", "daemon-restart"]) {
    assert.equal(
      PRODUCT_JOURNEY_REGISTRY.find((entry) => entry.id === id)?.implementation,
      "implemented",
    );
  }
});
