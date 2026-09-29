import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMacPsTime,
  parseMacPsSnapshot,
  parseLinuxProcStat,
  createOwnedProcessSampler,
  ProcessObservationError,
  ownedRetirementProof,
  ownedCpuDelta,
  accountWholeRuntimeCpu,
} from "./process-cpu.mjs";

const bootId = "12345678-1234-1234-1234-123456789abc";
const linuxOptions = { pid: 42, bootId, clockTicksPerSecond: 100 };
function stat({
  pid = 42,
  comm = "tmux: server",
  state = "S",
  user = "125",
  system = "25",
  start = "99999",
} = {}) {
  const fields = Array(50).fill("0");
  fields[0] = state;
  fields[1] = "1";
  fields[11] = user;
  fields[12] = system;
  fields[19] = start;
  return `${pid} (${comm}) ${fields.join(" ")}\n`;
}
function mac({
  pid = 42,
  date = "Tue Sep 29 11:00:00 2026",
  state = "Ss+",
  time = "12:34.56",
  command = "/bundle/tmux -S /private/owned.sock",
} = {}) {
  return ` ${pid} ${date} ${state} ${time} ${command}\n`;
}

for (const [input, expected] of [
  ["00:00", 0],
  [" 12:34.56 ", 754.56],
  ["123:45.125", 7425.125],
  ["1:02:03.5", 3723.5],
  ["25:00:00", 90000],
  ["2-03:04:05.125", 183845.125],
]) {
  test(`macOS cumulative CPU ${input}`, () => assert.equal(parseMacPsTime(input), expected));
}
for (const input of [
  "",
  "1",
  "-1:00",
  "1:60",
  "1:60:00",
  "1-24:00:00",
  "1-02:03",
  "1:02.",
  "1:02x",
  "NaN",
  "999999999999999999999:01",
]) {
  test(`macOS rejects malformed/ambiguous CPU ${input}`, () =>
    assert.throws(() => parseMacPsTime(input)));
}
test("macOS parses a locale-pinned start/CPU/command row without splitting command spaces", () => {
  const value = parseMacPsSnapshot(mac(), 42);
  assert.equal(value.startIdentity, "darwin:42:2026-09-29T11:00:00.000Z");
  assert.equal(value.cpuSeconds, 754.56);
  assert.equal(value.command, "/bundle/tmux -S /private/owned.sock");
  assert.equal(value.state, "Ss+");
  assert.equal(value.alive, true);
});
test("macOS rejects headers, multiple rows, wrong PID, bad dates and an unpinned locale", () => {
  for (const row of [
    "PID STARTED STATE TIME COMMAND\n",
    mac() + mac(),
    mac({ pid: 43 }),
    mac({ state: "Q" }),
    mac({ date: "Tue Feb 31 11:00:00 2026" }),
    mac({ date: "Wed Sep 29 11:00:00 2026" }),
    mac({ date: "Tue Sep 29 25:00:00 2026" }),
    mac({ date: "Di Sep 29 11:00:00 2026" }),
  ])
    assert.throws(() => parseMacPsSnapshot(row, 42));
});
test("Linux parses after final parenthesis and uses utime+stime, excluding child counters", () => {
  const value = parseLinuxProcStat(
    stat({ comm: "shell (child))\n name", start: "90071992547409931234" }),
    linuxOptions,
  );
  assert.equal(value.command, "shell (child))\n name");
  assert.equal(value.cpuSeconds, 1.5);
  assert.equal(value.cpuTicks, "150");
  assert.equal(value.startIdentity, `linux:${bootId}:42:90071992547409931234`);
  assert.equal(
    parseLinuxProcStat(stat(), { ...linuxOptions, clockTicksPerSecond: 1000 }).cpuSeconds,
    0.15,
  );
});
test("Linux rejects missing CLK_TCK, boot identity, truncation, negative ticks and PID mismatch", () => {
  for (const options of [
    { ...linuxOptions, clockTicksPerSecond: undefined },
    { ...linuxOptions, clockTicksPerSecond: 0 },
    { ...linuxOptions, bootId: "" },
  ])
    assert.throws(() => parseLinuxProcStat(stat(), options));
  for (const text of [
    "42 (bad) S 1 2",
    stat({ pid: 43 }),
    stat({ state: "Q" }),
    stat({ user: "-1" }),
    stat({ user: "1.5" }),
    stat({ start: "NaN" }),
    stat({ user: "9007199254740992" }),
    "42 bad S 1 2",
    stat().replace(") ", ")"),
  ])
    assert.throws(() => parseLinuxProcStat(text, linuxOptions));
});
test("sampler has no live I/O and detects absence, zombie and PID reuse without zero fallback", async () => {
  let raw = stat();
  const readerPids = [];
  const sampler = createOwnedProcessSampler({
    platform: "linux",
    ...linuxOptions,
    readSnapshot: async (pid) => {
      readerPids.push(pid);
      return raw;
    },
  });
  const first = await sampler.sampleOwnedProcess(42);
  raw = stat({ user: "225" });
  const second = await sampler.sampleOwnedProcess(42, first.startIdentity);
  assert.equal(ownedCpuDelta(first, second), 1);
  for (const [text, status] of [
    [null, "absent"],
    [stat({ state: "Z" }), "zombie"],
    [stat({ state: "X" }), "dead"],
    [stat({ start: "100000" }), "reused"],
  ]) {
    raw = text;
    const observed = await sampler.observeOwnedProcess(42, first.startIdentity);
    assert.equal(observed.status, status);
    await assert.rejects(
      sampler.sampleOwnedProcess(42, first.startIdentity),
      (error) => error instanceof ProcessObservationError && error.observation.status === status,
    );
    assert.deepEqual(ownedRetirementProof(first.startIdentity, observed), {
      retired: ["absent", "reused"].includes(status),
      maySignal: false,
      reason: status === "reused" ? "pid-reused" : status,
    });
  }
  assert(readerPids.every((pid) => pid === 42));
  await assert.rejects(sampler.sampleOwnedProcess(43, first.startIdentity), /host\/PID/);
});
test("read errors and malformed observations remain failures rather than absence", async () => {
  const denied = new Error("EACCES");
  const sampler = createOwnedProcessSampler({
    platform: "darwin",
    readSnapshot: async () => {
      throw denied;
    },
  });
  await assert.rejects(sampler.sampleOwnedProcess(42), (error) => error === denied);
  for (const raw of [undefined, "", "garbage"]) {
    const bad = createOwnedProcessSampler({ platform: "darwin", readSnapshot: async () => raw });
    await assert.rejects(bad.sampleOwnedProcess(42));
  }
});
test("Mac witnessed start changes reject reuse; command mutation alone is retained separately", async () => {
  let raw = mac();
  const sampler = createOwnedProcessSampler({ platform: "darwin", readSnapshot: async () => raw });
  const first = await sampler.sampleOwnedProcess(42);
  raw = mac({ command: "new process title" });
  assert.equal(
    (await sampler.sampleOwnedProcess(42, first.startIdentity)).command,
    "new process title",
  );
  raw = mac({ date: "Tue Sep 29 11:00:01 2026" });
  await assert.rejects(sampler.sampleOwnedProcess(42, first.startIdentity), /reused/);
  assert.throws(
    () => ownedRetirementProof(first.startIdentity, { pid: 43, status: "absent" }),
    /PID/,
  );
});
test("CPU intervals reject identity changes, counter regression and tick-frequency changes", () => {
  const before = { ...parseLinuxProcStat(stat(), linuxOptions), status: "present" };
  for (const change of [
    { startIdentity: "different" },
    { pid: 43 },
    { cpuSeconds: 0 },
    { clockTicksPerSecond: 1000 },
    { status: "zombie" },
  ])
    assert.throws(() => ownedCpuDelta(before, { ...before, ...change }));
});
test("accounting keeps wait4 descendants, orphan server and orphan app separate", () => {
  const server = { ...parseLinuxProcStat(stat(), linuxOptions), status: "present" };
  const orphanApp = {
    ...parseLinuxProcStat(stat({ pid: 43, user: "275", system: "25" }), {
      ...linuxOptions,
      pid: 43,
    }),
    status: "present",
  };
  const input = { fixtureInclusiveCpuSeconds: 10, fixtureSelfCpuSeconds: 2, server, orphanApp };
  assert.deepEqual(accountWholeRuntimeCpu(input), {
    reapedDescendantCpuSeconds: 8,
    serverCpuSeconds: 1.5,
    orphanAppCpuSeconds: 3,
    totalCpuSeconds: 12.5,
  });
  for (const change of [
    { orphanApp: null },
    { orphanApp: server },
    { reapedIdentities: [server.startIdentity] },
    { fixtureSelfCpuSeconds: 11 },
    { fixtureInclusiveCpuSeconds: NaN },
    { server: { ...server, status: "zombie" } },
  ])
    assert.throws(() => accountWholeRuntimeCpu({ ...input, ...change }));
});
