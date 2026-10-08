import assert from "node:assert/strict";
import test from "node:test";
import { verifyBoundaryResults } from "./boundary-results.mjs";
const suites = ["src/one.test.ts", "src/two.test.ts"];
const report = () => ({
  success: true,
  numTotalTests: 2,
  numPassedTests: 2,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: suites.map((name) => ({
    name: `/checkout/${name}`,
    status: "passed",
    assertionResults: [{ status: "passed" }],
  })),
});
test("accepts executed assertions for every exact selected suite", () => {
  assert.equal(verifyBoundaryResults(report(), suites), 2);
});
for (const status of ["pending", "skipped", "todo", "failed"]) {
  test(`rejects a ${status} assertion even with successful summary`, () => {
    const value = report();
    value.testResults[0].assertionResults[0].status = status;
    assert.throws(() => verifyBoundaryResults(value, suites));
  });
}
test("rejects empty, missing, duplicate and substituted suites", () => {
  for (const mutate of [
    (r) => {
      r.testResults[0].assertionResults = [];
    },
    (r) => {
      r.testResults.pop();
    },
    (r) => {
      r.testResults[1].name = r.testResults[0].name;
    },
    (r) => {
      r.testResults[0].name = "/checkout/src/not-one.test.ts";
    },
  ]) {
    const value = report();
    mutate(value);
    assert.throws(() => verifyBoundaryResults(value, suites));
  }
  assert.throws(() => verifyBoundaryResults(report(), []));
  assert.throws(() => verifyBoundaryResults(report(), [suites[0], suites[0]]));
});
test("rejects failed suites and inconsistent report totals", () => {
  for (const mutate of [
    (r) => {
      r.success = false;
    },
    (r) => {
      r.testResults[0].status = "failed";
    },
    (r) => {
      r.numTotalTests = 0;
    },
    (r) => {
      r.numPassedTests = 1;
    },
    (r) => {
      r.numFailedTests = 1;
    },
    (r) => {
      r.numPendingTests = 1;
    },
    (r) => {
      r.numTodoTests = 1;
    },
  ]) {
    const value = report();
    mutate(value);
    assert.throws(() => verifyBoundaryResults(value, suites));
  }
});
