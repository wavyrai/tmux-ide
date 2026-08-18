import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  productRigTerminalFailureState,
  runConfiglessProductJourneyOwnerBoot,
} from "../product-test-rig-journeys.mjs";
import {
  assessCoherentFirstPaneBoundaries,
  assessConfiglessJourneyBoundaries,
  buildProductDiagnosticCorrelation,
  canonicalPromotionPredicateSignature,
  CONFIGLESS_TMUX_SESSION_FIELD_SEPARATOR,
  CONFIGLESS_TMUX_SESSION_FORMAT,
  CONFIGLESS_TMUX_SESSION_ROW_SENTINEL,
  createConfiglessProductJourneyOwnerOperations,
  createFreshFleetCatalogReader,
  parseConfiglessTmuxSessionInventory,
  qualifyAutomaticConfiglessSelection,
  qualifyCanonicalPromotionAdoption,
  qualifyCanonicalSeedPaint,
  qualifyCoherentFrameCausality,
  qualifyPreseededPaneEvidence,
  qualifySelectedWindowWebSemantic,
  qualifyWorkspaceClientState,
  waitForCanonicalFrameFence,
  waitForQualifiedWorkspaceClientState,
} from "./product-configless-owner.mjs";

test("coherent journey assessment requires unique causal boundary order", () => {
  const phases = [
    "targeted-namespace-preseeded",
    "targeted-daemon-ready",
    "targeted-tui-cwd-ready",
    "targeted-tui-connect",
    "canonical-seed-paint-correlation",
    "coherent-terminal-publication",
    "web-started-after-coherent-boundary",
  ];
  const assess = (values) =>
    assessCoherentFirstPaneBoundaries({
      timeline: values.map((phase) => ({ phase })),
      correlationComplete: true,
    });
  const passed = assess(phases);
  assert.equal(passed.status, "passed");
  assert.ok(passed.boundaries.every(({ status }) => status === "passed"));
  assert.match(passed.boundaries[0].detail, /in order/u);
  assert.equal(assess([phases[1], phases[0], ...phases.slice(2)]).status, "failed");
  assert.equal(assess([...phases, phases[2]]).status, "failed");
});

test("coherent frame causality rejects stale frames, mixed epochs, and observer delay", () => {
  const start = {
    phase: "generation-connection-start",
    daemonGeneration: "generation",
    processId: "opentui:1",
    clockId: "clock",
    monotonicMicros: 50,
    elapsedMs: 5,
  };
  const connection = {
    phase: "generation-connection-resolved",
    daemonGeneration: "generation",
    processId: "opentui:1",
    clockId: "clock",
    monotonicMicros: 100,
    elapsedMs: 10,
  };
  const publication = {
    phase: "generation-host-internal-snapshot-publication",
    publicationPhase: "internal-snapshot-published",
    daemonGeneration: "generation",
    processId: "opentui:1",
    clockId: "clock",
    rendererEpoch: 2,
    monotonicMicros: 200,
    elapsedMs: 20,
  };
  const frame = {
    phase: "first-terminal-frame",
    daemonGeneration: "generation",
    processId: "opentui:1",
    clockId: "clock",
    rendererEpoch: 2,
    monotonicMicros: 400,
    elapsedMs: 40,
  };
  const seedPaint = {
    publication: { semanticPaneId: "pane.one", sourceEpoch: 1 },
    paint: {
      processId: "opentui:1",
      clockId: "clock",
      clockKind: "performance-now",
      generation: "generation",
      semanticPaneId: "pane.one",
      incarnation: "generation:0",
      revision: 3,
      stateHash: "0123456789abcdef",
      cols: 132,
      rows: 41,
      sourceEpoch: 1,
      viewportCols: 132,
      viewportRows: 40,
      atMicros: 300,
    },
  };
  const keyedFrame = {
    ...seedPaint.paint,
    type: "performance.terminal-canonical-host-frame",
    rendererEpoch: 2,
    atMicros: 400,
  };
  const fence = {
    ...seedPaint.paint,
    type: "performance.terminal-frame-fence",
    daemonGeneration: "generation",
    rendererEpoch: 2,
    atMicros: 410,
    identityDrops: 0,
    writerHealth: { droppedRecords: 0, oversizedRecords: 0, failed: false },
  };
  const exact = qualifyCoherentFrameCausality(
    [start, connection, publication, frame, { phase: "observer-finished", elapsedMs: 9_999 }],
    seedPaint,
    "generation",
    [seedPaint.paint, keyedFrame, fence],
  );
  assert.equal(exact.connectToCoherentMs, 0.35);
  assert.throws(
    () =>
      qualifyCoherentFrameCausality(
        [start, connection, publication, { ...frame, monotonicMicros: 150 }],
        seedPaint,
        "generation",
        [seedPaint.paint, { ...keyedFrame, atMicros: 400 }, fence],
      ),
    /ordering mismatch/u,
  );
  assert.throws(
    () =>
      qualifyCoherentFrameCausality(
        [start, connection, publication, { ...frame, rendererEpoch: 3 }],
        seedPaint,
        "generation",
        [seedPaint.paint, { ...keyedFrame, rendererEpoch: 3 }, { ...fence, rendererEpoch: 3 }],
      ),
    /identity or ordering mismatch/u,
  );
  assert.throws(
    () =>
      qualifyCoherentFrameCausality(
        [start, connection, publication, frame],
        seedPaint,
        "generation",
        [
          seedPaint.paint,
          {
            type: "performance.terminal-canonical-update",
            updateType: "terminal.patch",
            processId: "opentui:1",
            clockId: "clock",
            generation: "generation",
            semanticPaneId: "pane.one",
            sourceEpoch: 1,
            atMicros: 350,
          },
          keyedFrame,
          fence,
        ],
      ),
    /later canonical update/u,
  );
  assert.throws(
    () =>
      qualifyCoherentFrameCausality([start, connection, publication], seedPaint, "generation", [
        seedPaint.paint,
        keyedFrame,
        fence,
      ]),
    (error) => {
      assert.equal(error.boundary, "coherent-terminal-publication");
      assert.deepEqual(error.observation, {
        daemonGeneration: "generation",
        reason: "lifecycle-cardinality",
        starts: 1,
        connections: 1,
        internalPublications: 1,
        hostFrames: 0,
        canonicalHostFrames: 1,
        fences: 1,
        predicates: {},
        timestamps: {
          start: 50,
          connection: 100,
          internalPublication: 200,
          firstTerminalFrame: null,
          paint: 300,
          hostFrame: 400,
          fence: 410,
        },
        identity: {
          processId: "opentui:1",
          clockId: "clock",
          semanticPaneId: "pane.one",
          generation: "generation",
          revision: 3,
          incarnation: "generation:0",
          stateHash: "0123456789abcdef",
          sourceEpoch: 1,
          canonicalGeometry: {
            cols: 132,
            rows: 41,
            viewportCols: 132,
            viewportRows: 40,
          },
        },
      });
      return true;
    },
  );
  assert.throws(
    () =>
      qualifyCoherentFrameCausality(
        [start, connection, publication, frame],
        seedPaint,
        "generation",
        [seedPaint.paint, keyedFrame, { ...fence, atMicros: 390 }],
      ),
    /identity or ordering mismatch/u,
  );
});

