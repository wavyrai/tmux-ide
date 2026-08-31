import assert from "node:assert/strict";
import test from "node:test";

import {
  assessProductIdleProcessWindow,
  assessProductProcessRetirement,
  parseProductProcessCpuTime,
  parseProductProcessRows,
  readProductProcessRows,
  waitForProductVisualQuiescence,
} from "./product-idle-process-proof.mjs";

const row = ({ pid, cpuTimeMs, startToken = "Mon Aug 31 10:00:00 2026", executable }) => ({
  pid,
  ppid: 1,
  pgid: pid,
  state: "S",
  startToken,
  cpuTimeMs,
  executable,
  command: `${executable} fixture`,
});

test("parses portable ps cumulative CPU clocks and exact process identities", () => {
  assert.equal(parseProductProcessCpuTime("0:01.25"), 1_250);
  assert.equal(parseProductProcessCpuTime("01:02:03.50"), 3_723_500);
  assert.equal(parseProductProcessCpuTime("2-01:02:03"), 176_523_000);
  const rows = parseProductProcessRows(
    "42 1 42 S Mon Aug 31 10:00:00 2026 0:01.25 /usr/bin/node /usr/bin/node daemon.js --headless\n",
  );
  assert.deepEqual(rows, [
    {
      pid: 42,
      ppid: 1,
      pgid: 42,
      state: "S",
      startToken: "Mon Aug 31 10:00:00 2026",
      cpuTimeMs: 1_250,
      executable: "/usr/bin/node",
      command: "/usr/bin/node daemon.js --headless",
    },
  ]);
  assert.equal(
    parseProductProcessRows(
      "43 1 43 S Mon Aug 31 10:00:00 2026 0:01.25 /Users/thijs/.nv /Users/thijs/.nvm/versions/node/v24/bin/node daemon.js --headless\n",
    )[0].executable,
    "/Users/thijs/.nvm/versions/node/v24/bin/node",
  );
});

test("waits for a zero-pending visual snapshot to remain unchanged", async () => {
  let clock = 0;
  let calls = 0;
  const result = await waitForProductVisualQuiescence({
    sample: async () => {
      calls += 1;
      return calls < 3
        ? { frames: calls, pendingWork: 0 }
        : { frames: 2, pendingWork: calls < 5 ? 1 : 0 };
    },
    stableMs: 200,
    timeoutMs: 2_000,
    pollMs: 100,
    now: () => clock,
    wait: async (durationMs) => {
      clock += durationMs;
    },
  });
  assert.deepEqual(result, {
    settled: true,
    waitedMs: 600,
    snapshot: { frames: 2, pendingWork: 0 },
  });
});

test("process sampling is explicit and safe on unsupported hosts", () => {
  assert.deepEqual(readProductProcessRows({ platform: "win32" }), {
    supported: false,
    reason: "unsupported-platform:win32",
    rows: [],
  });
});

test("qualifies two singleton stable identities with bounded CPU and zero work", () => {
  const beforeRows = [
    row({ pid: 42, cpuTimeMs: 1_000, executable: "/usr/bin/node" }),
    row({ pid: 84, cpuTimeMs: 2_000, executable: "/tmp/tmux-ide-tui" }),
  ];
  const afterRows = [
    row({ pid: 42, cpuTimeMs: 1_040, executable: "/usr/bin/node" }),
    row({ pid: 84, cpuTimeMs: 2_030, executable: "/tmp/tmux-ide-tui" }),
  ];
  const proof = assessProductIdleProcessWindow({
    label: "post-reattach",
    durationMs: 10_100,
    before: { supported: true, rows: beforeRows },
    after: { supported: true, rows: afterRows },
    roles: [
      {
        role: "daemon",
        pid: 42,
        ownerGeneration: "daemon-a",
        beforeCandidatePids: [42],
        afterCandidatePids: [42],
      },
      {
        role: "hosted-renderer",
        pid: 84,
        ownerGeneration: "launch-a",
        beforeCandidatePids: [84],
        afterCandidatePids: [84],
      },
    ],
    work: {
      gridWork: 0,
      fullBlits: 0,
      reconnects: 0,
      pendingWork: 0,
      frames: 0,
      terminalPaints: 0,
      framebufferStable: true,
    },
  });
  assert.equal(proof.status, "passed");
  assert.equal(proof.perProcessBudgetMs, 202);
  assert.equal(proof.combinedBudgetMs, 253);
  assert.equal(proof.combinedCpuDeltaMs, 70);
  assert.equal(
    proof.ledger.every(({ singleton, identityStable }) => singleton && identityStable),
    true,
  );
});

test("rejects PID reuse, duplicate ownership, CPU churn, and visual work", () => {
  const beforeRows = [
    row({ pid: 42, cpuTimeMs: 1_000, executable: "/usr/bin/node" }),
    row({ pid: 84, cpuTimeMs: 2_000, executable: "/tmp/tmux-ide-tui" }),
  ];
  const afterRows = [
    row({
      pid: 42,
      cpuTimeMs: 1_500,
      executable: "/usr/bin/node",
      startToken: "Mon Aug 31 10:01:00 2026",
    }),
    row({ pid: 84, cpuTimeMs: 2_500, executable: "/tmp/tmux-ide-tui" }),
  ];
  const proof = assessProductIdleProcessWindow({
    label: "bad",
    durationMs: 10_100,
    before: { supported: true, rows: beforeRows },
    after: { supported: true, rows: afterRows },
    roles: [
      {
        role: "daemon",
        pid: 42,
        ownerGeneration: "daemon-a",
        beforeCandidatePids: [42, 43],
        afterCandidatePids: [42],
      },
      {
        role: "hosted-renderer",
        pid: 84,
        ownerGeneration: "launch-a",
        beforeCandidatePids: [84],
        afterCandidatePids: [84],
      },
    ],
    work: {
      gridWork: 1,
      fullBlits: 0,
      reconnects: 0,
      pendingWork: 0,
      frames: 0,
      terminalPaints: 0,
      framebufferStable: true,
    },
  });
  assert.equal(proof.status, "failed");
  assert.equal(proof.ledger[0].identityStable, false);
  assert.equal(proof.ledger[0].singleton, false);
  assert.equal(proof.ledger[1].withinBudget, false);
});

test("retirement is fenced by PID, start token, and executable", () => {
  const identity = {
    pid: 84,
    startToken: "Mon Aug 31 10:00:00 2026",
    executable: "/tmp/tmux-ide-tui",
    ownerGeneration: "launch-a",
  };
  assert.equal(assessProductProcessRetirement(identity, []).retired, true);
  assert.equal(
    assessProductProcessRetirement(identity, [
      row({
        pid: 84,
        cpuTimeMs: 0,
        executable: "/tmp/tmux-ide-tui",
        startToken: "Mon Aug 31 10:01:00 2026",
      }),
    ]).retired,
    true,
  );
  assert.equal(
    assessProductProcessRetirement(identity, [
      row({ pid: 84, cpuTimeMs: 0, executable: "/tmp/tmux-ide-tui" }),
    ]).retired,
    false,
  );
});
