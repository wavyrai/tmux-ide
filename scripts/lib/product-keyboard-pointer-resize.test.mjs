import assert from "node:assert/strict";
import test from "node:test";

import { parseLayout } from "../../packages/daemon/src/terminal/protocol/layout-parse.ts";

import {
  assessExactResizeTmuxBaseline,
  assessResizePostPromotionCommands,
  assessKeyboardPointerResizeJourneyBoundaries,
  assessProductKeyboardPointerResize,
  inspectResizeContentContinuity,
  inspectResizeGuideFramebuffer,
} from "./product-keyboard-pointer-resize.mjs";

const exactResizeTmuxBaseline = () => {
  const visibleLayout = "a1b2,132x41,0,0{66x41,0,0,7,65x41,67,0,8}";
  return {
    visibleLayout,
    layout: parseLayout(visibleLayout),
    panes: [
      {
        visibleLayout,
        paneBorderStatus: "top",
        paneId: "%7",
        semanticPaneId: "pane.main",
        left: 0,
        top: 1,
        width: 66,
        height: 40,
        processId: 7001,
        currentCommand: "node",
      },
      {
        visibleLayout,
        paneBorderStatus: "top",
        paneId: "%8",
        semanticPaneId: "pane.second",
        left: 67,
        top: 1,
        width: 65,
        height: 40,
        processId: 7002,
        currentCommand: "node",
      },
    ],
    seedPaneId: "%7",
    expectedCommand: "node",
    targetMarkerCount: 1,
    otherMarkerCount: 0,
  };
};

test("qualifies the exact pre-TUI visible-layout and native-pane baseline", () => {
  const baseline = exactResizeTmuxBaseline();
  assert.deepEqual(assessExactResizeTmuxBaseline(baseline), {
    exact: true,
    paneCount: 2,
    leafCount: 2,
  });
  for (const mutate of [
    (value) => (value.layout.height = 40),
    (value) => (value.layout.leaves[1].left = 66),
    (value) => (value.panes[0].height = 41),
    (value) => (value.panes[0].paneBorderStatus = "off"),
    (value) => (value.panes[0].currentCommand = "zsh"),
    (value) => (value.panes[1].processId = value.panes[0].processId),
    (value) => (value.panes[1].paneId = "%7"),
    (value) => (value.otherMarkerCount = 1),
  ]) {
    const adversary = structuredClone(baseline);
    mutate(adversary);
    assert.equal(assessExactResizeTmuxBaseline(adversary).exact, false);
  }
});

