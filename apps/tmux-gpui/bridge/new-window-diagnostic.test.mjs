import { test } from "node:test";
import assert from "node:assert/strict";
import { newWindowDiagnostic } from "./new-window-diagnostic.mjs";
test("failure receipt accepts fixed classifications and strips private fields", () => {
  const line = {
    stage: "new-window-refresh-failed",
    refreshStage: "inventory",
    catalog: { stage: "inventory", reason: "request failed", status: 503, secret: "PRIVATE" },
    secret: "PRIVATE",
  };
  assert.deepEqual(newWindowDiagnostic(JSON.stringify(line)), {
    refreshStage: "inventory",
    catalog: { stage: "inventory", reason: "request failed", status: 503 },
  });
  line.catalog.reason = "PRIVATE";
  assert.deepEqual(newWindowDiagnostic(JSON.stringify(line)), { refreshStage: "inventory" });
  assert.equal(
    newWindowDiagnostic("PRIVATE\n" + JSON.stringify({ ...line, refreshStage: "PRIVATE" })),
    null,
  );
});
test("old diagnostics remain readable and malformed or oversized lines are ignored", () => {
  const line = JSON.stringify({ stage: "new-window-refresh-failed", refreshStage: "inventory" });
  assert.deepEqual(newWindowDiagnostic(line + "\n{invalid\n" + line + " ".repeat(1024)), {
    refreshStage: "inventory",
  });
});
