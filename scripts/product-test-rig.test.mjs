import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES,
  PRODUCT_RIG_STATE_VERSION,
  activeTmuxPaneFromRows,
  boundedSourceTraceDiff,
  buildProductDiagnosticReport,
  causalInputSamples,
  coherentReadiness,
  coherentGenerationDuration,
  inputPaintSamples,
  paneBodyRegion,
  paneGeometryIdentity,
  publicRigStatus,
  readJson,
  resolvePaneBodyRect,
  summarizeProductResources,
  writeJsonAtomic,
} from "./product-test-rig-lib.mjs";
import { sourceArchitectureInventory } from "./architecture-debt-inventory.mjs";
import { buildTuiHostPublicationEvidence } from "./lib/tui-host-publication.mjs";

test("source provenance accepts patches above Node's default buffer and enforces a hard ceiling", () => {
  const aboveNodeDefault = "x".repeat(1024 * 1024 + 1);
  assert.equal(boundedSourceTraceDiff(aboveNodeDefault), aboveNodeDefault);
  assert.throws(
    () => boundedSourceTraceDiff("x".repeat(PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES + 1)),
    /hard ceiling/u,
  );
});

test("host publication proof requires chrome and generation-local terminal bytes", () => {
  const first = buildTuiHostPublicationEvidence({
    frame: " tmux-ide  F2 Terminals\nprompt FIRST_GENERATION_MARKER",
    kind: "terminal",
    token: "FIRST_GENERATION_MARKER",
    generation: "generation-a",
    processId: 11,
    elapsedMs: 42.4,
  });
  const second = buildTuiHostPublicationEvidence({
    frame: " tmux-ide  F2 Terminals\nprompt SECOND_GENERATION_MARKER",
    kind: "terminal",
    token: "SECOND_GENERATION_MARKER",
    generation: "generation-b",
    processId: 12,
    elapsedMs: 39.7,
  });
  assert.equal(first.passed, true);
  assert.equal(second.passed, true);
  assert.notEqual(first.frameHash, second.frameHash);
  assert.equal(
    buildTuiHostPublicationEvidence({
      frame: "",
      kind: "terminal",
      token: "SECOND_GENERATION_MARKER",
    }).passed,
    false,
  );
  assert.equal(
    buildTuiHostPublicationEvidence({
      frame: "tmux-ide without the requested terminal bytes",
      kind: "terminal",
      token: "SECOND_GENERATION_MARKER",
    }).passed,
    false,
  );
  assert.equal(
    buildTuiHostPublicationEvidence({ frame: "tmux-ide", kind: "terminal" }).passed,
    false,
  );
  assert.throws(
    () => buildTuiHostPublicationEvidence({ frame: "tmux-ide", kind: "paint" }),
    /chrome or terminal/u,
  );
});

test("normalizes external host generation marks for warm coherent timing", () => {
  const lifecycle = [
    {
      phase: "generation-connection-resolved",
      daemonGeneration: "generation-a",
      elapsedMs: 100,
    },
    {
      phase: "first-terminal-frame",
      daemonGeneration: "generation-a",
      elapsedMs: 300,
    },
    {
      phase: "host-terminal-publication",
      generation: "generation-a",
      elapsedMs: 325,
    },
  ];
  assert.equal(coherentGenerationDuration(lifecycle), 225);
});

test("resolves active tmux runtime and semantic pane identities together", () => {
  const pane = activeTmuxPaneFromRows(
    [
      "%1|1|0|pane.promoted.left|0|0|50|30",
      "%2|1|1|pane.promoted.right|51|0|50|30",
      "%3|0|1|pane.promoted.hidden|0|0|101|30",
    ].join("\n"),
  );
  assert.deepEqual(pane, {
    paneId: "%2",
    windowActive: true,
    paneActive: true,
    semanticPaneId: "pane.promoted.right",
    left: 51,
    top: 0,
    width: 50,
    height: 30,
  });
  assert.equal(activeTmuxPaneFromRows("%1|1|1||0|0|50|30"), null);
});

