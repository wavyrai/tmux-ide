import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("actual live startup failure emits a fixed diagnostic without the private path", () => {
  const secretPath = "/tmp/GPUI_PRIVATE_TOKEN_DO_NOT_PRINT/missing.json";
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./live.ts", import.meta.url)), secretPath],
    {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 65536,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !["NODE_OPTIONS", "NODE_PATH"].includes(key)),
      ),
    },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.ok(!child.stderr.includes(secretPath));
  assert.deepEqual(
    child.stderr.split("\n").filter((line) => line.startsWith("TMUX_GPUI_DIAGNOSTIC ")),
    ['TMUX_GPUI_DIAGNOSTIC {"code":"startup"}'],
  );
});

import {
  createLiveDiagnostics,
  diagnosticStatus,
  parseDiagnosticLine,
} from "./live-diagnostics.ts";

test("publication overflow retains its cause through replica failure and retirement", () => {
  const lines: string[] = [];
  const diagnostics = createLiveDiagnostics((line) => lines.push(line));
  assert.doesNotThrow(() => diagnostics.publication("x".repeat(8 * 1024 * 1024)));
  try {
    diagnostics.publication("🌍".repeat(2 * 1024 * 1024 + 1));
    assert.fail("oversized publication admitted");
  } catch {
    diagnostics.report("replica-validation");
    diagnostics.report("transport-closed", 1006);
    diagnostics.publication(JSON.stringify({ snapshot: null }));
  }
  assert.deepEqual(lines.map(parseDiagnosticLine), [{ code: "publication-limit" }]);
});

test("close code is bounded numeric metadata; error payload cannot enter the record", () => {
  for (const code of [
    1000,
    1006,
    1013,
    4999,
    "TOKEN",
    "1013",
    -1,
    5000,
    NaN,
    { secret: "TOKEN" },
  ]) {
    const lines: string[] = [];
    const diagnostic = createLiveDiagnostics((line) => lines.push(line));
    diagnostic.report("transport-closed", code);
    const valid =
      typeof code === "number" && Number.isInteger(code) && code >= 1000 && code <= 4999;
    assert.deepEqual(parseDiagnosticLine(lines[0]), {
      code: "transport-closed",
      ...(valid ? { closeCode: code } : {}),
    });
    assert.ok(!lines[0].includes("TOKEN"));
    assert.ok(Buffer.byteLength(lines[0]) < 256);
  }
});

test("untrusted child diagnostic lines reject unknown fields and arbitrary text", () => {
  for (const value of [
    { code: "TOKEN" },
    { code: "__proto__" },
    { code: "startup", message: "https://user:TOKEN@host/terminal" },
    { code: "startup", closeCode: 1013 },
    { code: "transport-closed", closeCode: "1013" },
    { code: "transport-closed", closeCode: null },
    { code: "transport-closed", reason: "terminal payload" },
    [],
    null,
  ])
    assert.equal(parseDiagnosticLine("TMUX_GPUI_DIAGNOSTIC " + JSON.stringify(value)), null);
  assert.equal(parseDiagnosticLine("arbitrary Error TOKEN"), null);
  assert.equal(parseDiagnosticLine("TMUX_GPUI_DIAGNOSTIC {"), null);
  assert.equal(
    parseDiagnosticLine("TMUX_GPUI_DIAGNOSTIC " + " ".repeat(256) + '{"code":"startup"}'),
    null,
  );
  assert.equal(
    diagnosticStatus(
      parseDiagnosticLine('TMUX_GPUI_DIAGNOSTIC {"code":"transport-closed","closeCode":1013}')!,
    ),
    "Terminal connection closed (code 1013)",
  );
});

test("each failure category emits once; observation failures never replace lifecycle failure", () => {
  for (const code of [
    "replica-validation",
    "transport-error",
    "startup",
    "runtime-failure",
  ] as const) {
    const lines: string[] = [];
    const diagnostic = createLiveDiagnostics((line) => lines.push(line));
    diagnostic.report(code);
    diagnostic.report("transport-closed", 1006);
    assert.deepEqual(lines.map(parseDiagnosticLine), [{ code }]);
  }
  let writes = 0;
  const diagnostic = createLiveDiagnostics(() => {
    writes++;
    throw new Error("TOKEN");
  });
  assert.doesNotThrow(() => diagnostic.report("transport-error"));
  diagnostic.report("startup");
  assert.equal(writes, 1);
});

test("source faults preserve a safe specific cause through replica retirement", () => {
  for (const [reason, code] of [
    ["state-too-large", "source-state-limit"],
    ["source-closed", "source-closed"],
    ["protocol-violation", "source-protocol"],
    ["PRIVATE_TOKEN", "source-protocol"],
  ]) {
    const lines: string[] = [];
    const diagnostics = createLiveDiagnostics((line) => lines.push(line));
    diagnostics.sourceFault(reason);
    diagnostics.report("replica-validation");
    assert.deepEqual(lines.map(parseDiagnosticLine), [{ code }]);
    assert.ok(!lines[0].includes("PRIVATE_TOKEN"));
  }
});

test("only authenticated topology retirement is classified for recovery", async () => {
  const { PaneStreamOperationError } =
    await import("../../../packages/daemon-client/src/pane-stream-client.ts");
  for (const [error, expected] of [
    [new PaneStreamOperationError("topology-changed", "private payload"), "topology-changed"],
    [new PaneStreamOperationError("invalid-pane", "private payload"), "runtime-failure"],
    [new Error("topology-changed"), "runtime-failure"],
    [{ code: "topology-changed" }, "runtime-failure"],
  ] as const) {
    const lines: string[] = [];
    const diagnostic = createLiveDiagnostics((line) => lines.push(line));
    diagnostic.runtimeFault(error);
    assert.deepEqual(lines.map(parseDiagnosticLine), [{ code: expected }]);
  }
});
