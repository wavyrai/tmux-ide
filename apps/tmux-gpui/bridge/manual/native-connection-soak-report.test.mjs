// node --test apps/tmux-gpui/bridge/manual/native-connection-soak-report.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { summarise, table } from "./native-connection-soak-report.mjs";

const run = (events, injected) =>
  summarise({ events, injected, inactive: false, seconds: 60, exit: { code: 0, signal: null } });

test("a recovery that needed the user is stuck, not recovered", () => {
  const report = run(
    [
      { event: "down", fault: "owner-rebuild#1" },
      { event: "up", fault: "owner-rebuild#1", ms: 900, msAfterFault: 400, manual: [] },
      { event: "down", fault: "owner-rebuild#1" },
      { event: "stuck", fault: "owner-rebuild#1", needs: "activate" },
      { event: "stuck", fault: "owner-rebuild#1", needs: "refresh" },
      { event: "up", fault: "owner-rebuild#1", ms: 70000, manual: ["activate", "refresh"] },
    ],
    [{ tag: "owner-rebuild#1", name: "owner-rebuild", expectedEnd: false }],
  );
  const [row] = report.faults;
  assert.equal(row.disconnects, 2);
  assert.equal(row.recovered, 1);
  assert.equal(row.stuck, 1);
  assert.deepEqual(row.needs, ["activate", "refresh"]);
  // Time is counted from the end of the fault.
  assert.equal(row.p50, 400);
  assert.equal(report.totals.stuck, 1);
});

test("an ended session is expected only after a fault that ends it", () => {
  const report = run(
    [
      { event: "ended", fault: "session-kill-open#1" },
      { event: "ended", fault: "daemon-restart#2" },
    ],
    [
      { tag: "session-kill-open#1", name: "session-kill-open", expectedEnd: true },
      { tag: "daemon-restart#2", name: "daemon-restart", expectedEnd: false },
    ],
  );
  assert.equal(report.totals.ended, 2);
  assert.equal(report.totals.unexpectedEnds, 1);
});

test("a typed line lost without a notice is a silent loss, with or without a drop", () => {
  const report = run(
    [
      { event: "key-lost", fault: "idle", dropped: false, told: false },
      { event: "key-lost", fault: "daemon-kill#1", dropped: true, told: true },
      { event: "key-lost", fault: "daemon-kill#1", dropped: true, told: false },
    ],
    [{ tag: "daemon-kill#1", name: "daemon-kill", expectedEnd: false }],
  );
  assert.equal(report.totals.silentKeyLoss, 2);
  assert.match(table(report), /\| idle \| 0 \| 0 \| 0 \|/u);
});
