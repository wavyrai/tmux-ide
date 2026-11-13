import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DAEMON_REPORT_SIGNAL,
  assessSignalledDaemonStop,
  collectDaemonStopDiagnostics,
  daemonProcessTree,
  daemonReportNodeOptions,
  summarizeNodeReport,
} from "./daemon-stop-diagnostics.mjs";

test("builds NODE_OPTIONS that keep inherited options and refuse an unsafe directory", () => {
  assert.equal(
    daemonReportNodeOptions("/tmp/reports", " --max-old-space-size=512 "),
    `--max-old-space-size=512 --report-on-signal --report-signal=${DAEMON_REPORT_SIGNAL} --report-directory=/tmp/reports`,
  );
  assert.throws(() => daemonReportNodeOptions("/tmp/with space"));
  assert.throws(() => daemonReportNodeOptions(""));
});

test("keeps only the daemon and its descendants from ps output", () => {
  const ps = [
    "    1     0 Ss   10-00:00:00 /sbin/init",
    "  100     1 Sl      00:42 node /pkg/bin/cli.js --headless --json",
    "  101   100 S       00:03 tmux -S /tmp/pack.sock show-hooks -g after-send-keys",
    "  102   101 S       00:03 sh -c nested",
    "  200     1 S       00:01 unrelated",
    "garbage",
  ].join("\n");
  assert.deepEqual(
    daemonProcessTree(ps, 100).map((row) => [row.pid, row.ppid, row.stat, row.command]),
    [
      [100, 1, "Sl", "node /pkg/bin/cli.js --headless --json"],
      [101, 100, "S", "tmux -S /tmp/pack.sock show-hooks -g after-send-keys"],
      [102, 101, "S", "sh -c nested"],
    ],
  );
  assert.deepEqual(daemonProcessTree(ps, 999), []);
});

test("summarizes the stack and the handles that keep the loop alive", () => {
  const summary = summarizeNodeReport({
    header: { trigger: "Signal" },
    javascriptStack: { message: "No stack.", stack: ["Unavailable."] },
    nativeStack: [{ symbol: "uv_run" }, { symbol: "node::SpinEventLoop" }, {}],
    libuv: [
      { type: "timer", is_active: true, is_referenced: true, repeat: 0, firesInMsFromNow: 9000 },
      { type: "timer", is_active: true, is_referenced: false },
      { type: "process", is_active: true, is_referenced: true, pid: 4242 },
      { type: "tcp", is_active: false, is_referenced: true },
    ],
  });
  assert.deepEqual(summary.activeHandles, { timer: 2, process: 1 });
  assert.deepEqual(summary.referencedHandles, [
    { type: "timer", repeat: 0, firesInMsFromNow: 9000 },
    { type: "process", pid: 4242 },
  ]);
  assert.deepEqual(summary.nativeStack, ["uv_run", "node::SpinEventLoop"]);
  assert.deepEqual(summary.javascriptStack, ["No stack.", "Unavailable."]);
  assert.equal(summarizeNodeReport(null).trigger, null);
});

test("says that the loop is blocked when no report appears, and never throws", async () => {
  const signals = [];
  const diagnostics = await collectDaemonStopDiagnostics({
    pid: 100,
    reportDirectory: "/reports",
    waitMs: 250,
    platform: "linux",
    run: () => ({ stdout: "  100     1 R  00:42 node cli.js\n  101   100 S 00:20 tmux wait\n" }),
    kill: (pid, signal) => signals.push([pid, signal]),
    readDir: (path) => {
      if (path === "/reports") return [];
      if (path === "/proc/100/task") return ["100", "107"];
      throw new Error("unexpected");
    },
    readFile: (path) => (path.endsWith("/100/stat") ? "100 (node) R 1" : "107 (libuv worker) S 1"),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 20)),
  });
  assert.deepEqual(signals, [[100, DAEMON_REPORT_SIGNAL]]);
  assert.match(diagnostics.nodeReport, /^none within 250ms/u);
  assert.equal(diagnostics.processTree.length, 2);
  assert.deepEqual(diagnostics.threads, ["100 node R", "107 libuv worker S"]);

  const broken = await collectDaemonStopDiagnostics({
    pid: 100,
    reportDirectory: "/reports",
    run: () => {
      throw new Error("ps missing");
    },
    readDir: () => {
      throw new Error("EACCES");
    },
    kill: () => {},
  });
  assert.match(broken.processTree, /^unavailable: ps missing/u);
  assert.match(broken.nodeReport, /^unavailable: EACCES/u);
  assert.equal(
    (await collectDaemonStopDiagnostics({ pid: 100, run: () => ({}) })).nodeReport,
    "not requested",
  );
});

test("reads a real report from a live node process that holds a timer open", async () => {
  const reportDirectory = mkdtempSync(join(tmpdir(), "daemon-stop-diagnostics-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); console.log('up')"], {
    env: { ...process.env, NODE_OPTIONS: daemonReportNodeOptions(reportDirectory) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await new Promise((resolve) => child.stdout.once("data", resolve));
    const diagnostics = await collectDaemonStopDiagnostics({ pid: child.pid, reportDirectory });
    assert.equal(typeof diagnostics.nodeReport, "object", JSON.stringify(diagnostics));
    assert.ok(diagnostics.nodeReport.activeHandles.timer >= 1);
    assert.ok(diagnostics.processTree.some((row) => row.pid === child.pid));
  } finally {
    child.kill("SIGKILL");
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("a forced exit after the stop deadline is a failed stop, not a closed daemon", () => {
  const deadline =
    '{"signal":"SIGTERM","deadlineMs":10000,"stuckStage":"tmux-server-owners","level":"error","component":"daemon-lifecycle","msg":"stop missed the signal deadline; exiting anyway"}';
  const forced = assessSignalledDaemonStop({
    code: 1,
    signal: null,
    stdout: `{"status":"ready"}\n${deadline}\n`,
    stderr: "",
  });
  assert.equal(forced.deadlineLine, deadline);
  assert.match(forced.reason, /teardown hung/u);
  // The line alone is enough, whatever the exit code says.
  assert.ok(assessSignalledDaemonStop({ code: 0, signal: null, stdout: "", stderr: deadline }));
  assert.deepEqual(assessSignalledDaemonStop({ code: 3, signal: null, stdout: "x" }), {
    reason: "the daemon ended with exit code 3 instead of a clean exit 0",
    deadlineLine: null,
  });
  assert.match(
    assessSignalledDaemonStop({ code: null, signal: "SIGKILL" }).reason,
    /signal SIGKILL/u,
  );
  assert.equal(
    assessSignalledDaemonStop({
      code: 0,
      signal: null,
      stdout: '{"status":"ready"}\n',
      stderr: "",
    }),
    null,
  );
});