test("anchors a two-pane framebuffer body to semantic chrome when tmux origin drifted", () => {
  const frame = [
    " tmux-ide",
    " one",
    "● pane.promoted.left".padEnd(50) + " " + "○ pane.promoted.right".padEnd(50),
    "left seed".padEnd(50) + " " + "__right_unique_marker__".padEnd(50),
    "".padEnd(50) + " " + "right row two".padEnd(50),
  ].join("\n");
  const pane = {
    semanticPaneId: "pane.promoted.right",
    // Deliberately stale/impossible origin: this is the failure mode the live
    // evidence previously hashed as an almost-empty rectangle.
    left: 7,
    top: 28,
    width: 50,
    height: 3,
  };
  assert.deepEqual(resolvePaneBodyRect(frame, pane), {
    left: 51,
    firstBodyRow: 3,
    width: 50,
    bodyRows: 2,
    origin: "semantic-pane-chrome",
    valid: true,
    semanticChromeMatches: 1,
  });
  assert.match(paneBodyRegion(frame, pane), /__right_unique_marker__/u);
  assert.doesNotMatch(paneBodyRegion(frame, pane), /left seed/u);
});

test("fails closed when duplicate semantic chrome could map a marker to the wrong pane", () => {
  const frame = [
    " tmux-ide",
    " one",
    "● pane.duplicate".padEnd(30) + "○ pane.duplicate".padEnd(30),
    // The marker expected for the RIGHT-hand pane appears only in the first,
    // wrong rectangle. A first-match resolver would therefore false-pass.
    "__right_marker__".padEnd(30) + "right has no marker".padEnd(30),
  ].join("\n");
  const pane = {
    semanticPaneId: "pane.duplicate",
    left: 30,
    top: 0,
    width: 30,
    height: 2,
  };
  assert.match(frame.split("\n")[3].slice(0, 30), /__right_marker__/u);
  assert.doesNotMatch(frame.split("\n")[3].slice(30, 60), /__right_marker__/u);
  assert.deepEqual(resolvePaneBodyRect(frame, pane), {
    left: 30,
    firstBodyRow: 3,
    width: 30,
    bodyRows: 0,
    origin: "semantic-pane-chrome-ambiguous",
    valid: false,
    semanticChromeMatches: 2,
  });
  assert.equal(paneBodyRegion(frame, pane), "");
});

test("pane geometry identity is order-independent and changes on any rectangle mutation", () => {
  const left = {
    paneId: "%1",
    semanticPaneId: "pane.left",
    left: 0,
    top: 0,
    width: 50,
    height: 30,
  };
  const right = {
    paneId: "%2",
    semanticPaneId: "pane.right",
    left: 51,
    top: 0,
    width: 50,
    height: 30,
  };
  assert.equal(paneGeometryIdentity([left, right]), paneGeometryIdentity([right, left]));
  assert.notEqual(
    paneGeometryIdentity([left, right]),
    paneGeometryIdentity([left, { ...right, left: 52 }]),
  );
});

test("coherent readiness never aliases app chrome to terminal readiness", () => {
  assert.deepEqual(coherentReadiness({ chromeMs: 12.4, terminalMs: null }), {
    appChromeFrameMs: 12,
    coherentTerminalFrameMs: null,
    ready: false,
  });
  assert.equal(coherentReadiness({ chromeMs: 12, terminalMs: 31 }).ready, true);
});