test("post-promotion resize validation admits only bounded read-only tmux commands", () => {
  const reads = [
    ["list-panes"],
    ["capture-pane"],
    ["capture-pane"],
    ["list-panes"],
    ["capture-pane"],
    ["capture-pane"],
  ];
  assert.equal(assessResizePostPromotionCommands(reads), true);
  for (const mutation of ["set-option", "resize-window", "select-layout", "split-window"])
    assert.equal(assessResizePostPromotionCommands([...reads, [mutation]]), false);
  assert.equal(assessResizePostPromotionCommands(reads.slice(0, 5)), false);
});

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const expected = Object.freeze({
  processId: "opentui:42",
  daemonGeneration: UUID,
  clientGeneration: 3,
  workspaceName: "workspace.product",
  sessionName: "session.product",
  semanticPaneId: "pane.main",
});
const health = Object.freeze({ droppedRecords: 0, failed: false, pendingCriticalRecords: 0 });
const contentContinuity = () => ({
  exact: true,
  reason: null,
  markerCount: 1,
  nonBlankCells: 32,
  markerHash: "d".repeat(64),
  frameDigest: "e".repeat(64),
});
const delivery = (kind, action, point = { x: 66, y: 3 }) => ({
  version: 1,
  kind,
  target: "%7",
  paneId: "%7",
  sessionId: "$3",
  geometry: { cols: 160, rows: 44 },
  delivery: "exact-bytes-to-immutable-host-pane-pty",
  bytesInjected: 6,
  ...(kind === "modified-key"
    ? { requestedKey: "right", requestedModifiers: ["meta"] }
    : { requestedAction: action, requestedPoint: point }),
});
const target = (source, operationId) => ({
  ...expected,
  source,
  operationId,
  axis: "cols",
  beforeCells: 65,
  requestedCells: 66,
  settledCells: 66,
  receipt: {
    operationId,
    verb: "workspace.pane.resize",
    axis: "cols",
    requestedCells: 66,
    outcome: "applied",
    cells: 66,
  },
  layout: { operationId, cells: 66 },
  frame: {
    operationId,
    identityExact: true,
    presentationChanged: true,
    presentationDigest: "b".repeat(64),
    contentContinuity: contentContinuity(),
  },
  fence: { writerHealth: health },
  delivery: delivery(
    source === "keyboard" ? "modified-key" : "application-mouse",
    source === "pointer" ? "up" : null,
  ),
});
function evidence() {
  return {
    baseline: expected,
    keyboard: target("keyboard", "223e4567-e89b-42d3-a456-426614174000"),
    pointerPreviews: Array.from({ length: 30 }, (_, ordinal) => {
      const traceId = `123e4567-e89b-42d3-a456-${String(ordinal).padStart(12, "0")}`;
      return {
        ...expected,
        ordinal,
        traceId,
        axis: "cols",
        cells: ordinal % 2 === 0 ? 66 : 65,
        durationMs: 4 + ordinal / 100,
        guide: { x: 66, y: 3, width: 1, height: 40, digest: "a".repeat(64) },
        actualFrame: {
          traceId,
          guideDigest: "a".repeat(64),
          presentationDigest: "b".repeat(64),
          presentationChanged: true,
          identityExact: true,
          framebuffer: {
            exact: true,
            matchCount: 40,
            frameDigest: "c".repeat(64),
          },
          contentContinuity: contentContinuity(),
        },
        fence: { writerHealth: health },
        delivery: delivery("application-mouse", "drag"),
        pointerIngress: {
          gestureId: UUID,
          traceId,
          action: "drag",
          x: 66,
          y: 3,
          atMicros: ordinal,
        },
      };
    }),
    pointerRelease: {
      ...target("pointer", "323e4567-e89b-42d3-a456-426614174000"),
      pointerIngress: {
        gestureId: UUID,
        traceId: "423e4567-e89b-42d3-a456-426614174000",
        action: "up",
        x: 66,
        y: 3,
        atMicros: 31,
      },
    },
    tmux: { semanticPaneId: "pane.main", cols: 66, geometryStable: true },
    workspaceClient: {
      pendingCount: 0,
      semanticPaneId: "pane.main",
      lastReceiptOperationId: "323e4567-e89b-42d3-a456-426614174000",
      lastReceiptPhase: "observed",
    },
    correlation: { daemon: true, workspaceClient: true, tui: true, web: true, tmux: true },
  };
}

test("qualifies exact keyboard and 30-sample pointer resize evidence", () => {
  const assessment = assessProductKeyboardPointerResize({ evidence: evidence(), expected });
  assert.equal(assessment.qualified, true);
  assert.equal(assessment.metrics.sampleCount, 30);
  assert.equal(assessment.metrics.previewP95Ms, 4.28);
});

test("qualifies horizontal pointer guide, row receipt, layout, and tmux convergence", () => {
  const value = evidence();
  for (const sample of value.pointerPreviews) {
    sample.axis = "rows";
    sample.cells = 40;
    sample.guide = { x: 28, y: 22, width: 132, height: 1, digest: "a".repeat(64) };
    sample.delivery = delivery("application-mouse", "drag", { x: 40, y: 22 });
    sample.pointerIngress = { ...sample.pointerIngress, x: 40, y: 22 };
    sample.actualFrame.framebuffer.matchCount = 132;
  }
  Object.assign(value.pointerRelease, {
    axis: "rows",
    beforeCells: 39,
    requestedCells: 40,
    settledCells: 40,
    receipt: {
      ...value.pointerRelease.receipt,
      axis: "rows",
      requestedCells: 40,
      cells: 40,
    },
    layout: { ...value.pointerRelease.layout, cells: 40 },
    delivery: delivery("application-mouse", "up", { x: 40, y: 22 }),
    pointerIngress: { ...value.pointerRelease.pointerIngress, x: 40, y: 22 },
  });
  value.tmux = { semanticPaneId: "pane.main", rows: 40, geometryStable: true };
  assert.equal(assessProductKeyboardPointerResize({ evidence: value, expected }).qualified, true);
});

