import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCpuTime,
  parsePsSnapshot,
  selectProcessTree,
} from "./comparative-terminal-resources.mjs";

test("parses macOS fractional and Linux day/hour cumulative CPU times", () => {
  assert.equal(parseCpuTime("57:48.33"), 3468.33);
  assert.equal(parseCpuTime("135:00.00"), 8100);
  assert.equal(parseCpuTime("01:02:03"), 3723);
  assert.equal(parseCpuTime("2-01:02:03.50"), 176523.5);
  assert.equal(parseCpuTime("00:00"), 0);
  for (const invalid of ["-", "12", "00:60", "01:60:00", "nonsense"])
    assert.throws(() => parseCpuTime(invalid), /Invalid ps CPU time/);
});

test("parses headerless ps rows without commands or private arguments", () => {
  assert.deepEqual(parsePsSnapshot("  50  1  2048 0:01.25\n 51 50 0 00:00:02\n\n"), [
    { pid: 50, ppid: 1, rssKiB: 2048, cpuSeconds: 1.25 },
    { pid: 51, ppid: 50, rssKiB: 0, cpuSeconds: 2 },
  ]);
  assert.throws(() => parsePsSnapshot("50 1 0 00:00\n50 1 0 00:00"), /duplicate/);
  assert.throws(() => parsePsSnapshot("50 1 ? 00:00"), /Malformed/);
  assert.throws(() => parsePsSnapshot("0 1 0 00:00"), /Invalid/);
});

test("deduplicates stack roots and excludes producer subtree without unrelated processes", () => {
  const snapshot = parsePsSnapshot(`
    10 1 100 00:01
    11 10 200 00:02
    12 11 300 00:03
    13 12 400 00:04
    20 1 500 00:05
    21 20 600 00:06
    99 1 99999 10:00
  `);
  const result = selectProcessTree(snapshot, [10, 11, 20, 10, 404], [12]);
  assert.equal(result.rssKiB, 1400);
  assert.equal(result.cpuSeconds, 14);
  assert.deepEqual(
    result.processes.map(({ pid }) => pid),
    [10, 11, 20, 21],
  );
  assert.deepEqual(result.missingRootPids, [404]);
  assert.deepEqual(result.excludedProducerPids, [12, 13]);
});

test("excludes producer root even when independently supplied as an owned root", () => {
  const snapshot = parsePsSnapshot("10 1 100 00:01\n11 10 200 00:02");
  assert.equal(selectProcessTree(snapshot, [10, 11], [10]).rssKiB, 0);
  assert.equal(selectProcessTree(snapshot, []).rssKiB, 0);
  assert.throws(() => selectProcessTree(snapshot, [0]), /positive integer/);
  assert.throws(() => selectProcessTree(snapshot, [10], ["11"]), /positive integer/);
});

test("missing roots remain explicit and tree walk tolerates cycles", () => {
  const snapshot = parsePsSnapshot("10 11 100 00:01\n11 10 200 00:02");
  const result = selectProcessTree(snapshot, [10, 404]);
  assert.equal(result.rssKiB, 300);
  assert.deepEqual(result.missingRootPids, [404]);
});