test("correlates same-client stages and daemon-local spans without subtracting clocks", () => {
  const traceId = "00000000-0000-4000-8000-000000000123";
  const samples = causalInputSamples(
    [
      {
        type: "performance.stage",
        traceId,
        stage: "input",
        processId: "opentui:1",
        clockId: "client-clock",
        startedAtMicros: 1_000,
      },
      {
        type: "performance.stage",
        traceId,
        stage: "client",
        operation: "lane-enqueue",
        processId: "opentui:1",
        clockId: "client-clock",
        atMicros: 2_000,
      },
      {
        type: "performance.stage",
        traceId,
        stage: "paint",
        processId: "opentui:1",
        clockId: "client-clock",
        endedAtMicros: 9_000,
        generation: "generation",
      },
    ],
    [
      {
        type: "performance.stage",
        traceId,
        stage: "tmux",
        operation: "raw-input-command",
        processId: "daemon:2",
        clockId: "daemon-clock",
        startedAtMicros: 50_000,
        endedAtMicros: 53_000,
      },
      {
        type: "performance.stage",
        traceId,
        stage: "tmux",
        operation: "control-write",
        processId: "daemon:2",
        clockId: "daemon-clock",
        startedAtMicros: 53_100,
        endedAtMicros: 53_200,
      },
      {
        type: "performance.stage",
        traceId,
        stage: "tmux",
        operation: "first-output-observed",
        processId: "daemon:2",
        clockId: "daemon-clock",
        startedAtMicros: 70_000,
        endedAtMicros: 70_100,
      },
    ],
  );
  assert.deepEqual(samples[0]?.clientStages, [{ operation: "lane-enqueue", offsetMs: 1 }]);
  assert.deepEqual(samples[0]?.daemonSpans, [
    {
      stage: "tmux",
      operation: "raw-input-command",
      offsetMs: 0,
      durationMs: 3,
      processId: "daemon:2",
      clockId: "daemon-clock",
    },
    {
      stage: "tmux",
      operation: "control-write",
      offsetMs: 3.1,
      durationMs: 0.1,
      processId: "daemon:2",
      clockId: "daemon-clock",
    },
    {
      stage: "tmux",
      operation: "first-output-observed",
      offsetMs: 20,
      durationMs: 0.1,
      processId: "daemon:2",
      clockId: "daemon-clock",
    },
  ]);
});

test("labels latest-input next-output evidence as diagnostic rather than causal", () => {
  const report = buildProductDiagnosticReport({
    state: { status: "ready", daemon: { instanceId: "generation" }, convergence: null },
    truth: { session: "alpha", windows: [], panes: [] },
    lifecycle: [],
    traceRecords: [],
    daemonTraceRecords: [],
    stderr: "",
  });
  assert.equal(report.inputCausalSummary.causalAttribution, false);
  assert.equal(report.inputCausalSummary.correlation, "latest-input-to-next-output-probe");
  assert.equal(report.firstBrokenInputBoundary, null);
  assert.ok(
    report.boundaries.some(
      (boundary) => boundary.id === "input-enqueue-to-correlated-changed-cell-paint",
    ),
  );
});

test("requires a closed zero-drop reference trace summary", () => {
  const base = {
    state: { status: "ready", daemon: { instanceId: "generation" }, convergence: null },
    truth: { session: "alpha", windows: [], panes: [] },
    lifecycle: [],
    stderr: "",
  };
  const missing = buildProductDiagnosticReport({ ...base, traceRecords: [] });
  assert.equal(
    missing.boundaries.find((boundary) => boundary.id === "reference-trace-integrity")?.status,
    "unmeasured",
  );
  const dropped = buildProductDiagnosticReport({
    ...base,
    traceRecords: [
      {
        type: "performance.trace.summary",
        acceptedRecords: 10,
        droppedRecords: 1,
        oversizedRecords: 0,
        failed: false,
        saturated: false,
        pendingInputs: 0,
        droppedInputs: 0,
      },
    ],
  });
  assert.equal(
    dropped.boundaries.find((boundary) => boundary.id === "reference-trace-integrity")?.status,
    "failed",
  );
});

