import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probePackedIdentity,
  verifyPackedLaneArtifact,
  requirePackedFailure,
  verifyPackedRecord,
} from "./packed-install-scenarios.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "packed-scenario-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test("second lane must match both installed package version and exact primary CLI bytes", (t) => {
  const root = fixture(t),
    primary = join(root, "primary.js"),
    installed = join(root, "installed");
  mkdirSync(join(installed, "bin"), { recursive: true });
  writeFileSync(join(installed, "package.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(primary, "exact compiled artifact\n");
  writeFileSync(join(installed, "bin", "cli.js"), "exact compiled artifact\n");
  assert.match(verifyPackedLaneArtifact(installed, primary, "1.2.3").cliSha256, /^[a-f0-9]{64}$/);
  assert.throws(() => verifyPackedLaneArtifact(installed, primary, "1.2.4"));
  writeFileSync(join(installed, "bin", "cli.js"), "different compiled artifact\n");
  assert.throws(
    () => verifyPackedLaneArtifact(installed, primary, "1.2.3"),
    /exact same compiled CLI/,
  );
});
test("expected refusal rejects timeout, termination, success and unrelated error code", () => {
  const refused = { status: 1, signal: null, stdout: "", stderr: '{"code":"DAEMON_INFO_INVALID"}' };
  assert.deepEqual(requirePackedFailure(refused, { code: "DAEMON_INFO_INVALID" }), {
    exitCode: 1,
    code: "DAEMON_INFO_INVALID",
  });
  for (const change of [
    { error: new Error("timeout") },
    { signal: "SIGTERM" },
    { status: 0 },
    { status: null },
    { stderr: '{"code":"OTHER"}' },
  ]) {
    assert.throws(() =>
      requirePackedFailure({ ...refused, ...change }, { code: "DAEMON_INFO_INVALID" }),
    );
  }
});
test("offline failure requires the actionable runtime boundary, not any nonzero exit", () => {
  const base = {
    status: 1,
    signal: null,
    stdout: "",
    stderr: "Automatic OpenTUI runtime acquisition failed: offline",
  };
  assert.equal(
    requirePackedFailure(base, { includes: "Automatic OpenTUI runtime acquisition failed" })
      .exitCode,
    1,
  );
  assert.throws(() =>
    requirePackedFailure(
      { ...base, stderr: "unknown argument" },
      { includes: "Automatic OpenTUI runtime acquisition failed" },
    ),
  );
});
test("permission repair and refusal checks independently reject modified bytes or unexpected modes", (t) => {
  const root = fixture(t),
    path = join(root, "daemon.json"),
    bytes = Buffer.from('{"pid":123,"version":"0.0.1"}');
  chmodSync(root, 0o700);
  writeFileSync(path, bytes, { mode: 0o600 });
  verifyPackedRecord(path, bytes, 0o700, 0o600);
  chmodSync(path, 0o666);
  assert.throws(() => verifyPackedRecord(path, bytes, 0o700, 0o600));
  verifyPackedRecord(path, bytes, 0o700, 0o666);
  writeFileSync(path, '{"pid":456,"version":"0.0.1"}');
  assert.throws(() => verifyPackedRecord(path, bytes, 0o700, 0o666), /exact record bytes/);
});

test("publication before listener readiness can retry, but a valid wrong identity fails immediately", async () => {
  const expected = {
    pid: 101,
    port: 4321,
    instanceId: "owned",
    startedAt: "start",
    productVersion: "1.2.3",
    protocolVersion: 2,
  };
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) throw new Error("connection refused");
    return { status: 200, json: async () => expected };
  };
  assert.equal(await probePackedIdentity(expected, 100, fetchImpl), false);
  assert.equal(await probePackedIdentity(expected, 100, fetchImpl), true);
  await assert.rejects(
    probePackedIdentity(expected, 100, async () => ({
      status: 200,
      json: async () => ({ ...expected, instanceId: "replaced" }),
    })),
    /does not match/,
  );
  assert.equal(
    await probePackedIdentity(expected, 0, async () => {
      throw new Error("must not start after deadline");
    }),
    false,
  );
});