test("framebuffer guide inspector rejects missing, duplicate, overdraw, and wrong coordinates", () => {
  const frame = (placements) => {
    const rows = Array.from({ length: 6 }, () => Array.from({ length: 12 }, () => " "));
    for (const [x, y, marker = "╎"] of placements) rows[y][x] = marker;
    return rows.map((row) => row.join("")).join("\n");
  };
  const guide = { x: 4, y: 1, width: 1, height: 3 };
  const exact = [
    [4, 1],
    [4, 2],
    [4, 3],
  ];
  assert.equal(
    inspectResizeGuideFramebuffer({ plain: frame(exact), cols: 12, rows: 6, guide, axis: "cols" })
      .exact,
    true,
  );
  for (const placements of [exact.slice(1), [...exact, [5, 3]], exact.map(([x, y]) => [x + 1, y])])
    assert.equal(
      inspectResizeGuideFramebuffer({
        plain: frame(placements),
        cols: 12,
        rows: 6,
        guide,
        axis: "cols",
      }).exact,
      false,
    );
});

test("content continuity inspector rejects blank, missing, duplicate, and non-rectangular marker frames", () => {
  const marker = "RIG_RESIZE_MARKER";
  const frame = (line) => `${line.padEnd(24)}\n${" ".repeat(24)}`;
  const exact = inspectResizeContentContinuity({
    plain: frame(marker),
    cols: 24,
    rows: 2,
    marker,
  });
  assert.equal(exact.exact, true);
  assert.equal(exact.markerCount, 1);
  assert.match(exact.markerHash, /^[0-9a-f]{64}$/u);
  assert.match(exact.frameDigest, /^[0-9a-f]{64}$/u);
  for (const plain of [frame(""), frame(`${marker}${marker}`), `${marker}\n`])
    assert.equal(inspectResizeContentContinuity({ plain, cols: 24, rows: 2, marker }).exact, false);
});

test("fails closed on missing, duplicate, slow, stale, or unhealthy preview evidence", () => {
  for (const mutate of [
    (value) => value.pointerPreviews.pop(),
    (value) => (value.pointerPreviews[1].traceId = value.pointerPreviews[0].traceId),
    (value) => {
      value.pointerPreviews[28].durationMs = 17;
      value.pointerPreviews[29].durationMs = 17;
    },
    (value) => (value.pointerPreviews[0].actualFrame.guideDigest = "b".repeat(64)),
    (value) => (value.pointerPreviews[0].actualFrame.contentContinuity.markerCount = 0),
    (value) => (value.pointerPreviews[0].fence.writerHealth.droppedRecords = 1),
  ]) {
    const value = structuredClone(evidence());
    mutate(value);
    assert.equal(
      assessProductKeyboardPointerResize({ evidence: value, expected }).qualified,
      false,
    );
  }
});

test("fails closed on malformed keyboard/release lineage and incomplete correlation", () => {
  for (const mutate of [
    (value) => (value.keyboard.receipt.operationId = UUID),
    (value) => (value.pointerRelease.layout.cells = 65),
    (value) => (value.pointerRelease.frame.presentationChanged = false),
    (value) => (value.keyboard.frame.contentContinuity.exact = false),
    (value) => (value.workspaceClient.lastReceiptOperationId = UUID),
    (value) => (value.correlation.web = false),
  ]) {
    const value = structuredClone(evidence());
    mutate(value);
    assert.equal(
      assessProductKeyboardPointerResize({ evidence: value, expected }).qualified,
      false,
    );
  }
});

test("requires every truthful journey boundary and causal/correlation proofs", () => {
  const phases = [
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
  const passed = assessKeyboardPointerResizeJourneyBoundaries({
    timeline: phases.map((phase) => ({ phase })),
    assessment: { qualified: true },
    correlationComplete: true,
  });
  assert.equal(passed.status, "passed");
  const failed = assessKeyboardPointerResizeJourneyBoundaries({
    timeline: phases
      .filter((phase) => phase !== "resize-pointer-release-proved")
      .map((phase) => ({ phase })),
    assessment: { qualified: true },
    correlationComplete: true,
  });
  assert.equal(failed.firstBrokenBoundary, "resize-pointer-release-proved");
});