test("pairs only same-clock input and changed-cell paint traces", () => {
  const samples = inputPaintSamples([
    {
      type: "performance.stage",
      traceId: "one",
      stage: "input",
      processId: "tui:1",
      clockId: "clock",
      startedAtMicros: 1_000,
    },
    {
      type: "performance.stage",
      traceId: "one",
      stage: "paint",
      processId: "tui:1",
      clockId: "clock",
      endedAtMicros: 9_000,
      generation: "generation",
      semanticPaneId: "%1",
      revision: 4,
      stateHash: "abcd1234",
      paintStateIdentity: "latest-canonical-state-blitted",
    },
    {
      type: "performance.stage",
      traceId: "cross-clock",
      stage: "input",
      processId: "tui:1",
      clockId: "a",
      startedAtMicros: 1_000,
    },
    {
      type: "performance.stage",
      traceId: "cross-clock",
      stage: "paint",
      processId: "tui:1",
      clockId: "b",
      endedAtMicros: 2_000,
    },
  ]);
  assert.deepEqual(samples, [
    {
      traceId: "one",
      durationMs: 8,
      generation: "generation",
      processId: "tui:1",
      clockId: "clock",
      semanticPaneId: "%1",
      revision: 4,
      stateHash: "abcd1234",
      paintStateIdentity: "latest-canonical-state-blitted",
    },
  ]);
});

test("qualifies paint evidence only when it names the latest canonical state blitted", () => {
  const traceRecords = [
    { type: "performance.trace.header", processId: "tui:1" },
    {
      type: "performance.stage",
      traceId: "trace",
      stage: "input",
      processId: "tui:1",
      clockId: "clock",
      startedAtMicros: 1_000,
    },
    {
      type: "performance.stage",
      traceId: "trace",
      stage: "paint",
      processId: "tui:1",
      clockId: "clock",
      endedAtMicros: 2_000,
      generation: "generation",
      semanticPaneId: "%1",
      revision: 2,
      stateHash: "latest-hash",
      paintStateIdentity: "latest-canonical-state-blitted",
    },
  ];
  const base = {
    state: { status: "ready", daemon: { instanceId: "generation" }, convergence: null },
    truth: { session: "alpha", windows: [], panes: [] },
    lifecycle: [],
    traceRecords,
    stderr: "",
  };
  const evidence = {
    traceId: "trace",
    semanticPaneId: "%1",
    revision: 2,
    stateHash: "latest-hash",
    markerVisibleInNative: true,
    markerVisibleInPaneRect: true,
    paintStateIdentity: "latest-canonical-state-blitted",
  };
  assert.equal(
    buildProductDiagnosticReport({ ...base, qualifyingInputEvidence: [evidence] }).inputSamples
      .length,
    1,
  );
  const { paintStateIdentity: _omitted, ...unproven } = evidence;
  void _omitted;
  assert.equal(
    buildProductDiagnosticReport({ ...base, qualifyingInputEvidence: [unproven] }).inputSamples
      .length,
    0,
  );
});

test("rejects duplicate trace endpoints instead of silently choosing the last sample", () => {
  const base = {
    type: "performance.stage",
    traceId: "duplicate",
    processId: "tui:1",
    clockId: "clock",
  };
  assert.deepEqual(
    inputPaintSamples([
      { ...base, stage: "input", startedAtMicros: 1 },
      { ...base, stage: "input", startedAtMicros: 2 },
      { ...base, stage: "paint", endedAtMicros: 3 },
    ]),
    [],
  );
});

test("extracts proof only from the pane body rectangle", () => {
  const frame = ["header", "tabs", "chrome A", "left-marker   sibling", "chrome B marker"].join(
    "\n",
  );
  assert.equal(paneBodyRegion(frame, { left: 0, top: 0, width: 12, height: 2 }), "left-marker ");
  assert.doesNotMatch(paneBodyRegion(frame, { left: 13, top: 0, width: 7, height: 2 }), /marker/u);
});

test("resource evidence requires a distribution and proves queues settle", () => {
  const clientStages = Array.from({ length: 16 }, (_, index) => ({
    rssBytes: 100_000 + index,
    heapUsedBytes: 50_000 + index,
    inputPending: index === 15 ? 0 : 1,
    inputInFlight: index === 15 ? 0 : 1,
    inputPendingBytes: index === 15 ? 0 : 1,
  }));
  const observation = summarizeProductResources(clientStages, [
    {
      queuePeak: 1,
      queueCapacity: 1,
      settledQueueDepth: 0,
      revisionLagPeak: 0,
    },
  ]);
  assert.equal(observation.memorySampleCount, 16);
  assert.equal(observation.settledInputPending, 0);
  assert.equal(observation.settledInputInFlight, 0);
  assert.equal(observation.settledDeliveryQueueDepth, 0);
  assert.equal(observation.rssGrowthBytes, 15);
  assert.equal(observation.heapGrowthBytes, 15);
  assert.equal(observation.rssRobustSlopeBytesPerSample, 1);
  assert.equal(observation.heapRobustSlopeBytesPerSample, 1);
});

