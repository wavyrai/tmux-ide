// Browser child only. No descendant or application-total resource attribution.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
export function parseCpuTime(raw) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2})(?:\.(\d+))?$/.exec(raw);
  assert.ok(match, "unsupported ps cumulative CPU format");
  const fraction = match[5] ?? "";
  return {
    seconds:
      Number(match[1] ?? 0) * 86400 +
      Number(match[2] ?? 0) * 3600 +
      Number(match[3]) * 60 +
      Number(match[4]) +
      Number("0." + (fraction || "0")),
    displayQuantumSeconds: fraction ? 10 ** -fraction.length : 1,
  };
}
export function browserResources(child) {
  const started = performance.now(),
    samples = [],
    events = [];
  let stopping = false,
    loop,
    queue = Promise.resolve(),
    identity = null,
    failure = null;
  function sample(label) {
    const requestedMs = performance.now();
    const next = queue.then(async () => {
      if (failure) throw failure;
      assert.ok(performance.now() - started <= 120000, "resource profile duration bound");
      assert.ok(samples.length < 1200, "resource profile sample bound");
      assert.equal(child.exitCode, null, "browser exited during profile");
      assert.equal(child.signalCode, null, "browser signalled during profile");
      const beforeMs = performance.now();
      const stdout = await new Promise((resolve, reject) =>
        execFile(
          "/bin/ps",
          ["-p", String(child.pid), "-o", "pid=,ppid=,rss=,time=,lstart="],
          {
            encoding: "utf8",
            timeout: 1500,
            maxBuffer: 4096,
            env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
          },
          (error, out) => (error ? reject(error) : resolve(out)),
        ),
      );
      const afterMs = performance.now();
      assert.equal(child.exitCode, null, "browser exited during sample");
      assert.equal(child.signalCode, null, "browser signalled during sample");
      const lines = stdout.trim().split("\n");
      assert.equal(lines.length, 1);
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(lines[0]);
      assert.ok(match, "unsupported ps row");
      const pid = Number(match[1]),
        ppid = Number(match[2]);
      assert.equal(pid, child.pid);
      assert.equal(ppid, process.pid);
      const stamp = JSON.stringify([pid, ppid, match[5]]);
      if (identity === null) identity = stamp;
      else assert.equal(stamp, identity, "browser identity changed");
      const cpu = parseCpuTime(match[4]);
      const previous = samples.at(-1);
      if (previous) assert.ok(cpu.seconds >= previous.cpuSeconds, "CPU counter decreased");
      samples.push({
        label,
        requestedMs,
        beforeMs,
        afterMs,
        pid,
        ppid,
        start: match[5],
        rssKiB: Number(match[3]),
        cpuRaw: match[4],
        cpuSeconds: cpu.seconds,
        displayQuantumSeconds: cpu.displayQuantumSeconds,
      });
    });
    queue = next.catch((error) => {
      failure ??= String(error.stack ?? error);
    });
    return next;
  }
  return {
    events,
    mark(label) {
      events.push({ label, atMs: performance.now() });
      assert.ok(events.length <= 64);
    },
    async start() {
      await sample("browser-started");
      loop = (async () => {
        while (!stopping) {
          await delay(100);
          if (!stopping) await sample("periodic");
        }
      })().catch((error) => {
        failure ??= String(error.stack ?? error);
      });
    },
    boundary: sample,
    async stop() {
      stopping = true;
      await loop;
      await queue;
      return {
        scope: "browser child only",
        samples,
        events,
        failure,
        samplingIntervalAfterCompletionMs: 100,
        rssUnit: "KiB",
        rssPeakKind: "sampled maximum, not lifetime peak",
        cpuKind: "ps time cumulative user+system, no -S; excludes child/helper CPU",
        quantization:
          "Use observed displayed quantum; deltas below twice endpoint quantum are inconclusive. Display precision is not counter accuracy.",
        excluded: [
          "native GPUI",
          "daemon",
          "live helpers",
          "tmux",
          "pane processes",
          "WindowServer",
          "shared-memory deduplication",
        ],
      };
    },
  };
}