test("coherent causality ignores a transient first geometry and qualifies the exact stable frame", () => {
  const lifecycle = [
    {
      phase: "generation-connection-start",
      daemonGeneration: "generation",
      processId: "opentui:1",
      clockId: "clock",
      monotonicMicros: 100,
      elapsedMs: 1,
    },
    {
      phase: "generation-connection-resolved",
      daemonGeneration: "generation",
      processId: "opentui:1",
      clockId: "clock",
      monotonicMicros: 110,
      elapsedMs: 2,
    },
    {
      phase: "generation-host-internal-snapshot-publication",
      publicationPhase: "internal-snapshot-published",
      daemonGeneration: "generation",
      processId: "opentui:1",
      clockId: "clock",
      rendererEpoch: 1,
      monotonicMicros: 200,
      elapsedMs: 3,
    },
    {
      phase: "first-terminal-frame",
      daemonGeneration: "generation",
      processId: "opentui:1",
      clockId: "clock",
      rendererEpoch: 1,
      monotonicMicros: 320,
      elapsedMs: 4,
    },
  ];
  const identity = {
    processId: "opentui:1",
    clockId: "clock",
    clockKind: "performance-now",
    semanticPaneId: "pane.one",
    generation: "generation",
    incarnation: "generation:0",
    revision: 2,
    stateHash: "0123456789abcdef",
    cols: 132,
    rows: 41,
    sourceEpoch: 1,
    viewportCols: 132,
    viewportRows: 40,
  };
  const paint = { ...identity, type: "performance.terminal-canonical-paint", atMicros: 500 };
  const records = [
    {
      ...identity,
      revision: 1,
      stateHash: "fedcba9876543210",
      cols: 160,
      rows: 42,
      type: "performance.terminal-canonical-host-frame",
      rendererEpoch: 1,
      atMicros: 310,
    },
    paint,
    {
      ...identity,
      type: "performance.terminal-canonical-host-frame",
      rendererEpoch: 1,
      atMicros: 510,
    },
    {
      ...identity,
      type: "performance.terminal-frame-fence",
      daemonGeneration: "generation",
      rendererEpoch: 1,
      atMicros: 520,
      identityDrops: 0,
      writerHealth: { droppedRecords: 0, oversizedRecords: 0, failed: false },
    },
  ];
  const result = qualifyCoherentFrameCausality(lifecycle, { paint }, "generation", records);
  assert.equal(result.hostFrame.atMicros, 510);
  assert.equal(result.connectToCoherentMs, 0.41);
  assert.throws(
    () =>
      qualifyCoherentFrameCausality(lifecycle, { paint }, "generation", [
        ...records,
        { ...records[2], atMicros: 511 },
      ]),
    /one exact keyed host frame/u,
  );
});

test("coherent fence polling waits for the queued canonical tail", async () => {
  const paint = {
    type: "performance.terminal-canonical-paint",
    processId: "opentui:1",
    clockId: "clock",
    clockKind: "performance-now",
    generation: "generation",
    semanticPaneId: "pane.one",
    incarnation: "generation:0",
    revision: 3,
    stateHash: "0123456789abcdef",
    cols: 132,
    rows: 41,
    sourceEpoch: 1,
    viewportCols: 132,
    viewportRows: 40,
    atMicros: 300,
  };
  const patch = {
    type: "performance.terminal-canonical-update",
    updateType: "terminal.patch",
    processId: "opentui:1",
    clockId: "clock",
    generation: "generation",
    semanticPaneId: "pane.one",
    sourceEpoch: 1,
    atMicros: 350,
  };
  const fence = {
    ...paint,
    type: "performance.terminal-frame-fence",
    daemonGeneration: "generation",
    rendererEpoch: 2,
    atMicros: 410,
    identityDrops: 0,
    writerHealth: { droppedRecords: 0, oversizedRecords: 0, failed: false },
  };
  const keyedFrame = {
    ...paint,
    type: "performance.terminal-canonical-host-frame",
    rendererEpoch: 2,
    atMicros: 400,
  };
  let reads = 0;
  const result = await waitForCanonicalFrameFence(
    () => (++reads === 1 ? [paint] : [paint, patch, keyedFrame, fence]),
    {
      processId: "opentui:1",
      clockId: "clock",
      daemonGeneration: "generation",
      rendererEpoch: 2,
    },
    { timeoutMs: 2, now: () => reads, sleep: async () => undefined },
  );
  assert.equal(reads, 2);
  assert.deepEqual(result.records, [paint, patch, keyedFrame, fence]);
  assert.throws(
    () =>
      qualifyCoherentFrameCausality(
        [
          {
            phase: "generation-connection-start",
            daemonGeneration: "generation",
            processId: "opentui:1",
            clockId: "clock",
            monotonicMicros: 50,
            elapsedMs: 5,
          },
          {
            phase: "generation-connection-resolved",
            daemonGeneration: "generation",
            processId: "opentui:1",
            clockId: "clock",
            monotonicMicros: 100,
            elapsedMs: 10,
          },
          {
            phase: "generation-host-internal-snapshot-publication",
            publicationPhase: "internal-snapshot-published",
            daemonGeneration: "generation",
            processId: "opentui:1",
            clockId: "clock",
            rendererEpoch: 2,
            monotonicMicros: 200,
            elapsedMs: 20,
          },
          {
            phase: "first-terminal-frame",
            daemonGeneration: "generation",
            processId: "opentui:1",
            clockId: "clock",
            rendererEpoch: 2,
            monotonicMicros: 400,
            elapsedMs: 40,
          },
        ],
        { paint },
        "generation",
        result.records,
      ),
    /later canonical update/u,
  );
});

test("every coherent fence polling failure preserves bounded boundary truth", async () => {
  const expected = {
    processId: "opentui:1",
    clockId: "clock",
    daemonGeneration: "generation",
    rendererEpoch: 2,
  };
  const fence = (writerHealth) => ({
    type: "performance.terminal-frame-fence",
    processId: expected.processId,
    clockId: expected.clockId,
    clockKind: "performance-now",
    daemonGeneration: expected.daemonGeneration,
    rendererEpoch: expected.rendererEpoch,
    writerHealth,
  });
  const cases = [
    {
      reason: "timeout",
      read: () => [],
      options: {
        timeoutMs: 1,
        now: (() => {
          let value = 0;
          return () => value++;
        })(),
        sleep: async () => undefined,
      },
    },
    {
      reason: "duplicate",
      read: () => [
        fence({ droppedRecords: 0, oversizedRecords: 0, failed: false }),
        fence({ droppedRecords: 0, oversizedRecords: 0, failed: false }),
      ],
      options: {},
    },
    {
      reason: "unhealthy",
      read: () => [fence({ droppedRecords: 1, oversizedRecords: 0, failed: false })],
      options: {},
    },
    {
      reason: "read-failed",
      read: () => {
        throw new Error("private trace path must not escape");
      },
      options: {},
    },
  ];
  for (const testCase of cases) {
    await assert.rejects(
      waitForCanonicalFrameFence(testCase.read, expected, testCase.options),
      (error) => {
        assert.equal(error.boundary, "coherent-terminal-publication");
        assert.equal(error.observation.reason, testCase.reason);
        assert.equal(JSON.stringify(error.observation).includes("private trace path"), false);
        const state = productRigTerminalFailureState(error, "product-rig-startup");
        assert.equal(state.firstBrokenBoundary, "coherent-terminal-publication");
        assert.equal(state.failureObservation, error.observation);
        return true;
      },
    );
  }
});

