import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  nativeX64Suites,
  verifyNativeResults,
  verifyX64Header,
  verifyNativeBundle,
  tmuxProcesses,
} from "./native-x64-qualification.mjs";
const report = () => ({
  success: true,
  numTotalTests: nativeX64Suites.length,
  numPassedTests: nativeX64Suites.length,
  numFailedTests: 0,
  numPendingTests: 0,
  testResults: nativeX64Suites.map((name) => ({
    name: "/checkout/packages/daemon/" + name,
    status: "passed",
    assertionResults: [{ status: "passed" }],
  })),
});
test("requires actual executed assertions in each selected file", () => {
  assert.equal(verifyNativeResults(report()), nativeX64Suites.length);
  for (const change of [
    (r) => r.testResults.pop(),
    (r) => (r.testResults[0].assertionResults = []),
    (r) => (r.testResults[0].assertionResults[0].status = "pending"),
    (r) => (r.numPassedTests = 0),
    (r) => (r.testResults[1].name = r.testResults[0].name),
    (r) => (r.success = false),
  ]) {
    const r = report();
    change(r);
    assert.throws(() => verifyNativeResults(r));
  }
});
test("history qualification cannot omit either maintained suite or skip its assertions", () => {
  for (const name of [
    "src/tui/mirror/runtime/terminal-native-content-live.test.ts",
    "src/terminal/session-runtime/tmux-clear-history-live.test.ts",
  ]) {
    assert(nativeX64Suites.includes(name));
    const missing = report();
    missing.testResults = missing.testResults.filter((suite) => !suite.name.endsWith(name));
    assert.throws(() => verifyNativeResults(missing));
    const skipped = report();
    skipped.testResults.find((suite) => suite.name.endsWith(name)).assertionResults[0].status =
      "pending";
    assert.throws(() => verifyNativeResults(skipped));
  }
});
function elf() {
  const b = Buffer.alloc(32);
  b.write("7f454c46", 0, "hex");
  b[4] = 2;
  b[5] = 1;
  b.writeUInt16LE(62, 18);
  return b;
}
test("binary architecture cannot be inferred from the destination label", () => {
  const b = elf();
  verifyX64Header(b, "linux");
  b.writeUInt16LE(183, 18);
  assert.throws(() => verifyX64Header(b, "linux"));
  const m = Buffer.alloc(32);
  m.writeUInt32LE(0xfeedfacf, 0);
  m.writeUInt32LE(0x01000007, 4);
  verifyX64Header(m, "darwin");
  m.writeUInt32LE(0x0100000c, 4);
  assert.throws(() => verifyX64Header(m, "darwin"));
});
test("closure hashes and exact journal patch identity are required", () => {
  const bytes = elf();
  const hash = createHash("sha256").update(bytes).digest("hex");
  const provenance = {
    commit: "pinned",
    patches: [{ patch: "interaction-journal-v1.patch", patchSha256: "exact" }],
    experimentalExtensions: ["tmux-ide-interaction-journal-v2"],
  };
  const manifest = {
    ...provenance,
    platform: "linux",
    arch: "x64",
    files: { tmux: hash, "lib/libevent.so.2": hash },
  };
  const bundle = { manifest, read: () => bytes };
  verifyNativeBundle(bundle, provenance, "linux");
  assert.throws(() =>
    verifyNativeBundle({ ...bundle, read: () => Buffer.from("wrong") }, provenance, "linux"),
  );
  assert.throws(() =>
    verifyNativeBundle({ ...bundle, manifest: { ...manifest, patches: [] } }, provenance, "linux"),
  );
  assert.throws(() =>
    verifyNativeBundle(
      { ...bundle, manifest: { ...manifest, files: { tmux: hash, "../escape": hash } } },
      provenance,
      "linux",
    ),
  );
});
test("cleanup inventory detects executable and renamed server forms without matching observers", () => {
  assert.deepEqual(
    tmuxProcesses(" 12 /tmp/bundle/tmux\n 13 tmux: server\n 14 /bin/node\n 15 /tmp/tmux-test/node"),
    [12, 13],
  );
});
