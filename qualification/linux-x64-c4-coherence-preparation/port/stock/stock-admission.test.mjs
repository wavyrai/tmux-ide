import { test } from "node:test";
import assert from "node:assert/strict";
import {
  admitStockCapabilities,
  assertStockObservation,
  stockObservationDiagnostics,
} from "./stock-admission.mjs";
const rows = [
  "if-shell|[-bF] command",
  "display-message|[-p] message",
  "capture-pane|[-aCeJNpPq]",
  "send-keys|[-l] key",
  "refresh-client|[-A]",
  "attach-session|[-t]",
  "kill-server|",
];
const run =
  (capabilities = rows, version = "3.7c") =>
  (command) =>
    command === "display-message" ? version : capabilities.join("\n") + "\n";
test("admits explicit standard commands and fence with no advertised native extensions", () =>
  assert.equal(admitStockCapabilities(run()).nativeGridAdvertised, false));
for (const [name, modify] of [
  ["native journal", (r) => [...r, "tmux-ide-operation|operation"]],
  ["native grid", (r) => r.map((x) => x.replace("aCeJNpPq", "aCeJNRpPq"))],
  ["missing fence flag", (r) => r.map((x) => x.replace("bF", "b"))],
  ["missing capture flag", (r) => r.map((x) => x.replace("aCeJNpPq", "aCeJpPq"))],
  ["missing required command", (r) => r.filter((x) => !x.startsWith("refresh-client|"))],
  ["duplicate command", (r) => [...r, r[0]]],
])
  test(`rejects ${name}`, () => assert.throws(() => admitStockCapabilities(run(modify(rows)))));
test("rejects version drift", () => assert.throws(() => admitStockCapabilities(run(rows, "3.8"))));
const partial = {
  environmentId: "environment",
  serverScope: { serverId: "server", generation: "generation" },
  lastGap: null,
  droppedCount: "0",
  method: "stock-hooks",
  cursor: null,
  effects: [],
  capabilityVersion: 1,
  coverage: "partial",
  commands: ["send-keys", "capture-pane"],
};
test("admits ready partial stock hooks and rejects initial unexplained unavailable", () => {
  assertStockObservation(partial);
  assert.throws(() =>
    assertStockObservation({
      ...partial,
      method: "unavailable",
      capabilityVersion: null,
      coverage: "unavailable",
      commands: [],
    }),
  );
});
test("retains honest unresolved-target drops without claiming journal completeness", () => {
  const final = {
    ...partial,
    lastGap: { reason: "unresolved-target", at: "2026-09-29T00:00:00.000Z", range: null },
    droppedCount: "3002",
  };
  assert.deepEqual(stockObservationDiagnostics(partial, final), {
    coverage: "partial",
    journalCompletenessClaim: false,
    initialGap: null,
    finalGap: final.lastGap,
    initialDroppedCount: "0",
    finalDroppedCount: "3002",
  });
});
for (const change of [
  { environmentId: "replacement" },
  { serverScope: { serverId: "other", generation: "generation" } },
  { lastGap: { reason: "native-range-dropped", at: "2026-09-29T00:00:00.000Z", range: null } },
  { droppedCount: "-1" },
])
  test(`rejects invalid stock continuity ${JSON.stringify(change)}`, () =>
    assert.throws(() => stockObservationDiagnostics(partial, { ...partial, ...change })));
test("rejects counter regression under the same authority", () =>
  assert.throws(() => stockObservationDiagnostics({ ...partial, droppedCount: "2" }, partial)));

for (const change of [
  { method: "native-journal" },
  { coverage: "declared-capabilities" },
  { effects: ["snapshot-produced"] },
  { cursor: { epoch: "unexpected" } },
])
  test(`rejects false stock observation ${JSON.stringify(change)}`, () =>
    assert.throws(() => assertStockObservation({ ...partial, ...change })));