test("preseeded pane evidence rejects inactive-window native duplicates", () => {
  const sample = {
    paneId: "%1",
    semanticPaneId: "pane.one",
    geometryStable: true,
    geometry: { height: 40 },
    bodyRect: { valid: true, bodyRows: 40 },
    nativeTargetOccurrences: 1,
    nativeOtherOccurrences: 0,
    renderedTargetOccurrences: 1,
    renderedOutsideOccurrences: 0,
  };
  assert.equal(qualifyPreseededPaneEvidence(sample), true);
  assert.equal(qualifyPreseededPaneEvidence({ ...sample, nativeOtherOccurrences: 1 }), false);
  assert.throws(
    () =>
      qualifyPreseededPaneEvidence(
        { ...sample, nativeOtherOccurrences: 1 },
        { throwOnFailure: true },
      ),
    /preseeded coherent pane proof failed/u,
  );
});

function configlessSessionRow({
  sessionName = "ordinary",
  sessionId = "$1",
  adoptionStamp = "",
  promotedStamp = "",
  workspaceNameStamp = "",
  promotionOperationStamp = "",
  workspaceOpenStamp = "",
  workspaceOpenOperationStamp = "",
  sentinel = CONFIGLESS_TMUX_SESSION_ROW_SENTINEL,
} = {}) {
  return [
    sessionName,
    sessionId,
    adoptionStamp,
    promotedStamp,
    workspaceNameStamp,
    promotionOperationStamp,
    workspaceOpenStamp,
    workspaceOpenOperationStamp,
    sentinel,
  ].join(CONFIGLESS_TMUX_SESSION_FIELD_SEPARATOR);
}

test("configless tmux inventory binds one exact session row and all six stamps", () => {
  const inventory = parseConfiglessTmuxSessionInventory(
    [
      configlessSessionRow({ sessionName: "ordinary-prefix", sessionId: "$0" }),
      configlessSessionRow({
        sessionId: "$1",
        adoptionStamp: "1",
        promotedStamp: "1",
        workspaceNameStamp: "workspace-opaque",
        promotionOperationStamp: "operation-1",
      }),
    ].join("\n"),
    "ordinary",
  );
  assert.deepEqual(inventory.sessionNames, ["ordinary-prefix", "ordinary"]);
  assert.deepEqual(inventory.exact, {
    sessionName: "ordinary",
    sessionId: "$1",
    adoptionStamp: "1",
    promotedStamp: "1",
    workspaceNameStamp: "workspace-opaque",
    promotionOperationStamp: "operation-1",
    workspaceOpenStamp: null,
    workspaceOpenOperationStamp: null,
  });
});

test("configless tmux inventory rejects duplicate, malformed, colliding, and oversized rows", () => {
  const valid = configlessSessionRow();
  assert.throws(
    () => parseConfiglessTmuxSessionInventory(`${valid}\n${valid}`, "ordinary"),
    /expected one exact session row/u,
  );
  assert.throws(
    () =>
      parseConfiglessTmuxSessionInventory(
        configlessSessionRow({ sentinel: "wrong-sentinel" }),
        "ordinary",
      ),
    /row is malformed/u,
  );
  assert.throws(
    () =>
      parseConfiglessTmuxSessionInventory(
        configlessSessionRow({
          workspaceNameStamp: `bad${CONFIGLESS_TMUX_SESSION_FIELD_SEPARATOR}`,
        }),
        "ordinary",
      ),
    /row is malformed/u,
  );
  assert.throws(
    () => parseConfiglessTmuxSessionInventory(`${valid}${"x".repeat(65 * 1024)}`, "ordinary"),
    /input is malformed/u,
  );
});

