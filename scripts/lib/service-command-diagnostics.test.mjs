import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { serviceCommandFailure } from "./service-command-diagnostics.mjs";

test("actual qualification service failure retains diagnostics before its unchanged assertion", () => {
  const source = readFileSync(new URL("../qualify-installer-service.mjs", import.meta.url), "utf8");
  const serviceSource = source.slice(
    source.indexOf("function service("),
    source.indexOf("function install("),
  );
  const receipt = { steps: [] };
  const service = vm.runInNewContext(serviceSource + "\nservice", {
    process: { execPath: "/node" },
    cli: "/private/controller/cli.js",
    receipt,
    raw: () => ({
      status: 1,
      signal: null,
      stdout: '{"error":"restart refused"}',
      stderr: "manager unavailable",
    }),
    serviceCommandFailure,
    assert,
    observedDaemons: new Set(),
  });
  assert.throws(() => service("restart"), /Service restart failed \(1\)/);
  const diagnostic = receipt.steps[0].diagnostic;
  assert.equal(diagnostic.stderr.text, "manager unavailable");
  assert.equal(diagnostic.stdout.text, '{"error":"restart refused"}');
  assert.deepEqual(Array.from(diagnostic.command), [
    "/node",
    "/private/controller/cli.js",
    "daemon",
    "service",
    "restart",
    "--json",
  ]);
});

test("output tails are bounded and credential-shaped values are removed", () => {
  const diagnostic = serviceCommandFailure(["/node", "--json"], {
    status: null,
    signal: "SIGTERM",
    error: { code: "ETIMEDOUT", env: { SECRET: "not serialized" } },
    stdout:
      "x".repeat(20000) +
      " token=private-token password=private-pass Bearer private-bearer https://user:private-pass@example.com",
    stderr: null,
  });
  assert.equal(diagnostic.errorCode, "ETIMEDOUT");
  assert.equal(diagnostic.stdout.truncated, true);
  assert.ok(Buffer.byteLength(diagnostic.stdout.text) <= 16384);
  assert.ok(!JSON.stringify(diagnostic).includes("private-token"));
  assert.ok(!JSON.stringify(diagnostic).includes("private-pass"));
  assert.ok(!JSON.stringify(diagnostic).includes("private-bearer"));
  assert.ok(!JSON.stringify(diagnostic).includes("not serialized"));
  assert.equal(diagnostic.stderr.text, "");
});
