import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPaneSelection, classifyPageResponse } from "./gui-navigation-observation.mjs";

function selection() {
  const identity = {
    pid: 42,
    window: "owned-window",
    generation: "g",
    incarnation: "i",
    geometry: "80x24@2",
    route: "local",
    artifact: "sha256:fixture",
  };
  const source = {
    pane: "a",
    label: "A",
    classifier: "tui-header-v1",
    roi: { x: 0, y: 0, width: 20, height: 10 },
  };
  const target = { ...source, pane: "b", label: "B", roi: { ...source.roi, x: 30 } };
  const samples = [
    ["0", "10"],
    ["30", "40"],
    ["50", "60"],
  ].map(([startNs, endNs], sequence) => ({
    identity,
    sequence,
    startNs,
    endNs,
    foreground: true,
    captureDrops: 0,
    captureErrors: 0,
    source: { ...source, method: "roi-decoration", selected: sequence === 0 },
    target: { ...target, method: "roi-decoration", selected: sequence !== 0 },
  }));
  return {
    identity,
    source,
    target,
    samples,
    trigger: { identity, startNs: "20", endNs: "25", count: 1, kind: "physical", action: "click" },
    typedWitness: {
      identity,
      startNs: "70",
      kind: "physical",
      pane: "b",
      nonce: "unique",
      received: "unique",
      targetReceipts: 1,
      sourceReceipts: 0,
    },
  };
}
test("selection qualifies only the visual endpoint with an out-of-band routing witness", () => {
  const result = classifyPaneSelection(selection());
  assert.equal(result.scenario, "same-window-selection");
  assert.equal(result.lowerMs, 0);
  assert.equal(result.upperMs, 0.00002);
  assert.equal(result.inputAuthorityLatencyMeasured, false);
  assert.equal(result.displayPresentationMeasured, false);
});
for (const [name, mutate] of [
  ["target already selected", (e) => (e.samples[0].target.selected = true)],
  ["source never deselected", (e) => e.samples.forEach((s) => (s.source.selected = true))],
  ["whole-window OCR", (e) => (e.samples[1].target.method = "whole-window-ocr")],
  [
    "wrong ROI",
    (e) => (e.samples[1].target = { ...e.samples[1].target, roi: { ...e.target.roi, x: 400 } }),
  ],
  ["wrong pane", (e) => (e.samples[1].target.pane = "other")],
  ["wrong classifier", (e) => (e.samples[1].target.classifier = "hover")],
  ["identity changed", (e) => (e.samples[1].identity = { ...e.identity, incarnation: "new" })],
  ["capture drop", (e) => (e.samples[1].captureDrops = 1)],
  ["missing diagnostics", (e) => delete e.samples[1].captureErrors],
  ["duplicate sample", (e) => (e.samples[1].sequence = 0)],
  ["backwards clock", (e) => (e.samples[1].endNs = "2")],
  ["lost foreground", (e) => (e.samples[1].foreground = false)],
  ["transport trigger", (e) => (e.trigger.kind = "source")],
  ["duplicate trigger", (e) => (e.trigger.count = 2)],
  ["no stable confirmation", (e) => e.samples.pop()],
  ["reverted focus", (e) => (e.samples[2].source.selected = true)],
  ["wrong typed target", (e) => (e.typedWitness.pane = "a")],
  ["source also received input", (e) => (e.typedWitness.sourceReceipts = 1)],
  ["typed during timing", (e) => (e.typedWitness.startNs = "35")],
  ["no typed witness", (e) => delete e.typedWitness],
])
  test(`selection rejects ${name}`, () => {
    const e = structuredClone(selection());
    mutate(e);
    assert.throws(() => classifyPaneSelection(e));
  });
function page() {
  const e = selection();
  e.trigger.action = "shift-pageup";
  return {
    ...e,
    pane: "a",
    roi: e.source.roi,
    viewportRows: 24,
    rowPositions: [0, 10, 22],
    lines: 23,
    terminalInputReceipts: 0,
    beforeRows: ["L100", "L110", "L122"],
    expectedRows: ["L77", "L87", "L99"],
    samples: e.samples.map((s, i) => ({
      ...s,
      method: "positioned-roi-row-markers",
      rowPositions: [0, 10, 22],
      pane: "a",
      roi: e.source.roi,
      rows: i ? ["L77", "L87", "L99"] : ["L100", "L110", "L122"],
    })),
  };
}
test("page response never claims continuous scroll cadence", () => {
  const result = classifyPageResponse(page());
  assert.equal(result.continuousCadenceMeasured, false);
  assert.equal(result.scenario, "single-page-response");
});
for (const [name, mutate] of [
  ["wrong direction", (e) => (e.trigger.action = "shift-pagedown")],
  ["unequal page distance", (e) => (e.lines = 24)],
  ["input leakage", (e) => (e.terminalInputReceipts = 1)],
  ["unordered markers", (e) => e.samples[1].rows.reverse()],
  ["preexisting page", (e) => (e.beforeRows = e.expectedRows)],
  ["whole-window markers", (e) => (e.samples[1].method = "whole-window-ocr")],
  ["reverted page", (e) => (e.samples[2].rows = e.beforeRows)],
])
  test(`page rejects ${name}`, () => {
    const e = structuredClone(page());
    mutate(e);
    assert.throws(() => classifyPageResponse(e));
  });