test("resource retention uses only exact acknowledged endpoint traces", () => {
  const stages = [
    ...Array.from({ length: 16 }, (_, index) => ({
      traceId: `noise-${index}`,
      rssBytes: 900_000 + index * 10_000,
      heapUsedBytes: 800_000 + index * 10_000,
    })),
    ...Array.from({ length: 16 }, (_, index) => ({
      traceId: `endpoint-${index}`,
      rssBytes: 100_000 + index,
      heapUsedBytes: 50_000 + index,
      inputPending: 0,
      inputInFlight: 0,
    })),
  ];
  const observation = summarizeProductResources(
    stages,
    [],
    Array.from({ length: 16 }, (_, index) => `endpoint-${index}`),
  );
  assert.equal(observation.memorySampleCount, 16);
  assert.equal(observation.rssPeakBytes, 100_015);
  assert.equal(observation.heapGrowthBytes, 15);
});

test("resource growth uses ordered quiescent endpoints, not a GC max-min range", () => {
  const clientStages = Array.from({ length: 16 }, (_, index) => ({
    traceId: `trace-${index}`,
    rssBytes: index === 8 ? 200_000 : 100_000 + index,
    heapUsedBytes: index < 8 ? 150_000 : 50_000 + index,
    inputPending: 0,
    inputInFlight: 0,
    inputPendingBytes: 0,
  }));
  const observation = summarizeProductResources(clientStages, []);
  assert.equal(observation.rssPeakBytes, 200_000);
  assert.equal(observation.rssGrowthBytes, 15);
  assert.equal(observation.heapPeakBytes, 150_000);
  assert.equal(observation.heapGrowthBytes, 0);
});

