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
          : null,
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
  const harness = launchInput();
  const owner = await launchCard5ProductionWebHosts(harness.input);
  const exactSurface = harness.electronPage.qualifiedSurfaceHandle;
  const replacementSurface = {
    ...exactSurface,
    getAttribute: exactSurface.getAttribute,
  };
  let qualifiedSurface = exactSurface;
  let replaceDuringProbe = false;
  let documentVisibility = "visible";
  let activeLifecycleRequests = [
    {
      generation: "g1",
      requestId: "private-active-request",
      firstSeedOrdinal: 4,
      workspaceName: "workspace-b",
      semanticPaneIds: ["pane-b"],
    },
  ];
  let descriptorEvents = [
    {
      generation: "g1",
      requestId: "private-active-request",
      socketUrl: "ws://127.0.0.1/private-socket",
    },
    {
      generation: "g1",
      requestId: "private-unused-candidate",
      socketUrl: "ws://127.0.0.1/private-unused",
    },
  ];
  globalThis.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
  createCard5EnvelopeEvidenceRecorder();
  createCard5GeometryReceiptRecorder()?.({
    generation: "g1",
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
    };
    globalThis.document = { visibilityState: documentVisibility, querySelectorAll: () => [] };
    globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__ = (mode = "readiness") =>
      documentVisibility === "hidden" && mode === "readiness" ? null : qualifiedSurface;
    globalThis.__TMUX_IDE_PROBE_TERMINAL_RENDITION__ = async (paneId) => {
      if (replaceDuringProbe) qualifiedSurface = replacementSurface;
      return {
        canonical: {
          incarnation: "incarnation-b",
          generation: "g1",
          revision: 2,
          cols: 160,
          rows: 44,
          stateHash: "44".repeat(32),
        },
        rendition: { renditionHmac: paneId === "pane-b" ? "33".repeat(32) : null },
      };
    };
    const baseEnvelope = recordedEnvelopeEvidence();
    globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ = () => ({
      ...baseEnvelope,
      acceptedCount: 1,
      ackSentCount: 1,
      activeLifecycleRequests,
      activeLifecycleRequestOverflowGenerations: [],
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
    });
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
    globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__ = () => ({
      snapshot: {
        generation: "g1",
        phase: "live",
        target: null,
        authority: null,
        operations: [],
      },
      authorityRecords: [],
      authorityRecordCount: 0,
    });
    try {
      return await callback(value);
    } finally {
      globalThis.document = previous.document;
      globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__ = previous.resolver;
      globalThis.__TMUX_IDE_PROBE_TERMINAL_RENDITION__ = previous.probe;
      globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ = previous.envelope;
      globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__ = previous.workspace;
      globalThis.__TMUX_IDE_CARD5_AUTHORITY_ACTIVITY_EVIDENCE__ = previous.activity;
    }
  };
  const stable = await observeCard5WebCanonical(
    harness.electronPage,
    harness.input.evidenceKey,
    owner.electronProcessIdentity,
  );
  assert.equal(stable?.semanticPaneId, "pane-b");
  const lightweightExact = await observeCard5WebAuthorityReceipt(
    harness.electronPage,
    harness.input.evidenceKey,
    owner.electronProcessIdentity,
  );
  assert.equal(lightweightExact?.semanticPaneId, "pane-b");
  assert.deepEqual(
    {
      ...lightweightExact?.runtimeReplacement?.currentLifecycleRequest,
      requestHmac: "<hmac>",
    },
    {
      status: "exact",
      requestHmac: "<hmac>",
      activeCount: 1,
      descriptorCount: 1,
      overflow: false,
    },
  );
  activeLifecycleRequests = [];
  const lightweightMissing = await observeCard5WebAuthorityReceipt(
    harness.electronPage,
    harness.input.evidenceKey,
    owner.electronProcessIdentity,
  );
  assert.deepEqual(lightweightMissing?.runtimeReplacement?.currentLifecycleRequest, {
    status: "missing",
    requestHmac: null,
    activeCount: 0,
    descriptorCount: 0,
    overflow: false,
  });
  activeLifecycleRequests = [
    {
      generation: "g1",
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
      ...lightweightRetainedRingLoss?.runtimeReplacement?.currentLifecycleRequest,
      requestHmac: "<hmac>",
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
      generation: "g1",
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
      ...stable?.runtimeReplacement?.currentLifecycleRequest,
      requestHmac: "<hmac>",
      socketHmac: "<hmac>",
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
  assert.doesNotMatch(
    JSON.stringify(stable.runtimeReplacement.currentLifecycleRequest),
    /private-/u,
  );
  activeLifecycleRequests = [
    ...activeLifecycleRequests,
    {
      generation: "g1",
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
      generation: "g1",
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
      generation: "g1",
      requestId: "private-active-request",
      firstSeedOrdinal: 4,
      workspaceName: "workspace-b",
      semanticPaneIds: ["pane-b"],
    },
  ];
  qualifiedSurface = replacementSurface;
  assert.equal(
    await observeCard5WebCanonical(
      harness.electronPage,
      harness.input.evidenceKey,
      owner.electronProcessIdentity,
    ),
    null,
    "a same-workspace/same-pane element replacement must not be captured",
  );
  qualifiedSurface = null;
  assert.equal(
    await observeCard5WebCanonical(
      harness.electronPage,
      harness.input.evidenceKey,
      owner.electronProcessIdentity,
    ),
    null,
    "a hidden or removed qualified element must not be captured",
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
  replaceDuringProbe = true;
  assert.equal(
    await observeCard5WebCanonical(
      harness.electronPage,
      harness.input.evidenceKey,
      owner.electronProcessIdentity,
    ),
    null,
    "a same-identity replacement while the rendition probe is pending must not be captured",
  );
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
  const previous = {
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    Node: globalThis.Node,
    MutationObserver: globalThis.MutationObserver,
    getComputedStyle: globalThis.getComputedStyle,
  };
  class ElementStub {
    children = [];
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
  }
  class SurfaceStub extends ElementStub {
    isConnected = true;
    pane = "pane-b";
    phase = "connected";
    areaRef = null;
    getAttribute(name) {
      if (name === "data-semantic-pane-id") return this.pane;
      if (name === "data-phase") return this.phase;
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
  let insertCount = 0;
  let clearFocusDuringInsert = false;
  let detachTargetDuringClick = false;
  let beforeHandleClick = null;
  let beforeFinalTargetCheck = null;
  let afterPreInsertObservation = null;
  let beforeKeyboardInsert = null;
  let disposedHandleCount = 0;
  let elementHandlesDelayMs = 0;
  let evaluateHandleDelayMs = 0;
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
  const dispatchBrowserEvent = ({ type, node, trusted = true, data = null }) => {
    let prevented = false;
    let stopped = false;
    documentCaptureListeners.get(type)?.({
      button: 0,
      target: node,
      data,
      inputType: type === "beforeinput" || type === "input" ? "insertText" : undefined,
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
    return { prevented, stopped };
  };
  const dispatchPointer = ({ node, trusted = true }) =>
    dispatchBrowserEvent({ type: "pointerdown", node, trusted });
  const binding = Object.freeze({
    workspaceName: "workspace-b",
    semanticPaneId: "pane-b",
    processIdentity: "chromium:1",
    generation: "g1",
    runtimeReplacement: {
      inputReceipts: [],
      inputReceiptCount: 0,
      currentLifecycleRequest: {
        status: "exact",
        requestHmac: "aa".repeat(32),
        activeCount: 1,
        descriptorCount: 1,
        overflow: false,
      },
    },
    workspaceEvidence: { target: { session: "session-a" } },
  });
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
    constructor(node) {
      this.node = node;
    }
    evaluate(callback, value) {
      return callback(this.node, unwrapHandleArgument(value));
    }
    async evaluateHandle(callback, value) {
      evaluateHandleCallCount += 1;
      if (evaluateHandleDelayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, evaluateHandleDelayMs));
      return new HandleStub(callback(this.node, unwrapHandleArgument(value)));
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
        beforeKeyboardInsert?.();
        beforeKeyboardInsert = null;
        const inputTarget = globalThis.document.activeElement;
        const beforeInput = dispatchBrowserEvent({
          type: "beforeinput",
          node: inputTarget,
          data: text,
        });
        if (clearFocusDuringInsert) globalThis.document.activeElement = null;
        const input = dispatchBrowserEvent({ type: "input", node: inputTarget, data: text });
        if (beforeInput.prevented || beforeInput.stopped || input.prevented || input.stopped)
          return;
        insertCount += 1;
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
    return activateCard5ExactTerminalSurface({
      mode: input === null || input?.inputText === undefined ? "focus" : "input",
      page,
      keyHex: "ab".repeat(32),
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
    await assert.rejects(
      activate(),
      (error) => error.observation?.reason === "trusted-pointer-topology-rejected",
    );
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
          status: "exact",
          requestHmac: "bb".repeat(32),
          activeCount: 1,
          descriptorCount: 1,
          overflow: false,
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
      generation: "g1",
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
        deadline: performance.now() + 100,
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
    beforeKeyboardInsert = () => {
      dispatchBrowserEvent({ type: "focusout", node: textarea });
      globalThis.document.activeElement = new TextAreaStub();
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
          deadline: performance.now() + 100,
        },
      ),
      (error) => error.observation?.reason === "input-dispatch-rejected",
    );
    assert.equal(
      insertCount,
      insertsBeforeDispatchGap,
      "dispatch-window focus loss must block input",
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
          deadline: performance.now() + 100,
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
        deadline: performance.now() + 100,
      },
    );
    assert.equal(inserted.authorityClientId, "web-a");
    assert.equal(inserted.requestHmac, requestHmac);
    const gappedAfterInput = {
      ...afterInput,
      runtimeReplacement: {
        ...afterInput.runtimeReplacement,
        inputReceipts: [{ ...receipt, ordinal: 1 }],
        inputReceiptCount: 2,
      },
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
          deadline: performance.now() + 100,
        },
      ),
      (error) => error.observation?.reason === "post-input-receipt-count-advanced",
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
          deadline: performance.now() + 100,
        },
      ),
      (error) => error.observation?.reason === "input-receipt-mismatch",
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
          deadline: performance.now() + 100,
        },
      ),
      (error) => error.observation?.reason === "input-dispatch-rejected",
    );
    clearFocusDuringInsert = false;
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
          deadline: performance.now() + 100,
        },
      ),
      (error) => error.observation?.reason === "post-input-binding-changed",
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
      (error) => error.observation?.reason === "input-insertion-timeout",
    );
    insertBlockMs = 0;
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
  }
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
  assert.deepEqual(new Set(signals.map(([pid]) => pid)), new Set([111, 222]));
  assert.equal(live.has(999), true);
  assert.equal(
    signals.some(([pid]) => pid === 999),
    false,
  );
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
    processRows: () => [{ pid: 111, ppid: 1, pgid: 111, startToken, command }],
  };
  const owner = await launchCard5ProductionWebHosts(input);
  startToken = "reused-start";
  const receipt = await owner.close();
  assert.equal(receipt.chromiumRetired, true);
  assert.deepEqual(signals, []);
  assert.equal(live.has(111), true);
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