test("configless tmux inventory format reads exact real tmux session ids when available", (t) => {
  if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) {
    t.skip("tmux is unavailable");
    return;
  }
  const fixtureRoot = mkdtempSync(join(tmpdir(), "tmux-ide-configless-inventory-"));
  const socketPath = join(fixtureRoot, "fixture.sock");
  try {
    execFileSync("tmux", ["-S", socketPath, "new-session", "-d", "-s", "ordinary"]);
    execFileSync("tmux", ["-S", socketPath, "new-session", "-d", "-s", "ordinary-prefix"]);
    for (const [option, value] of [
      ["@tmux_ide_adopted", "1"],
      ["@tmux_ide_workspace_promoted_v1", "1"],
      ["@tmux_ide_workspace_name", "workspace-opaque"],
      ["@tmux_ide_workspace_promote_operation", "operation-1"],
    ])
      execFileSync("tmux", ["-S", socketPath, "set-option", "-t", "ordinary", option, value]);
    const inventory = parseConfiglessTmuxSessionInventory(
      execFileSync(
        "tmux",
        ["-S", socketPath, "list-sessions", "-F", CONFIGLESS_TMUX_SESSION_FORMAT],
        {
          encoding: "utf8",
        },
      ),
      "ordinary",
    );
    assert.match(inventory.exact.sessionId, /^\$[0-9]+$/u);
    assert.equal(inventory.exact.adoptionStamp, "1");
    assert.equal(inventory.exact.workspaceNameStamp, "workspace-opaque");
    assert.deepEqual(new Set(inventory.sessionNames), new Set(["ordinary", "ordinary-prefix"]));
  } finally {
    spawnSync("tmux", ["-S", socketPath, "kill-server"], { stdio: "ignore" });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("fresh FleetCatalog reader invalidates every poll and never memoizes a pre-stamp row", async () => {
  const calls = [];
  const read = createFreshFleetCatalogReader(async (path, init) => {
    calls.push({ path, init });
    return { sessions: calls.length === 1 ? [] : [{ sessionId: "opaque-1" }] };
  });
  assert.deepEqual(await read(), { sessions: [] });
  assert.deepEqual(await read(), { sessions: [{ sessionId: "opaque-1" }] });
  assert.deepEqual(calls, [
    {
      path: "/api/resources/fleet-catalog?productRigRead=1",
      init: { cache: "no-store" },
    },
    {
      path: "/api/resources/fleet-catalog?productRigRead=2",
      init: { cache: "no-store" },
    },
  ]);
});

test("complete diagnostic correlation requires exact daemon, client, TUI and Web state", () => {
  const committed = {
    generation: 2,
    target: { workspaceName: "workspace-opaque", daemon: { instanceId: "daemon-1" } },
    phase: "live",
    authorityWorkspaceId: "workspace.id",
    authorityWorkspaceName: "ordinary workspace",
    catalog: {
      daemonInstanceId: "daemon-1",
      intents: [
        { workspaceName: "workspace-opaque", sessionName: "ordinary", availability: "live" },
      ],
      liveSessions: [{ sessionName: "ordinary", fleetSessionId: "opaque-1" }],
    },
    authority: {
      generation: "daemon-1",
      session: "ordinary",
      revision: 7,
      owners: { input: "opentui:41", focus: "opentui:41", geometry: "opentui:41" },
    },
    terminalResources: [
      {
        resourceId: "resource.one",
        windowResourceId: "terminal-window.one",
        active: true,
        semanticPaneId: "pane.one",
      },
    ],
  };
  const derived = {
    workspace: { id: "workspace.id", name: "ordinary workspace" },
    terminalInventory: {
      resources: [
        {
          id: "resource.one",
          windowResourceId: "terminal-window.one",
          active: true,
          attachability: { status: "available", semanticPaneId: "pane.one" },
        },
      ],
    },
  };
  const state = {
    status: "ready",
    workspace: "workspace-opaque",
    session: "ordinary",
    daemon: {
      instanceId: "daemon-1",
      revision: "a".repeat(20),
      revisionKind: "fleet-catalog",
      pid: 41,
      port: 4200,
    },
    convergence: {
      workspaceClient: {
        committed,
        pending: [],
        derived,
        record: { processId: "opentui:41" },
      },
    },
  };
  const expected = {
    daemonGeneration: "daemon-1",
    workspaceName: "workspace-opaque",
    sessionName: "ordinary",
    fleetSessionId: "opaque-1",
    catalogRevision: "a".repeat(20),
    semanticPaneId: "pane.one",
  };
  const web = {
    shellSource: "runtime",
    terminalPhases: ["connected"],
    terminals: [
      { phase: "connected", workspaceName: "workspace-opaque", semanticPaneId: "pane.one" },
    ],
    windowContainerCount: 1,
    windows: [
      {
        windowResourceId: "terminal-window.one",
        semanticPaneIds: '["pane.one"]',
        paneCount: "1",
        active: "true",
      },
    ],
    hostCorrelation: {
      bootstrapDaemon: "daemon-1",
      listDaemon: "daemon-1",
      shellDaemon: "daemon-1",
      domDaemonGeneration: "daemon-1",
      workspaceRow: {
        workspaceName: "workspace-opaque",
        sessionName: "ordinary",
        availability: "live",
      },
      shellWorkspaceId: "workspace.id",
      shellWorkspaceName: "ordinary workspace",
      shellFleetSessionId: "opaque-1",
      terminalResources: [
        {
          resourceId: "resource.one",
          windowResourceId: "terminal-window.one",
          active: true,
          semanticPaneId: "pane.one",
        },
      ],
    },
  };
  const correlation = buildProductDiagnosticCorrelation({
    state,
    tuiAvailable: true,
    webAvailable: true,
    expected,
    web,
  });
  assert.equal(correlation.complete, true);
  assert.deepEqual(correlation.missing, []);
  assert.equal(correlation.daemonState.revision, "a".repeat(20));
  assert.deepEqual(correlation.clientState.pending, []);
  for (const mutate of [
    (web) => ({ ...web, shellSource: "fixture" }),
    (web) => ({
      ...web,
      hostCorrelation: { ...web.hostCorrelation, listDaemon: "daemon-stale" },
    }),
    (web) => ({
      ...web,
      hostCorrelation: { ...web.hostCorrelation, shellFleetSessionId: "opaque-other" },
    }),
    (web) => ({
      ...web,
      hostCorrelation: {
        ...web.hostCorrelation,
        terminalResources: [{ resourceId: "resource.other", semanticPaneId: "pane.one" }],
      },
    }),
    (web) => ({
      ...web,
      hostCorrelation: {
        ...web.hostCorrelation,
        terminalResources: web.hostCorrelation.terminalResources.map((resource) => ({
          ...resource,
          windowResourceId: "terminal-window.other",
        })),
      },
    }),
    (web) => ({
      ...web,
      terminals: [
        { phase: "connected", workspaceName: "workspace-other", semanticPaneId: "pane.one" },
      ],
    }),
    (web) => ({
      ...web,
      terminals: [
        ...web.terminals,
        { phase: "disconnected", workspaceName: "workspace-opaque", semanticPaneId: "pane.stale" },
      ],
    }),
  ]) {
    const rejected = buildProductDiagnosticCorrelation({
      state,
      tuiAvailable: true,
      webAvailable: true,
      expected,
      web: mutate(web),
    });
    assert.equal(rejected.complete, false);
    assert.ok(rejected.missing.includes("web.semantic"));
  }
  for (const workspaceClient of [
    { ...state.convergence.workspaceClient, committed: { ...committed, target: null } },
    {
      ...state.convergence.workspaceClient,
      committed: { ...committed, authority: { ...committed.authority, session: "other" } },
    },
    {
      ...state.convergence.workspaceClient,
      committed: {
        ...committed,
        terminalResources: [{ resourceId: "resource.other", semanticPaneId: "pane.one" }],
      },
    },
    { ...state.convergence.workspaceClient, pending: [{ operationId: "pending" }] },
    {
      ...state.convergence.workspaceClient,
      derived: { ...derived, workspace: { ...derived.workspace, id: "workspace.other" } },
    },
  ]) {
    const rejected = buildProductDiagnosticCorrelation({
      state: { ...state, convergence: { workspaceClient } },
      tuiAvailable: true,
      webAvailable: true,
      expected,
      web,
    });
    assert.equal(rejected.complete, false);
    assert.ok(rejected.missing.includes("workspaceClient.correlation"));
  }
});

test("selected-window Web proof correlates unordered complete groups to one active surface", () => {
  const resources = [
    {
      id: "resource.two",
      windowResourceId: "window.two",
      active: false,
      attachability: { status: "available", semanticPaneId: "pane.two" },
    },
    {
      id: "resource.one-b",
      windowResourceId: "window.one",
      active: false,
      attachability: { status: "available", semanticPaneId: "pane.one-b" },
    },
    {
      id: "resource.one-a",
      windowResourceId: "window.one",
      active: true,
      attachability: { status: "available", semanticPaneId: "pane.one-a" },
    },
  ];
  const web = {
    windowContainerCount: 1,
    terminals: [
      {
        phase: "connected",
        workspaceName: "workspace",
        semanticPaneId: "pane.one-a",
      },
    ],
    windows: [
      {
        windowResourceId: "window.two",
        semanticPaneIds: '["pane.two"]',
        paneCount: "1",
        active: "false",
      },
      {
        windowResourceId: "window.one",
        semanticPaneIds: '["pane.one-a","pane.one-b"]',
        paneCount: "2",
        active: "true",
      },
    ],
  };
  const qualify = (candidate) =>
    qualifySelectedWindowWebSemantic({
      web: candidate,
      derivedResources: resources,
      expectedWorkspaceName: "workspace",
      expectedSemanticPaneId: "pane.one-a",
    });
  assert.equal(qualify(web), true);
  for (const rejected of [
    { ...web, windowContainerCount: 2 },
    { ...web, windows: web.windows.slice(0, 1) },
    { ...web, windows: [...web.windows, web.windows[0]] },
    {
      ...web,
      windows: web.windows.map((window) => ({ ...window, active: "true" })),
    },
    {
      ...web,
      windows: web.windows.map((window, index) =>
        index === 1 ? { ...window, semanticPaneIds: '["pane.one-a","pane.unknown"]' } : window,
      ),
    },
    {
      ...web,
      terminals: [...web.terminals, { ...web.terminals[0], phase: "disconnected" }],
    },
    {
      ...web,
      terminals: [{ ...web.terminals[0], semanticPaneId: "pane.two" }],
    },
  ])
    assert.equal(qualify(rejected), false);
  assert.equal(
    qualifySelectedWindowWebSemantic({
      web,
      derivedResources: resources.map((resource) => ({
        ...resource,
        active: resource.attachability.semanticPaneId === "pane.one-b",
      })),
      expectedWorkspaceName: "workspace",
      expectedSemanticPaneId: "pane.one-a",
    }),
    false,
  );
});

test("legacy runtime correlation remains compatible while supplied malformed exact scope fails closed", () => {
  const input = {
    state: {
      status: "ready",
      daemon: { instanceId: "daemon-1", revision: 7 },
      convergence: {
        workspaceClient: { committed: { phase: "live" }, pending: [], derived: {} },
      },
    },
    tuiAvailable: true,
    webAvailable: true,
    web: { shellSource: "runtime", terminalPhases: ["connected"] },
  };
  assert.equal(buildProductDiagnosticCorrelation({ ...input, expected: null }).complete, true);
  const legacyMissing = buildProductDiagnosticCorrelation({
    ...input,
    state: { ...input.state, daemon: { instanceId: "daemon-1" } },
    expected: null,
  });
  assert.equal(legacyMissing.complete, false);
  assert.ok(legacyMissing.missing.includes("daemon.revision"));
  const malformed = buildProductDiagnosticCorrelation({
    ...input,
    expected: { daemonGeneration: "daemon-1", workspaceName: null },
  });
  assert.equal(malformed.complete, false);
  assert.ok(malformed.missing.includes("workspaceClient.correlation"));
  assert.ok(malformed.missing.includes("web.semantic"));
});

test("configless report remains incomplete at its earliest unmeasured causal boundary", () => {
  const timeline = [
    "namespace-clean",
    "public-cli-spawn",
    "daemon-election",
    "ordinary-session-discovery",
    "canonical-promotion-adoption",
    "coherent-terminal-publication",
    "web-started-after-cold-boundary",
  ].map((phase) => ({ phase }));
  const assessment = assessConfiglessJourneyBoundaries({
    timeline,
    correlationComplete: true,
    correlationMissing: [],
    canonicalSeedPaintComplete: true,
    automaticPromotionCausalityComplete: false,
  });
  assert.equal(assessment.firstBrokenBoundary, null);
  assert.equal(assessment.firstUnmeasuredBoundary, "automatic-promotion-causality");
  assert.equal(assessment.status, "incomplete");
  assert.equal(
    assessment.boundaries.find(({ id }) => id === "canonical-seed-paint-correlation")?.status,
    "passed",
  );
});

test("configless report status passes only with no broken or unmeasured boundary", () => {
  const phases = [
    "namespace-clean",
    "public-cli-spawn",
    "daemon-election",
    "ordinary-session-discovery",
    "canonical-promotion-adoption",
    "coherent-terminal-publication",
    "web-started-after-cold-boundary",
  ];
  const assess = (timeline, overrides = {}) =>
    assessConfiglessJourneyBoundaries({
      timeline,
      correlationComplete: true,
      correlationMissing: [],
      automaticPromotionCausalityComplete: true,
      canonicalSeedPaintComplete: true,
      ...overrides,
    });
  const passed = assess(phases.map((phase) => ({ phase })));
  assert.deepEqual(
    {
      status: passed.status,
      firstBrokenBoundary: passed.firstBrokenBoundary,
      firstUnmeasuredBoundary: passed.firstUnmeasuredBoundary,
    },
    { status: "passed", firstBrokenBoundary: null, firstUnmeasuredBoundary: null },
  );
  const failed = assess(
    phases.filter((phase) => phase !== "daemon-election").map((phase) => ({ phase })),
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.firstBrokenBoundary, "daemon-election");
  assert.equal(
    assess(
      phases.map((phase) => ({ phase })),
      { correlationComplete: false },
    ).status,
    "incomplete",
  );
});

test("automatic configless selection is one ordered same-process sole-session sequence", () => {
  const records = [
    { phase: "session-discovery-start", processId: "opentui:1", clockId: "clock" },
    {
      phase: "session-discovery-end",
      sessions: 1,
      processId: "opentui:1",
      clockId: "clock",
    },
    {
      phase: "config-load-end",
      sessions: 1,
      target: "ordinary",
      processId: "opentui:1",
      clockId: "clock",
    },
  ];
  assert.equal(
    qualifyAutomaticConfiglessSelection(records, "ordinary").configured.target,
    "ordinary",
  );
  assert.throws(
    () =>
      qualifyAutomaticConfiglessSelection(
        records.map((record) =>
          record.phase === "session-discovery-end" ? { ...record, sessions: 2 } : record,
        ),
        "ordinary",
      ),
    /sole discovered session/u,
  );
});

test("WorkspaceClient correlation selects the latest exact live process and generation", async () => {
  const exact = {
    phase: "generation-workspace-client-state",
    processId: "opentui:41",
    daemonGeneration: "daemon-1",
    workspaceClient: {
      committed: {
        generation: 2,
        target: { workspaceName: "workspace-opaque", daemon: { instanceId: "daemon-1" } },
        phase: "live",
        authorityWorkspaceId: "workspace.id",
        authorityWorkspaceName: "ordinary workspace",
        catalog: {
          daemonInstanceId: "daemon-1",
          intents: [
            {
              workspaceName: "workspace-opaque",
              sessionName: "ordinary",
              availability: "live",
            },
          ],
          liveSessions: [{ sessionName: "ordinary", fleetSessionId: "opaque-1" }],
        },
        authority: {
          generation: "daemon-1",
          session: "ordinary",
          revision: 7,
          owners: { input: "opentui:41", focus: "opentui:41", geometry: "opentui:41" },
        },
        terminalResources: [{ resourceId: "resource.one", semanticPaneId: "pane.one" }],
      },
      pending: [],
      derived: {
        workspace: { id: "workspace.id", name: "ordinary workspace" },
        terminalInventory: {
          resources: [
            {
              id: "resource.one",
              attachability: { status: "available", semanticPaneId: "pane.one" },
            },
          ],
        },
      },
    },
  };
  const expectedWorkspaceClient = {
    processId: "opentui:41",
    daemonGeneration: "daemon-1",
    workspaceName: "workspace-opaque",
    sessionName: "ordinary",
    fleetSessionId: "opaque-1",
    semanticPaneId: "pane.one",
    canonicalGeneration: "daemon-1",
  };
  const qualified = qualifyWorkspaceClientState(
    [
      { ...exact, processId: "opentui:old" },
      {
        ...exact,
        workspaceClient: { ...exact.workspaceClient, pending: [{ operationId: "old" }] },
      },
      exact,
    ],
    expectedWorkspaceClient,
  );
  assert.deepEqual(qualified.pending, []);
  assert.throws(
    () =>
      qualifyWorkspaceClientState(
        [{ ...exact, workspaceClient: { ...exact.workspaceClient, derived: null } }],
        expectedWorkspaceClient,
      ),
    /committed\/pending\/derived state is unavailable/u,
  );
  for (const workspaceClient of [
    {
      ...exact.workspaceClient,
      committed: { ...exact.workspaceClient.committed, authorityWorkspaceId: "other.id" },
    },
    {
      ...exact.workspaceClient,
      committed: { ...exact.workspaceClient.committed, authorityWorkspaceName: "other workspace" },
    },
    { ...exact.workspaceClient, pending: [{ operationId: "still-pending" }] },
    {
      ...exact.workspaceClient,
      committed: {
        ...exact.workspaceClient.committed,
        catalog: {
          ...exact.workspaceClient.committed.catalog,
          intents: [
            {
              workspaceName: "other-workspace",
              sessionName: "ordinary",
              availability: "live",
            },
          ],
        },
      },
    },
    {
      ...exact.workspaceClient,
      committed: {
        ...exact.workspaceClient.committed,
        authority: { ...exact.workspaceClient.committed.authority, session: "other" },
      },
    },
    {
      ...exact.workspaceClient,
      committed: {
        ...exact.workspaceClient.committed,
        authority: {
          ...exact.workspaceClient.committed.authority,
          owners: { input: "client:tui", focus: "client:tui", geometry: "client:tui" },
        },
      },
    },
    {
      ...exact.workspaceClient,
      committed: {
        ...exact.workspaceClient.committed,
        terminalResources: [{ resourceId: "resource.other", semanticPaneId: "pane.one" }],
      },
    },
    {
      ...exact.workspaceClient,
      committed: {
        ...exact.workspaceClient.committed,
        catalog: {
          ...exact.workspaceClient.committed.catalog,
          liveSessions: [{ sessionName: "ordinary", fleetSessionId: "opaque-other" }],
        },
      },
    },
  ])
    assert.throws(
      () => qualifyWorkspaceClientState([{ ...exact, workspaceClient }], expectedWorkspaceClient),
      /committed\/pending\/derived state is unavailable/u,
    );
  const stale = {
    ...exact,
    workspaceClient: {
      ...exact.workspaceClient,
      committed: {
        ...exact.workspaceClient.committed,
        catalog: { daemonInstanceId: null, intents: [], liveSessions: [] },
      },
    },
  };
  let reads = 0;
  const settled = await waitForQualifiedWorkspaceClientState(
    async () => (++reads === 1 ? [stale] : [stale, exact]),
    expectedWorkspaceClient,
    { attempts: 2, pause: async () => undefined },
  );
  assert.deepEqual(settled.pending, []);
  let persistentFailure = null;
  try {
    await waitForQualifiedWorkspaceClientState(async () => [stale], expectedWorkspaceClient, {
      attempts: 2,
      pause: async () => undefined,
    });
  } catch (error) {
    persistentFailure = error;
  }
  assert.equal(persistentFailure?.boundary, "diagnostic-correlation");
  assert.equal(persistentFailure?.observation?.scope, "workspace-client");
  assert.equal(
    persistentFailure?.observation?.predicates.find(({ id }) => id === "catalog-daemon")?.status,
    "failed",
  );
  assert.equal(
    productRigTerminalFailureState(persistentFailure, "product-rig-startup").firstBrokenBoundary,
    "diagnostic-correlation",
  );
});

test("canonical seed validator requires exact identity, order, and stable geometry", () => {
  const identity = {
    processId: "opentui:1",
    clockId: "opentui-performance-now",
    clockKind: "performance-now",
    semanticPaneId: "pane.one",
    generation: "generation-1",
    incarnation: "generation-1:0",
    revision: 0,
    stateHash: "a1d4bef4c2291a16",
    cols: 80,
    rows: 24,
    sourceEpoch: 1,
  };
  const records = [
    {
      type: "performance.terminal-canonical-publication",
      updateType: "terminal.seed",
      ...identity,
      atMicros: 10,
    },
    {
      type: "performance.terminal-canonical-paint",
      ...identity,
      atMicros: 20,
      viewportCols: 80,
      viewportRows: 23,
      writtenRows: Array.from({ length: 23 }, (_, row) => row),
    },
  ];
  assert.equal(
    qualifyCanonicalSeedPaint(records, {
      semanticPaneId: "pane.one",
      generation: "generation-1",
      canonicalCols: 80,
      canonicalRows: 24,
      viewportCols: 80,
      viewportRows: 23,
      processId: "opentui:1",
      clockId: "opentui-performance-now",
      sourceEpoch: 1,
    }).paint.stateHash,
    "a1d4bef4c2291a16",
  );
  assert.throws(
    () =>
      qualifyCanonicalSeedPaint([records[0], { ...records[1], stateHash: "later-patch" }], {
        semanticPaneId: "pane.one",
        generation: "generation-1",
        canonicalCols: 80,
        canonicalRows: 24,
        viewportCols: 80,
        viewportRows: 23,
        processId: "opentui:1",
        clockId: "opentui-performance-now",
        sourceEpoch: 1,
      }),
    /diverged at stateHash/u,
  );
  assert.throws(
    () =>
      qualifyCanonicalSeedPaint([records[0]], {
        semanticPaneId: "pane.one",
        generation: "generation-1",
        canonicalCols: 80,
        canonicalRows: 24,
        viewportCols: 80,
        viewportRows: 23,
        processId: "opentui:1",
        clockId: "opentui-performance-now",
        sourceEpoch: 1,
      }),
    /one stable-geometry publication and one paint/u,
  );
  assert.throws(
    () =>
      qualifyCanonicalSeedPaint([{ ...records[0], updateType: "terminal.patch" }, records[1]], {
        semanticPaneId: "pane.one",
        generation: "generation-1",
        canonicalCols: 80,
        canonicalRows: 24,
        viewportCols: 80,
        viewportRows: 23,
        processId: "opentui:1",
        clockId: "opentui-performance-now",
        sourceEpoch: 1,
      }),
    /not an exact terminal.seed/u,
  );
  assert.throws(
    () =>
      qualifyCanonicalSeedPaint([records[0], { ...records[1], clockKind: "wall-clock" }], {
        semanticPaneId: "pane.one",
        generation: "generation-1",
        canonicalCols: 80,
        canonicalRows: 24,
        viewportCols: 80,
        viewportRows: 23,
        processId: "opentui:1",
        clockId: "opentui-performance-now",
        sourceEpoch: 1,
      }),
    /one stable-geometry publication and one paint/u,
  );
  for (const malformed of [
    { incarnation: "" },
    { revision: -1 },
    { revision: 1.5 },
    { stateHash: "not-a-canonical-hash" },
  ])
    assert.throws(
      () =>
        qualifyCanonicalSeedPaint([{ ...records[0], ...malformed }, records[1]], {
          semanticPaneId: "pane.one",
          generation: "generation-1",
          canonicalCols: 80,
          canonicalRows: 24,
          viewportCols: 80,
          viewportRows: 23,
          processId: "opentui:1",
          clockId: "opentui-performance-now",
          sourceEpoch: 1,
        }),
      /missing or malformed/u,
    );
});

test("canonical seed validator maps tmux 132x40 to canonical 132x41 and viewport 132x40", () => {
  const source = {
    processId: "opentui:41",
    clockId: "opentui-performance-now",
    clockKind: "performance-now",
    semanticPaneId: "pane.run",
    generation: "daemon-run",
    sourceEpoch: 1,
  };
  const initial = {
    ...source,
    incarnation: "daemon-run:0",
    revision: 2,
    stateHash: "1111111111111111",
    cols: 160,
    rows: 42,
  };
  const stable = {
    ...source,
    incarnation: "daemon-run:0",
    revision: 3,
    stateHash: "2222222222222222",
    cols: 132,
    rows: 41,
  };
  const initialPublications = Array.from({ length: 5 }, (_, index) => ({
    type: "performance.terminal-canonical-publication",
    updateType: "terminal.seed",
    ...initial,
    atMicros: index + 1,
  }));
  const initialPaints = Array.from({ length: 2 }, (_, index) => ({
    type: "performance.terminal-canonical-paint",
    ...initial,
    atMicros: index + 6,
    viewportCols: 160,
    viewportRows: 41,
    writtenRows: Array.from({ length: 41 }, (_unused, row) => row),
  }));
  const publication = {
    type: "performance.terminal-canonical-publication",
    updateType: "terminal.seed",
    ...stable,
    atMicros: 10,
  };
  const paint = {
    type: "performance.terminal-canonical-paint",
    ...stable,
    atMicros: 11,
    viewportCols: 132,
    viewportRows: 40,
    writtenRows: Array.from({ length: 40 }, (_unused, row) => row),
  };
  const records = [...initialPublications, ...initialPaints, publication, paint];
  const expected = {
    semanticPaneId: "pane.run",
    generation: "daemon-run",
    canonicalCols: 132,
    canonicalRows: 41,
    viewportCols: 132,
    viewportRows: 40,
    processId: "opentui:41",
    clockId: "opentui-performance-now",
    sourceEpoch: 1,
  };
  assert.equal(qualifyCanonicalSeedPaint(records, expected).publication.revision, 3);
  assert.throws(
    () => qualifyCanonicalSeedPaint([...records, { ...publication, atMicros: 10.5 }], expected),
    /received 2\/1/u,
  );
  assert.throws(
    () => qualifyCanonicalSeedPaint([...records, { ...paint, atMicros: 11.5 }], expected),
    /received 1\/2/u,
  );
  assert.throws(
    () =>
      qualifyCanonicalSeedPaint(
        [
          { ...publication, rows: 40 },
          {
            ...paint,
            rows: 40,
            viewportRows: 39,
            writtenRows: Array.from({ length: 39 }, (_unused, row) => row),
          },
        ],
        expected,
      ),
    /received 0\/0/u,
  );
});

test("canonical seed validator rejects an intervening same-source patch and preserves its boundary", () => {
  const identity = {
    processId: "opentui:41",
    clockId: "opentui-performance-now",
    clockKind: "performance-now",
    semanticPaneId: "pane.run",
    generation: "daemon-run",
    incarnation: "daemon-run:0",
    revision: 3,
    stateHash: "2222222222222222",
    cols: 132,
    rows: 41,
    sourceEpoch: 1,
  };
  const publication = {
    type: "performance.terminal-canonical-publication",
    updateType: "terminal.seed",
    ...identity,
    atMicros: 10,
  };
  const patch = {
    type: "performance.terminal-canonical-publication",
    updateType: "terminal.patch",
    ...identity,
    cols: 131,
    atMicros: 11,
  };
  const paint = {
    type: "performance.terminal-canonical-paint",
    ...identity,
    atMicros: 12,
    viewportCols: 132,
    viewportRows: 40,
    writtenRows: Array.from({ length: 40 }, (_unused, row) => row),
  };
  let failure = null;
  try {
    qualifyCanonicalSeedPaint([publication, patch, paint], {
      semanticPaneId: "pane.run",
      generation: "daemon-run",
      canonicalCols: 132,
      canonicalRows: 41,
      viewportCols: 132,
      viewportRows: 40,
      processId: "opentui:41",
      clockId: "opentui-performance-now",
      sourceEpoch: 1,
    });
  } catch (error) {
    failure = error;
  }
  assert.match(failure?.message ?? "", /intervening canonical update/u);
  assert.equal(failure?.boundary, "canonical-seed-paint-correlation");
  assert.deepEqual(productRigTerminalFailureState(failure, "product-rig-startup"), {
    status: "failed",
    failure: failure.stack,
    firstBrokenBoundary: "canonical-seed-paint-correlation",
    failureObservation: failure.observation,
  });
});

test("canonical promotion qualification names every fail-closed predicate", () => {
  const base = {
    observed: {
      adoptionStamp: "1",
      promotedStamp: "1",
      workspaceNameStamp: "workspace.one",
      promotionOperationStamp: "operation-one",
      workspaceOpenStamp: null,
      workspaceOpenOperationStamp: null,
    },
    catalog: {
      daemon: { instanceId: "daemon-1" },
      intents: [{ workspaceName: "workspace.one", sessionName: "ordinary", availability: "live" }],
      liveSessions: [{ sessionName: "ordinary", fleetSessionId: "session.opaque" }],
    },
    fleet: {
      daemon: { instanceId: "daemon-1" },
      catalogRevision: "a".repeat(20),
      sessions: [{ label: "ordinary", sessionId: "session.opaque" }],
    },
    daemonInstanceId: "daemon-1",
    sessionName: "ordinary",
    discoveredFleetSessionId: "session.opaque",
  };
  const accepted = qualifyCanonicalPromotionAdoption(base);
  assert.equal(accepted.passed, true);
  assert.equal(accepted.predicates.length, 14);
  assert.equal(accepted.evidence.workspaceName, "workspace.one");

  const mutations = new Map([
    [
      "adoption-stamp",
      (value) => ({ ...value, observed: { ...value.observed, adoptionStamp: null } }),
    ],
    [
      "promotion-stamp",
      (value) => ({ ...value, observed: { ...value.observed, promotedStamp: null } }),
    ],
    [
      "workspace-name-stamp",
      (value) => ({ ...value, observed: { ...value.observed, workspaceNameStamp: "other" } }),
    ],
    [
      "promotion-operation-stamp",
      (value) => ({ ...value, observed: { ...value.observed, promotionOperationStamp: "" } }),
    ],
    [
      "workspace-open-stamp-absent",
      (value) => ({ ...value, observed: { ...value.observed, workspaceOpenStamp: "1" } }),
    ],
    [
      "workspace-open-operation-stamp-absent",
      (value) => ({
        ...value,
        observed: { ...value.observed, workspaceOpenOperationStamp: "operation" },
      }),
    ],
    [
      "workspace-intent-unique",
      (value) => ({ ...value, catalog: { ...value.catalog, intents: [] } }),
    ],
    [
      "workspace-live-row-unique",
      (value) => ({ ...value, catalog: { ...value.catalog, liveSessions: [] } }),
    ],
    ["fleet-row-unique", (value) => ({ ...value, fleet: { ...value.fleet, sessions: [] } })],
    [
      "workspace-catalog-daemon",
      (value) => ({ ...value, catalog: { ...value.catalog, daemon: { instanceId: "other" } } }),
    ],
    [
      "fleet-catalog-daemon",
      (value) => ({ ...value, fleet: { ...value.fleet, daemon: { instanceId: "other" } } }),
    ],
    [
      "fleet-catalog-revision",
      (value) => ({ ...value, fleet: { ...value.fleet, catalogRevision: "invalid" } }),
    ],
    [
      "workspace-live-fleet-session",
      (value) => ({
        ...value,
        catalog: {
          ...value.catalog,
          liveSessions: [{ sessionName: "ordinary", fleetSessionId: "other" }],
        },
      }),
    ],
    [
      "fleet-row-session",
      (value) => ({
        ...value,
        fleet: { ...value.fleet, sessions: [{ label: "ordinary", sessionId: "other" }] },
      }),
    ],
  ]);
  for (const { id } of accepted.predicates) {
    const rejected = qualifyCanonicalPromotionAdoption(mutations.get(id)(base));
    assert.equal(rejected.passed, false, id);
    assert.equal(
      rejected.predicates.find((predicate) => predicate.id === id)?.status,
      "failed",
      id,
    );
    assert.equal(rejected.evidence, null);
  }
});

test("promotion predicate signatures preserve types and delimiter-bearing values", () => {
  const signature = (actual) =>
    canonicalPromotionPredicateSignature([{ id: "predicate:one|two", status: "failed", actual }]);
  assert.notEqual(signature(false), signature("false"));
  assert.notEqual(signature("a|b:c"), signature("a:b|c"));
  assert.equal(signature("a|b:c"), signature("a|b:c"));
});

test("production configless operations preserve exact public entry and discovery ordering", async () => {
  const calls = [];
  let adopted = false;
  let catalogReads = 0;
  let fleetReads = 0;
  const namespace = {
    session: "ordinary",
    runtimeNamespace: {
      home: "/private/home",
      stateDir: "/private/state",
      daemonInfoDir: "/private/daemon",
      registryDir: "/private/registry",
      settingsDir: "/private/settings",
      tmuxSocketPath: "/private/t.sock",
      projectDir: "/private/project",
    },
  };
  const operations = createConfiglessProductJourneyOwnerOperations({
    createNamespace: async (options) => {
      calls.push(["create", options]);
      return namespace;
    },
    inspectNamespace: async () => ({
      workspaceConfigExists: false,
      legacyConfigExists: false,
      daemonEntries: [],
      registryEntries: [],
      sessionNames: ["ordinary"],
      adoptionStamp: adopted ? "1" : null,
      promotedStamp: adopted ? "1" : null,
      workspaceNameStamp: adopted ? "workspace-opaque" : null,
      promotionOperationStamp: adopted ? "operation" : null,
      workspaceOpenStamp: null,
      workspaceOpenOperationStamp: null,
    }),
    recordBoundary: async (name, detail) => {
      calls.push([name, detail]);
    },
    buildBeforeMeasurement: async () => calls.push(["build"]),
    launchPublicEntry: async (launch) => {
      calls.push(["launch", launch]);
      return { pid: 41 };
    },
    observeElectedDaemon: async () => ({ record: { instanceId: "daemon-1" } }),
    readPublicLifecycle: async () => [
      { phase: "session-discovery-start", processId: "opentui:41", clockId: "clock" },
      {
        phase: "session-discovery-end",
        sessions: 1,
        processId: "opentui:41",
        clockId: "clock",
      },
      {
        phase: "config-load-end",
        sessions: 1,
        target: "ordinary",
        processId: "opentui:41",
        clockId: "clock",
      },
    ],
    poll: async (_label, probe) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const value = await probe();
        if (value) return value;
      }
      assert.fail("poll did not settle");
    },
    readWorkspaceCatalog: async () => {
      catalogReads += 1;
      if (catalogReads > 1) adopted = true;
      return {
        daemon: { instanceId: "daemon-1" },
        liveSessions: [{ sessionName: "ordinary", fleetSessionId: "opaque-1" }],
        intents: adopted
          ? [
              {
                sessionName: "ordinary",
                workspaceName: "workspace-opaque",
                availability: "live",
              },
            ]
          : [],
      };
    },
    readFleetCatalog: async () => {
      fleetReads += 1;
      return {
        daemon: { instanceId: "daemon-1" },
        catalogRevision: "a".repeat(20),
        sessions: adopted && fleetReads > 1 ? [{ label: "ordinary", sessionId: "opaque-1" }] : [],
      };
    },
    proveCoherentPublication: async () => {
      calls.push(["coherent"]);
      return { passed: true };
    },
    startWebAfterColdBoundary: async () => {
      calls.push(["web"]);
      return { connected: true };
    },
  });
  await runConfiglessProductJourneyOwnerBoot(operations);

  assert.deepEqual(calls[0], ["create", { adoptSessions: false }]);
  const launch = calls.find(([name]) => name === "launch")[1];
  assert.deepEqual(launch.argv, []);
  assert.equal(launch.cwd, "/private/project");
  assert.equal(launch.environment.TMUX, "");
  assert.equal(launch.environment.TMUX_IDE_TMUX_SOCKET_PATH, "/private/t.sock");
  assert.equal("TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON" in launch.environment, false);
  assert.equal(
    calls.some(([name]) => name === "select"),
    false,
  );
  assert.ok(catalogReads >= 2);
  assert.equal(fleetReads, 2);
  assert.equal(
    calls.find(([name]) => name === "canonical-promotion-adoption")[1].workspaceName,
    "workspace-opaque",
  );
  assert.equal(
    calls.find(([name]) => name === "canonical-promotion-adoption")[1].catalogRevision,
    "a".repeat(20),
  );
  assert.ok(
    calls.findIndex(([name]) => name === "coherent") < calls.findIndex(([name]) => name === "web"),
  );
});

