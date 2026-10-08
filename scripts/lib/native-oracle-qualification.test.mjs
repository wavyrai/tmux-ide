import { test } from "node:test";
import assert from "node:assert/strict";
import { oracleSuite, verifyOracleEvidence } from "./native-oracle-qualification.mjs";
function fixture() {
  const identity = {
    commit: "reviewed-commit",
    binarySha256: "built-binary",
    patches: [{ patch: "current" }],
    sources: { "session-channel.ts": "source-hash" },
  };
  const report = {
    success: true,
    numTotalTests: 26,
    numPassedTests: 26,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      {
        name: "/checkout/" + oracleSuite,
        status: "passed",
        assertionResults: Array.from({ length: 26 }, () => ({ status: "passed" })),
      },
    ],
  };
  const receipts = ["cells", "tab-wrap"].map((scenario) => ({
    fixture: { scenario },
    identity: {
      gitHead: identity.commit,
      sha256: identity.binarySha256,
      sourceReceipt: { files: { tmux: identity.binarySha256 }, patches: identity.patches },
      sources: [{ name: "session-channel.ts", sha256: "source-hash" }],
    },
    native: true,
    faults: [],
    trace: [{ phase: "initial" }, { phase: "edited" }],
    cleanup: {
      serverAbsent: true,
      status: 1,
      ownerDisposed: true,
      mirrorDisposed: true,
      errors: [],
    },
  }));
  return { identity, report, receipts };
}
test("requires two native scenario receipts and all 26 executed assertions", () => {
  const x = fixture();
  assert.equal(verifyOracleEvidence(x.report, x.receipts, x.identity), 26);
});
for (const [name, mutate] of [
  ["skipped assertion", (x) => (x.report.testResults[0].assertionResults[0].status = "pending")],
  ["empty suite", (x) => (x.report.testResults[0].assertionResults = [])],
  ["missing live receipt", (x) => x.receipts.pop()],
  ["duplicate scenario", (x) => (x.receipts[1].fixture.scenario = "cells")],
  ["wrong source commit", (x) => (x.receipts[0].identity.gitHead = "old")],
  ["wrong native file", (x) => (x.receipts[0].identity.sha256 = "other")],
  ["changed patch source", (x) => (x.receipts[0].identity.sourceReceipt.patches = [])],
  ["wrong source bytes", (x) => (x.receipts[0].identity.sources[0].sha256 = "old")],
  ["stock fallback", (x) => (x.receipts[0].native = false)],
  ["missing edited checkpoint", (x) => x.receipts[0].trace.pop()],
  ["server retained", (x) => (x.receipts[0].cleanup.serverAbsent = false)],
  ["cleanup failed", (x) => x.receipts[0].cleanup.errors.push("timeout")],
  ["recorded failure", (x) => (x.receipts[0].failure = "failed")],
])
  test(`rejects ${name}`, () => {
    const x = fixture();
    mutate(x);
    assert.throws(() => verifyOracleEvidence(x.report, x.receipts, x.identity));
  });
