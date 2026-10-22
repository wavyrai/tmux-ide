import assert from "node:assert/strict";

// Pure validation of capture-adapter evidence. This module does not inspect pixels,
// post input, establish input authority, or establish display presentation times.
// Adapters must use one monotonic clock domain for input and capture timestamps,
// derive classifications from captured pixels, and derive expected history rows
// independently from the known fixture. This validator cannot prove those inputs.
const ns = (value) => {
  assert.match(value, /^(0|[1-9][0-9]{0,24})$/, "canonical monotonic nanoseconds required");
  return BigInt(value);
};
const id = (value) =>
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 512);
function rectangle(value) {
  assert.ok(value && [value.x, value.y, value.width, value.height].every(Number.isSafeInteger));
  assert.ok(value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0);
}
function identity(value) {
  assert.ok(value && Number.isSafeInteger(value.pid) && value.pid > 1);
  for (const key of ["window", "generation", "incarnation", "geometry", "route", "artifact"])
    id(value[key]);
}
function timeline(evidence) {
  identity(evidence.identity);
  const { trigger, samples } = evidence;
  const start = ns(trigger.startNs),
    end = ns(trigger.endNs);
  assert.ok(end >= start);
  assert.equal(trigger.count, 1, "exactly one physical action required");
  assert.equal(trigger.kind, "physical", "source/transport triggers are not navigation input");
  assert.deepEqual(trigger.identity, evidence.identity);
  assert.ok(Array.isArray(samples) && samples.length >= 2 && samples.length <= 256);
  let previousEnd = -1n;
  for (const [index, sample] of samples.entries()) {
    assert.deepEqual(sample.identity, evidence.identity, "capture identity changed");
    assert.equal(sample.sequence, index, "capture sequence gap or duplicate");
    assert.equal(sample.foreground, true, "owned window must remain foreground");
    assert.equal(sample.captureDrops, 0, "capture drops prevent qualification");
    assert.equal(sample.captureErrors, 0, "capture errors prevent qualification");
    const a = ns(sample.startNs),
      b = ns(sample.endNs);
    assert.ok(
      a >= previousEnd && b >= a,
      "capture timestamps must be monotonic and nonoverlapping",
    );
    previousEnd = b;
  }
  assert.ok(ns(samples[0].endNs) <= start, "negative baseline must precede input");
  return { start, end, samples };
}
function interval(trigger, negative, positive) {
  const lower = ns(negative.startNs) > trigger.end ? ns(negative.startNs) - trigger.end : 0n;
  const upper = ns(positive.endNs) - trigger.start;
  return {
    lowerMs: Number(lower) / 1e6,
    upperMs: Number(upper) / 1e6,
    uncertaintyMs: Number(upper - lower) / 1e6,
    positiveSequence: positive.sequence,
    endpoint: "physical-action-to-window-capture-observation",
    displayPresentationMeasured: false,
  };
}
function witness(value, expected) {
  assert.ok(value);
  assert.equal(value.method, "roi-decoration", "whole-window OCR/content is not selection proof");
  assert.equal(value.pane, expected.pane);
  assert.equal(value.classifier, expected.classifier);
  assert.equal(value.label, expected.label);
  assert.deepEqual(value.roi, expected.roi);
  assert.equal(typeof value.selected, "boolean");
}

/** Same-window visual focus response only; a later typed witness cannot timestamp authority. */
export function classifyPaneSelection(evidence) {
  const clock = timeline(evidence);
  assert.equal(evidence.trigger.action, "click");
  const { source, target } = evidence;
  for (const region of [source, target]) {
    for (const key of ["pane", "classifier", "label"]) id(region[key]);
    rectangle(region.roi);
  }
  assert.notEqual(source.pane, target.pane);
  const a = source.roi,
    b = target.roi;
  assert.ok(
    a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
    "source and target witness ROIs must not overlap",
  );
  let negative = clock.samples[0],
    positive;
  for (const sample of clock.samples) {
    witness(sample.source, source);
    witness(sample.target, target);
    if (ns(sample.endNs) <= clock.start) {
      assert.equal(sample.source.selected, true);
      assert.equal(sample.target.selected, false, "target cannot be selected before input");
    }
    if (ns(sample.startNs) < clock.end) continue;
    if (!sample.source.selected && sample.target.selected) {
      positive ??= sample;
    } else {
      assert.ok(!positive, "selection reverted after positive witness");
      negative = sample;
    }
  }
  assert.ok(positive, "source deselection AND target selection required");
  const confirmation = clock.samples.at(-1);
  assert.ok(confirmation.sequence > positive.sequence, "separate stable confirmation required");
  const typed = evidence.typedWitness;
  assert.ok(typed, "separate exact-target typed correctness witness required");
  assert.deepEqual(typed.identity, evidence.identity);
  assert.equal(typed.kind, "physical");
  assert.equal(typed.pane, target.pane);
  id(typed.nonce);
  assert.equal(typed.received, typed.nonce);
  assert.equal(typed.targetReceipts, 1);
  assert.equal(typed.sourceReceipts, 0);
  assert.ok(
    ns(typed.startNs) >= ns(confirmation.endNs),
    "typed witness must be outside timing interval",
  );
  return {
    ...interval(clock, negative, positive),
    scenario: "same-window-selection",
    inputAuthorityLatencyMeasured: false,
  };
}

/** One-page response; deliberately provides no continuous-scroll cadence estimate. */
export function classifyPageResponse(evidence) {
  const clock = timeline(evidence);
  assert.equal(evidence.trigger.action, "shift-pageup");
  id(evidence.pane);
  rectangle(evidence.roi);
  assert.ok(Number.isSafeInteger(evidence.viewportRows) && evidence.viewportRows > 1);
  assert.equal(evidence.lines, evidence.viewportRows - 1);
  assert.equal(evidence.terminalInputReceipts, 0);
  assert.ok(Array.isArray(evidence.expectedRows) && evidence.expectedRows.length >= 3);
  assert.equal(new Set(evidence.expectedRows).size, evidence.expectedRows.length);
  evidence.expectedRows.forEach(id);
  assert.ok(Array.isArray(evidence.rowPositions));
  assert.equal(evidence.rowPositions.length, evidence.expectedRows.length);
  let previousPosition = -1;
  for (const position of evidence.rowPositions) {
    assert.ok(
      Number.isSafeInteger(position) &&
        position > previousPosition &&
        position < evidence.viewportRows,
    );
    previousPosition = position;
  }
  assert.ok(Array.isArray(evidence.beforeRows));
  assert.notDeepEqual(evidence.beforeRows, evidence.expectedRows);
  let negative = clock.samples[0],
    positive;
  for (const sample of clock.samples) {
    assert.equal(sample.method, "positioned-roi-row-markers");
    assert.deepEqual(sample.rowPositions, evidence.rowPositions);
    assert.equal(sample.pane, evidence.pane);
    assert.deepEqual(sample.roi, evidence.roi);
    if (ns(sample.endNs) <= clock.start) assert.deepEqual(sample.rows, evidence.beforeRows);
    if (ns(sample.startNs) < clock.end) continue;
    const matches = JSON.stringify(sample.rows) === JSON.stringify(evidence.expectedRows);
    if (matches) positive ??= sample;
    else {
      assert.ok(!positive, "page position reverted");
      negative = sample;
    }
  }
  assert.ok(positive, "exact positioned history markers required");
  assert.ok(clock.samples.at(-1).sequence > positive.sequence, "stable page confirmation required");
  return {
    ...interval(clock, negative, positive),
    scenario: "single-page-response",
    continuousCadenceMeasured: false,
  };
}
