import assert from "node:assert/strict";
import test from "node:test";
import {
  renderComparativeTerminalReport,
  summarizeComparativeTerminalReport,
} from "./comparative-terminal-report.mjs";

const samples = (...latencies) => latencies.map((latencyMs) => ({ latencyMs }));

test("pools raw successful samples, excludes warmups and preserves failed run counts", () => {
  const report = {
    runs: [
      {
        target: "tmux",
        status: "passed",
        samples: [...samples(1, 2, 3), { warmup: true, latencyMs: 999 }],
      },
      { target: "tmux", status: "passed", samples: samples(100) },
      { target: "tmux", status: "failed", samples: samples(1000), error: "timeout" },
    ],
  };
  const [summary] = summarizeComparativeTerminalReport(report);
  assert.deepEqual(summary.echo, { count: 4, p50: 2, p95: 100, p99: null, max: 100 });
  assert.equal(summary.failed, 1);
  assert.equal(summary.runs[2].echoSamples, 1);
  assert.match(renderComparativeTerminalReport(report), /failed \| 1 \| 0 \| 0 \| timeout/);
});

test("p99 requires at least 100 valid measured samples", () => {
  const run = {
    target: "herdr",
    status: "passed",
    samples: samples(...Array.from({ length: 99 }, (_, i) => i + 1), NaN, -1, Infinity),
  };
  assert.equal(summarizeComparativeTerminalReport({ runs: [run] })[0].echo.p99, null);
  run.samples.push({ latencyMs: 100 });
  assert.equal(summarizeComparativeTerminalReport({ runs: [run] })[0].echo.p99, 99);
});

test("reports missing targets and all-failed targets without fabricating latency", () => {
  const report = {
    options: { targets: ["tmux", "herdr"] },
    runs: [{ target: "tmux", status: "failed", samples: samples(2), cleanupFailed: true }],
  };
  const summary = summarizeComparativeTerminalReport(report);
  assert.equal(summary.length, 2);
  assert.equal(summary[0].echo.count, 0);
  assert.equal(summary[1].startup.p50, null);
  assert.match(renderComparativeTerminalReport(report), /Owned process cleanup failed/);
});

test("keeps startup separate and handles optional resize and sampled resources", () => {
  const report = {
    runs: [
      {
        target: "tmux-ide",
        status: "passed",
        startupMs: 1200,
        samples: samples(2),
        resizeSamples: samples(12),
        resources: {
          samples: [
            { rssKiB: 1024, cpuSeconds: 4 },
            { rssKiB: 2048, cpuSeconds: 8 },
          ],
        },
      },
    ],
  };
  const [summary] = summarizeComparativeTerminalReport(report);
  assert.equal(summary.echo.p50, 2);
  assert.equal(summary.startup.p50, 1200);
  assert.equal(summary.resize.p95, 12);
  const markdown = renderComparativeTerminalReport(report);
  assert.match(markdown, /not physical display refresh/);
  assert.match(markdown, /not an equivalent cold-attach/);
  assert.match(markdown, /tmux-ide \| 2 \| 2.00 \| 2.00 \| 0/);
});

