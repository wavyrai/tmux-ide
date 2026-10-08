import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  completedReferenceRecords,
  matchReferenceControllerInput,
  reconcileReferenceControllerInputs,
} from "./performance-reference-input-mapping.mjs";
const key = "a".repeat(64);
function fixture(id = "one", payload = "x") {
  const common = { processId: "p", clockId: "c", clockKind: "performance-now" };
  const authority = { semanticPaneId: "pane", generation: "g", incarnation: "i" };
  return [
    { type: "performance.trace.header", ...common },
    {
      type: "performance.input-origin",
      ...common,
      ...authority,
      traceId: id,
      atMicros: 1,
      origin: "keyboard",
      parserConsumption: "keyboard-event",
      payloadByteCount: Buffer.byteLength(payload),
      payloadFingerprint: createHmac("sha256", key)
        .update(id)
        .update("\0")
        .update(Buffer.from(payload))
        .digest("hex"),
    },
    {
      type: "performance.stage",
      stage: "input",
      ...common,
      traceId: id,
      authority,
      startedAtMicros: 2,
      endedAtMicros: 3,
    },
    {
      type: "performance.stage",
      stage: "paint",
      ...common,
      ...authority,
      traceId: id,
      startedAtMicros: 4,
      endedAtMicros: 5,
    },
  ];
}
const options = { baseline: 1, payload: "x", key };
test("exact origin and corresponding pair, not unrelated paint, advance controller", () => {
  const events = fixture();
  assert.equal(matchReferenceControllerInput(events, options).traceId, "one");
  assert.equal(matchReferenceControllerInput([events[0], events[3]], options), null);
  assert.equal(matchReferenceControllerInput(events.slice(0, 3), options), null);
  assert.equal(matchReferenceControllerInput(events, { ...options, baseline: 4 }), null);
});
test("wrong payload, duplicate identities, reordered and foreign clock or authority fail closed", () => {
  assert.throws(() => matchReferenceControllerInput(fixture(), { ...options, payload: "y" }));
  assert.throws(() =>
    matchReferenceControllerInput(fixture(), { ...options, usedTraceIds: ["one"] }),
  );
  for (const mutate of [
    (e) => e.push(e[3]),
    (e) => e.push(e[1]),
    (e) => ([e[1], e[2]] = [e[2], e[1]]),
    (e) => (e[3].clockId = "other"),
    (e) => (e[1].processId = "foreign"),
    (e) => (e[3].incarnation = "other"),
    (e) => (e[1].atMicros = 4),
    (e) => (e[1].atMicros = NaN),
  ]) {
    const events = fixture();
    mutate(events);
    assert.throws(() => matchReferenceControllerInput(events, options));
  }
});
test("final reconciliation examines late duplicate pairs beyond next-offer origin fence", () => {
  const first = fixture(),
    second = fixture("two", "y").slice(1);
  const events = [...first, ...second];
  assert.equal(matchReferenceControllerInput(events, { ...options, originEnd: 4 }).traceId, "one");
  events.push(first[3]);
  assert.throws(() => matchReferenceControllerInput(events, { ...options, originEnd: 4 }));
});
test("live complete-record fences tolerate split JSON/UTF8 only until final admission", () => {
  const bytes = Buffer.from('{"a":1}\n{"b":"é"}\n');
  for (let i = 9; i < bytes.length; i++) {
    assert.deepEqual(completedReferenceRecords(bytes.subarray(0, i)), [{ a: 1 }]);
    assert.throws(() => completedReferenceRecords(bytes.subarray(0, i), true));
  }
  assert.deepEqual(completedReferenceRecords(bytes, true), [{ a: 1 }, { b: "é" }]);
  assert.throws(() => completedReferenceRecords(Buffer.from("{}\nno\n")));
  assert.throws(() => completedReferenceRecords(Buffer.from([0xff, 10])));
});

test("actual production sink origin HMAC and emitted pair map the offered literal", async () => {
  const { createReferencePerformanceTraceSink } =
    await import("../../packages/daemon/src/tui/mirror/reference-performance-trace.ts");
  const events = [],
    times = [1000, 1100];
  const sink = createReferencePerformanceTraceSink({
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    processId: "opentui:test",
    inputOrigin: true,
    inputFingerprintKey: key,
    createTraceId: () => "actual",
    nowMicros: () => times.shift(),
    append: (e) => events.push(e),
  });
  const authority = { semanticPaneId: "pane", generation: "g", incarnation: "i" };
  const input = sink.beginTerminalInput({
    origin: "keyboard",
    payload: Buffer.from("x"),
    ...authority,
    revision: 1,
    stateHash: "state",
  });
  input.finish();
  sink.terminalTraceSpan({
    traceId: input.traceId,
    scenario: "terminal-input-to-paint",
    stage: "paint",
    processId: "opentui:test",
    clockId: "opentui-performance-now",
    clockKind: "performance-now",
    startedAtMicros: 1200,
    endedAtMicros: 1300,
    ...authority,
    revision: 2,
    stateHash: "next",
  });
  assert.equal(matchReferenceControllerInput(events, options).traceId, "actual");
  assert.throws(() => matchReferenceControllerInput(events, { ...options, payload: "y" }));
  assert.equal(sink.close().inputAttempts.completed, 1);
});

test("complete extra input between offers cannot enter controller-labelled samples", () => {
  const events = fixture();
  const attempts = [{ status: "matched", traceId: "one" }];
  reconcileReferenceControllerInputs(events, attempts);
  const extras = fixture("unoffered", "x").slice(1);
  assert.throws(() => reconcileReferenceControllerInputs([...events, ...extras], attempts));
  assert.throws(() => reconcileReferenceControllerInputs([...extras, ...events], attempts));
});