test("diagnostic report names the first causal break and never passes unmeasured gates", () => {
  const report = buildProductDiagnosticReport({
    state: {
      status: "ready",
      daemon: { instanceId: "generation" },
      convergence: {
        restart: {
          elapsedMs: 100,
          webRecovered: true,
          tuiRecovered: true,
          hostedTuiInputPainted: true,
        },
      },
    },
    truth: { session: "alpha", windows: ["window"], panes: ["pane"] },
    lifecycle: [
      { phase: "generation-connection-resolved", daemonGeneration: "generation", elapsedMs: 10 },
      {
        phase: "generation-shell-lifecycle",
        clientPhase: "live",
        shellStatus: "live",
        inventoryResources: 1,
        elapsedMs: 20,
      },
      {
        phase: "generation-runtime-progress",
        runtimePhase: "coherent",
        panes: 1,
        seededPanes: 1,
        elapsedMs: 30,
      },
      {
        phase: "generation-status",
        status: "live",
        daemonGeneration: "generation",
        elapsedMs: 31,
      },
    ],
    traceRecords: [],
    stderr: "",
    framebufferEvidence: { passed: true, detail: "1/1 visible pane bodies matched" },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.firstBrokenBoundary, "tui-painted-frame");
  assert.equal(report.firstUnmeasuredBoundary, "reference-trace-integrity");
  assert.deepEqual(report.framebufferEvidence, {
    passed: true,
    detail: "1/1 visible pane bodies matched",
  });
});

test("state artifacts are atomic and public status redacts browser authority", () => {
  const root = mkdtempSync(join(tmpdir(), "tmi-product-rig-test-"));
  try {
    const path = join(root, "state.json");
    writeJsonAtomic(path, {
      version: PRODUCT_RIG_STATE_VERSION,
      status: "ready",
      ownerPid: process.pid,
      runtimeNamespace: { tmuxSocketPath: "/tmp/test.sock" },
      web: { pageUrl: "http://127.0.0.1:5173/?devHost=1", browserWsEndpoint: "secret" },
      daemon: { pid: process.pid, port: 1234, instanceId: "generation", authToken: "secret" },
    });
    assert.equal(readJson(path).status, "ready");
    const publicStatus = publicRigStatus(readJson(path));
    assert.equal(publicStatus.running, true);
    assert.equal("browserWsEndpoint" in publicStatus.web, false);
    assert.equal("authToken" in publicStatus.daemon, false);
    assert.doesNotMatch(readFileSync(path, "utf8"), /\.tmp/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("architecture inventory emits grouped, machine-readable deletion reports", () => {
  const repo = new URL("../", import.meta.url).pathname;
  const report = sourceArchitectureInventory(repo);
  assert.equal(report.version, 1);
  assert.equal("generatedAt" in report, false);
  assert.deepEqual(Object.keys(report.groups).sort(), [
    "direct-tmux",
    "grouped-pty",
    "v1-catalog",
    "v1-default-authority",
    "v1-standalone-authority",
  ]);
  for (const group of Object.values(report.groups)) {
    assert.equal(group.remainingUseCount, group.entries.length);
    assert.equal(group.remainingFileCount, group.uses.length);
    assert.equal(group.zeroUse, group.remainingUseCount === 0);
    assert.deepEqual(
      [...group.uses].sort((left, right) => left.localeCompare(right)),
      group.uses,
    );
    for (const entry of group.entries) {
      assert.ok(entry.line > 0);
      assert.ok(group.uses.includes(entry.file));
    }
  }
});

test("architecture debt cannot grow beyond the checked-in deletion budget", () => {
  const repo = new URL("../", import.meta.url).pathname;
  const report = sourceArchitectureInventory(repo);
  const budget = JSON.parse(
    readFileSync(new URL("./architecture-debt-budget.json", import.meta.url), "utf8"),
  );
  assert.equal(budget.version, 1);
  for (const [name, groupBudget] of Object.entries(budget.groups)) {
    const group = report.groups[name];
    assert.ok(group, `missing inventory group ${name}`);
    assert.ok(
      group.remainingUseCount <= groupBudget.maximumUses,
      `${name} grew from budget ${groupBudget.maximumUses} to ${group.remainingUseCount}`,
    );
    assert.equal(groupBudget.targetUses, 0, `${name} must retain an explicit zero-use target`);
  }
});

test("checked-in product baseline is honest and safe to inventory", () => {
  const baseline = JSON.parse(
    readFileSync(new URL("../docs/product/product-baseline.json", import.meta.url), "utf8"),
  );
  assert.equal(baseline.qualification, "not-product-qualified");
  assert.deepEqual(baseline.defaultProduct.primarySurfaces, ["home", "terminals"]);
  assert.deepEqual(baseline.defaultProduct.quarantinedSurfaces, [
    "files",
    "changes",
    "missions",
    "activity",
  ]);
  assert.equal(baseline.portablePerformance.status, "passed-with-limitations");
  assert.equal(baseline.portablePerformance.coherentTerminalFrame, "not-measured");
  assert.equal(baseline.portablePerformance.inputToPaint, "not-measured");
  assert.ok(baseline.knownDefects.every((defect) => defect.reproduce.length > 0));
  assert.match(baseline.completionPolicy, /not Done/u);
  const lineCount = (path) =>
    readFileSync(new URL(path, import.meta.url), "utf8").split("\n").length;
  assert.equal(
    lineCount("../packages/daemon/src/tui/mirror/runtime/application-root.tsx"),
    baseline.sourceMeasurements.openTuiApplicationRootLines + 1,
  );
  assert.equal(
    lineCount("../apps/desktop-renderer/src/experience/application-shell.tsx"),
    baseline.sourceMeasurements.webApplicationShellLines + 1,
  );
  assert.equal(
    lineCount("../apps/desktop-renderer/src/experience/workspace-tiled-surface.tsx"),
    baseline.sourceMeasurements.webWorkspaceTiledSurfaceLines + 1,
  );
});
