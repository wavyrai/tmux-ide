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
