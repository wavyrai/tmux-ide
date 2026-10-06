import assert from "node:assert/strict";

/** Qualification requires actual passed assertions, not merely runner exit zero. */
export function verifyBoundaryResults(report, expectedSuites) {
  assert(Array.isArray(expectedSuites) && expectedSuites.length > 0, "No expected suites");
  assert.equal(new Set(expectedSuites).size, expectedSuites.length, "Duplicate expected suite");
  assert.equal(report.success, true);
  assert.equal(report.testResults.length, expectedSuites.length);
  let count = 0;
  for (const suite of expectedSuites) {
    const matches = report.testResults.filter((result) => result.name.endsWith("/" + suite));
    assert.equal(matches.length, 1, `Missing or duplicate suite: ${suite}`);
    assert.equal(matches[0].status, "passed", `Failed suite: ${suite}`);
    assert(matches[0].assertionResults.length > 0, `Empty suite: ${suite}`);
    for (const assertion of matches[0].assertionResults) {
      assert.equal(assertion.status, "passed", `Non-executed or failed assertion: ${suite}`);
      count++;
    }
  }
  assert.equal(report.numTotalTests, count);
  assert.equal(report.numPassedTests, count);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests ?? 0, 0);
  return count;
}