test("promotion rejects wrong workspace stamps, missing operation receipts, and open residue", async () => {
  const namespace = { session: "ordinary" };
  const daemon = { record: { instanceId: "daemon-1" } };
  const discovered = { fleetSessionId: "opaque-1" };
  for (const observed of [
    {
      adoptionStamp: "1",
      promotedStamp: "1",
      workspaceNameStamp: "wrong-workspace",
      promotionOperationStamp: "operation",
      workspaceOpenStamp: null,
      workspaceOpenOperationStamp: null,
    },
    {
      adoptionStamp: "1",
      promotedStamp: "1",
      workspaceNameStamp: "workspace-opaque",
      promotionOperationStamp: null,
      workspaceOpenStamp: null,
      workspaceOpenOperationStamp: null,
    },
    {
      adoptionStamp: "1",
      promotedStamp: "1",
      workspaceNameStamp: "workspace-opaque",
      promotionOperationStamp: "operation",
      workspaceOpenStamp: "1",
      workspaceOpenOperationStamp: "open-operation",
    },
  ]) {
    const observations = [];
    const operations = createConfiglessProductJourneyOwnerOperations({
      inspectNamespace: async () => observed,
      readWorkspaceCatalog: async () => ({
        daemon: { instanceId: "daemon-1" },
        liveSessions: [{ sessionName: "ordinary", fleetSessionId: "opaque-1" }],
        intents: [
          {
            sessionName: "ordinary",
            workspaceName: "workspace-opaque",
            availability: "live",
          },
        ],
      }),
      readFleetCatalog: async () => ({
        daemon: { instanceId: "daemon-1" },
        catalogRevision: "a".repeat(20),
        sessions: [{ label: "ordinary", sessionId: "opaque-1" }],
      }),
      poll: async (_label, probe) => {
        assert.equal(await probe(), null);
        throw new Error("promotion evidence incomplete");
      },
      recordObservation: async (_phase, observation) => observations.push(observation),
    });
    await assert.rejects(
      operations.adoptThroughPublicApp(namespace, daemon, discovered),
      (error) =>
        error.boundary === "canonical-promotion-adoption" &&
        error.observation === observations.at(-1) &&
        error.observation.predicates.some(({ status }) => status === "failed"),
    );
  }
  const malformedRevision = createConfiglessProductJourneyOwnerOperations({
    inspectNamespace: async () => ({
      adoptionStamp: "1",
      promotedStamp: "1",
      workspaceNameStamp: "workspace-opaque",
      promotionOperationStamp: "operation",
      workspaceOpenStamp: null,
      workspaceOpenOperationStamp: null,
    }),
    readWorkspaceCatalog: async () => ({
      daemon: { instanceId: "daemon-1" },
      liveSessions: [{ sessionName: "ordinary", fleetSessionId: "opaque-1" }],
      intents: [
        {
          sessionName: "ordinary",
          workspaceName: "workspace-opaque",
          availability: "live",
        },
      ],
    }),
    readFleetCatalog: async () => ({
      daemon: { instanceId: "daemon-1" },
      catalogRevision: "not-a-fleet-revision",
      sessions: [{ label: "ordinary", sessionId: "opaque-1" }],
    }),
    poll: async (_label, probe) => {
      assert.equal(await probe(), null);
      throw new Error("promotion evidence incomplete");
    },
  });
  await assert.rejects(
    malformedRevision.adoptThroughPublicApp(namespace, daemon, discovered),
    (error) =>
      error.boundary === "canonical-promotion-adoption" &&
      error.observation.predicates.find(({ id }) => id === "fleet-catalog-revision")?.status ===
        "failed",
  );
});

test("production configless operations fail before public launch on contaminated state", async () => {
  let launched = false;
  const operations = createConfiglessProductJourneyOwnerOperations({
    createNamespace: async () => ({
      session: "ordinary",
      runtimeNamespace: {
        home: "/h",
        stateDir: "/s",
        daemonInfoDir: "/d",
        registryDir: "/r",
        settingsDir: "/g",
        tmuxSocketPath: "/t",
        projectDir: "/p",
      },
    }),
    inspectNamespace: async () => ({
      workspaceConfigExists: true,
      legacyConfigExists: false,
      daemonEntries: [],
      registryEntries: [],
      sessionNames: ["ordinary"],
      adoptionStamp: null,
      promotedStamp: null,
      workspaceNameStamp: null,
      promotionOperationStamp: null,
      workspaceOpenStamp: null,
      workspaceOpenOperationStamp: null,
    }),
    launchPublicEntry: async () => {
      launched = true;
    },
  });
  await assert.rejects(runConfiglessProductJourneyOwnerBoot(operations), /contaminated/u);
  assert.equal(launched, false);
});
