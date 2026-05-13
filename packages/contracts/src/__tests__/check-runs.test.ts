/**
 * `summarizeChecks` unit tests (G18-P3). The summary feeds the
 * CheckRunsRail's overview chip; mis-counting maps to wrong UI tone,
 * so every conclusion branch is exercised.
 */

import { describe, expect, it } from "vitest";
import { summarizeChecks, type CheckRun } from "../github";

function run(over: Partial<CheckRun> = {}): CheckRun {
  return {
    id: "1",
    name: "build",
    status: "completed",
    conclusion: "success",
    detailsUrl: null,
    headSha: "abc",
    startedAt: null,
    completedAt: null,
    appName: null,
    appAvatarUrl: null,
    workflowName: null,
    ...over,
  };
}

describe("summarizeChecks", () => {
  it("returns an all-zero summary for an empty list", () => {
    expect(summarizeChecks([])).toEqual({
      total: 0,
      pending: 0,
      passed: 0,
      failed: 0,
      neutral: 0,
      cancelled: 0,
      skipped: 0,
    });
  });

  it("counts every conclusion variant into the right bucket", () => {
    const runs: CheckRun[] = [
      run({ id: "s1", conclusion: "success" }),
      run({ id: "f1", conclusion: "failure" }),
      run({ id: "t1", conclusion: "timed_out" }),
      run({ id: "a1", conclusion: "action_required" }),
      run({ id: "c1", conclusion: "cancelled" }),
      run({ id: "stale1", conclusion: "stale" }),
      run({ id: "n1", conclusion: "neutral" }),
      run({ id: "skip1", conclusion: "skipped" }),
    ];
    const s = summarizeChecks(runs);
    expect(s.total).toBe(8);
    expect(s.passed).toBe(1);
    expect(s.failed).toBe(3); // failure + timed_out + action_required
    expect(s.cancelled).toBe(2); // cancelled + stale
    expect(s.neutral).toBe(1);
    expect(s.skipped).toBe(1);
    expect(s.pending).toBe(0);
  });

  it("treats in_progress + queued + null-conclusion completed as pending", () => {
    const runs: CheckRun[] = [
      run({ id: "q", status: "queued", conclusion: null }),
      run({ id: "ip", status: "in_progress", conclusion: null }),
      // Edge case: completed with a null conclusion (rare but observed
      // when the run was reset mid-flight). Falls through to pending.
      run({ id: "c-null", status: "completed", conclusion: null }),
    ];
    const s = summarizeChecks(runs);
    expect(s.total).toBe(3);
    expect(s.pending).toBe(3);
    expect(s.passed).toBe(0);
    expect(s.failed).toBe(0);
  });
});