test("escapes table separators and newlines in diagnostic failures", () => {
  const markdown = renderComparativeTerminalReport({
    runs: [{ target: "tmux", status: "failed", error: "bad|value\nnext" }],
  });
  assert.match(markdown, /bad\\\|value next/);
  assert.doesNotMatch(markdown, /## Resize/);
});

test("resource summaries retain missing-process caveats and exclude failed-run samples", () => {
  const report = {
    runs: [
      {
        target: "tmux",
        status: "passed",
        resources: [
          { rssKiB: 2048, cpuSeconds: 0.4, missingRootPids: [42], limitations: ["missing root"] },
          { rssKiB: 1024, cpuSeconds: 0.6, missingRootPids: [] },
        ],
      },
      { target: "tmux", status: "failed", resources: [{ rssKiB: 999999 }] },
    ],
  };
  const [summary] = summarizeComparativeTerminalReport(report);
  assert.equal(summary.resources.rssKiB.max, 2048);
  assert.equal(summary.resources.lastRssKiB, 1024);
  assert.equal(summary.resources.incompleteSamples, 1);
  const markdown = renderComparativeTerminalReport(report);
  assert.match(markdown, /tmux resource collector: missing root/);
  assert.doesNotMatch(markdown, /CPU p50/);
});

test("keeps run denominators and per-run spread including failed partial observations", () => {
  const report = {
    options: { targets: ["tmux", "tmux-ide"] },
    runs: [
      { target: "tmux", status: "passed", samples: samples(1, 3, 9) },
      { target: "tmux", status: "failed", samples: samples(20, 40) },
    ],
  };
  const [a, b] = summarizeComparativeTerminalReport(report);
  assert.deepEqual([a.attempted, a.succeeded, a.failed], [2, 1, 1]);
  assert.deepEqual([b.attempted, b.succeeded, b.failed], [0, 0, 0]);
  assert.deepEqual(
    [a.runs[0].echo.p50, a.runs[0].echo.min, a.runs[0].echo.max, a.runs[0].echo.range],
    [3, 1, 9, 8],
  );
  assert.equal(a.runs[1].echo.range, 20);
  assert.equal(a.echo.count, 3);
  assert.match(renderComparativeTerminalReport(report), /2 \/ 1 \/ 1/);
  assert.match(renderComparativeTerminalReport(report), /not an attempted-interaction denominator/);
});

const phase = (name, entries, extra = {}) => ({
  phase: name,
  processes: entries.map(([pid, cpuSeconds]) => ({ pid, cpuSeconds })),
  ...extra,
});

test("phase CPU uses matched process deltas and exposes churn and missing roots", () => {
  const report = {
    runs: [
      {
        target: "tmux",
        status: "failed",
        resources: [
          phase("before-input", [
            [1, 2],
            [2, 5],
          ]),
          phase(
            "after-input",
            [
              [1, 2.5],
              [3, 10],
            ],
            { missingRootPids: [2] },
          ),
          phase("after-resize", [
            [1, 3],
            [3, 11],
          ]),
        ],
      },
    ],
  };
  const [input, resize] = summarizeComparativeTerminalReport(report)[0].runs[0].phaseCpu;
  assert.equal(input.matchedCpuSeconds, 0.5);
  assert.deepEqual(input.missingPids, [2]);
  assert.deepEqual(input.addedPids, [3]);
  assert.match(input.limitations.join(" "), /owned root is missing/);
  assert.match(input.limitations.join(" "), /partial, not total/);
  assert.equal(resize.matchedCpuSeconds, 1.5);
  assert.match(renderComparativeTerminalReport(report), /0.50 \| 1.50/);
});

test("CPU missing, duplicate or decreasing counters never fabricate zero work", () => {
  for (const resources of [
    [],
    [phase("before-input", [[1, 2]])],
    [phase("before-input", [[1, 2]]), phase("after-input", [[1, 1]])],
    [phase("before-input", [[1, 2]]), phase("after-input", [[1, NaN]])],
    [
      phase("before-input", [[1, 2]]),
      phase("after-input", [
        [1, 3],
        [1, 3],
      ]),
    ],
  ]) {
    assert.equal(
      summarizeComparativeTerminalReport({ runs: [{ target: "tmux", resources }] })[0].runs[0]
        .phaseCpu[0].matchedCpuSeconds,
      null,
    );
  }
});

test("renders shared CPU caveats once while preserving per-phase summary limitations", () => {
  const run = {
    target: "tmux",
    status: "passed",
    resources: [
      phase("before-input", [[1, 1]]),
      phase("after-input", [[1, 2]]),
      phase("after-resize", [[1, 3]]),
    ],
  };
  const report = { runs: [run, run] };
  const markdown = renderComparativeTerminalReport(report);
  assert.equal(markdown.split("PID reuse cannot be detected.").length - 1, 1);
  assert.doesNotMatch(markdown, /missing PIDs/);
  for (const entry of summarizeComparativeTerminalReport(report)[0].runs)
    for (const cpu of entry.phaseCpu) assert.match(cpu.limitations.join(" "), /PID reuse/);
});
