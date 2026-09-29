import assert from "node:assert/strict";

const positivePid = (pid) => {
  assert(Number.isSafeInteger(pid) && pid > 0, "PID must be a positive safe integer");
};
const unsigned = (text, field) => {
  assert(/^\d+$/u.test(text), `Invalid ${field}`);
  return BigInt(text);
};
const safeNumber = (value, field) => {
  assert(value <= BigInt(Number.MAX_SAFE_INTEGER), `${field} exceeds exact numeric range`);
  return Number(value);
};

/** ps TIME: mm:ss[.fraction], hh:mm:ss[.fraction], or days-hh:mm:ss[.fraction]. */
export function parseMacPsTime(text) {
  assert(typeof text === "string", "CPU time must be text");
  const match = /^(?:(\d+)-)?(\d+):(\d{2})(?::(\d{2}))?(\.\d{1,9})?$/u.exec(text.trim());
  assert(match, "Invalid macOS ps CPU time");
  const [, days, first, second, third, fraction] = match;
  assert(days === undefined || third !== undefined, "Day form requires hours:minutes:seconds");
  const seconds = BigInt(third ?? second);
  assert(seconds < 60n, "Seconds out of range");
  let total;
  if (third === undefined) total = BigInt(first) * 60n + seconds;
  else {
    const hours = BigInt(first);
    assert(BigInt(second) < 60n, "Minutes out of range");
    assert(days === undefined || hours < 24n, "Day-form hours out of range");
    total = (BigInt(days ?? "0") * 24n + hours) * 3600n + BigInt(second) * 60n + seconds;
  }
  return safeNumber(total, "CPU seconds") + Number(fraction ?? "0");
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Input from ps -p PID -o pid= -o lstart= -o state= -o time= -o command=, LC_ALL=C TZ=UTC. */
export function parseMacPsSnapshot(text, requestedPid) {
  positivePid(requestedPid);
  assert(typeof text === "string" && !/[\r\n]/u.test(text.trim()), "Expected one ps row");
  const match =
    /^\s*(\d+)\s+(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+([A-Za-z][A-Za-z+<>sLlNEX-]*)\s+(\S+)\s+([^\r\n]+?)\s*$/u.exec(
      text,
    );
  assert(match, "Invalid macOS ps row or unpinned locale");
  const [, pidText, weekday, month, day, hour, minute, second, year, state, cpu, command] = match;
  assert(
    ["R", "I", "S", "T", "U", "Z", "X", "x"].includes(state[0]),
    "Unknown macOS process state",
  );
  const pid = safeNumber(unsigned(pidText, "PID"), "PID");
  assert.equal(pid, requestedPid, "PID mismatch");
  const stamp = new Date(
    Date.UTC(
      Number(year),
      months.indexOf(month),
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  );
  assert(
    Number(year) >= 1970 &&
      stamp.getUTCFullYear() === Number(year) &&
      stamp.getUTCMonth() === months.indexOf(month) &&
      stamp.getUTCDate() === Number(day) &&
      stamp.getUTCHours() === Number(hour) &&
      stamp.getUTCMinutes() === Number(minute) &&
      stamp.getUTCSeconds() === Number(second) &&
      weekdays[stamp.getUTCDay()] === weekday,
    "Invalid macOS process start date",
  );
  return Object.freeze({
    platform: "darwin",
    pid,
    startIdentity: `darwin:${pid}:${stamp.toISOString()}`,
    identityResolution:
      "one-second lstart; requires fixture's witnessed PID/start/command ownership",
    state,
    cpuSeconds: parseMacPsTime(cpu),
    command,
    alive: !["Z", "X", "x"].includes(state[0]),
  });
}

/** One /proc/PID/stat snapshot; comm may contain spaces, parentheses and newlines. */
export function parseLinuxProcStat(text, { pid, clockTicksPerSecond, bootId }) {
  positivePid(pid);
  assert(
    Number.isSafeInteger(clockTicksPerSecond) && clockTicksPerSecond > 0,
    "Pinned CLK_TCK required",
  );
  assert(
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(bootId),
    "Pinned Linux boot ID required",
  );
  assert(typeof text === "string", "stat must be text");
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  assert(open > 0 && close > open && text[close + 1] === " ", "Malformed proc stat comm boundary");
  assert.equal(
    safeNumber(unsigned(text.slice(0, open).trim(), "stat PID"), "PID"),
    pid,
    "PID mismatch",
  );
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  assert(fields.length >= 20 && /^[A-Za-z]$/u.test(fields[0]), "Truncated proc stat");
  assert(
    ["R", "S", "D", "Z", "T", "t", "X", "x", "K", "W", "P", "I"].includes(fields[0]),
    "Unknown Linux process state",
  );
  const utime = unsigned(fields[11], "utime");
  const stime = unsigned(fields[12], "stime");
  const start = unsigned(fields[19], "starttime").toString();
  const ticks = utime + stime;
  return Object.freeze({
    platform: "linux",
    pid,
    startIdentity: `linux:${bootId}:${pid}:${start}`,
    identityResolution: "boot ID and kernel starttime ticks",
    state: fields[0],
    cpuSeconds: safeNumber(ticks, "CPU ticks") / clockTicksPerSecond,
    cpuTicks: ticks.toString(),
    clockTicksPerSecond,
    command: text.slice(open + 1, close),
    alive: !["Z", "X", "x"].includes(fields[0]),
  });
}

export class ProcessObservationError extends Error {
  constructor(observation) {
    super(`Owned process observation is ${observation.status}`);
    this.name = "ProcessObservationError";
    this.observation = observation;
  }
}

/** readSnapshot must return raw text or null ONLY after a confirmed absence; errors must throw. */
export function createOwnedProcessSampler({ platform, readSnapshot, clockTicksPerSecond, bootId }) {
  assert(["darwin", "linux"].includes(platform), "Unsupported platform");
  assert.equal(typeof readSnapshot, "function");
  async function observeOwnedProcess(pid, expectedIdentity) {
    positivePid(pid);
    if (expectedIdentity !== undefined) {
      const prefix = platform === "linux" ? `linux:${bootId}:${pid}:` : `darwin:${pid}:`;
      assert(
        typeof expectedIdentity === "string" && expectedIdentity.startsWith(prefix),
        "Expected identity must belong to this host/PID",
      );
    }
    const raw = await readSnapshot(pid);
    if (raw === null) return Object.freeze({ pid, status: "absent", alive: false });
    const sample =
      platform === "linux"
        ? parseLinuxProcStat(raw, { pid, clockTicksPerSecond, bootId })
        : parseMacPsSnapshot(raw, pid);
    const status =
      expectedIdentity !== undefined && sample.startIdentity !== expectedIdentity
        ? "reused"
        : sample.state[0] === "Z"
          ? "zombie"
          : !sample.alive
            ? "dead"
            : "present";
    return Object.freeze({ ...sample, status });
  }
  return Object.freeze({
    observeOwnedProcess,
    async sampleOwnedProcess(pid, expectedIdentity) {
      const sample = await observeOwnedProcess(pid, expectedIdentity);
      if (sample.status !== "present") throw new ProcessObservationError(sample);
      return sample;
    },
  });
}

/** A reused PID retires the witnessed original; its replacement must never be signalled as owned. */
export function ownedRetirementProof(expectedIdentity, observation) {
  assert(typeof expectedIdentity === "string" && expectedIdentity.length > 0);
  const pidMatch = /^(?:darwin:|linux:[a-f0-9-]+:)(\d+):/u.exec(expectedIdentity);
  assert(pidMatch && Number(pidMatch[1]) === observation.pid, "Retirement PID mismatch");
  if (observation.status === "absent") return { retired: true, maySignal: false, reason: "absent" };
  assert(typeof observation.startIdentity === "string");
  if (observation.startIdentity !== expectedIdentity)
    return { retired: true, maySignal: false, reason: "pid-reused" };
  return {
    retired: false,
    maySignal: observation.status === "present",
    reason: observation.status,
  };
}

export function ownedCpuDelta(before, after) {
  assert(
    before.status === "present" && after.status === "present",
    "CPU interval requires live samples",
  );
  assert(
    before.pid === after.pid && before.startIdentity === after.startIdentity,
    "CPU interval crosses process identity",
  );
  assert(before.clockTicksPerSecond === after.clockTicksPerSecond, "CLK_TCK changed");
  assert(
    Number.isFinite(before.cpuSeconds) &&
      Number.isFinite(after.cpuSeconds) &&
      after.cpuSeconds >= before.cpuSeconds,
    "CPU counter regressed or invalid",
  );
  return after.cpuSeconds - before.cpuSeconds;
}

/** Orphans are separate cumulative witnesses, never silently zero or part of wait4 descendants. */
export function accountWholeRuntimeCpu({
  fixtureInclusiveCpuSeconds,
  fixtureSelfCpuSeconds,
  reapedIdentities = [],
  server,
  orphanApp,
}) {
  for (const value of [fixtureInclusiveCpuSeconds, fixtureSelfCpuSeconds])
    assert(Number.isFinite(value) && value >= 0, "Invalid fixture CPU");
  assert(fixtureInclusiveCpuSeconds >= fixtureSelfCpuSeconds, "Fixture self exceeds wait4 total");
  for (const sample of [server, orphanApp]) {
    assert(
      sample?.status === "present" &&
        sample.alive &&
        Number.isFinite(sample.cpuSeconds) &&
        sample.cpuSeconds >= 0,
      "Missing live orphan CPU witness",
    );
    positivePid(sample.pid);
    assert(
      typeof sample.startIdentity === "string" && sample.startIdentity.length > 0,
      "Missing orphan start identity",
    );
    assert(
      !reapedIdentities.includes(sample.startIdentity),
      "Orphan double-counted in wait4 descendants",
    );
  }
  assert(server.platform === orphanApp.platform, "Orphans belong to different host platforms");
  assert(
    server.startIdentity !== orphanApp.startIdentity && server.pid !== orphanApp.pid,
    "Orphan server and app overlap",
  );
  const reapedDescendantCpuSeconds = fixtureInclusiveCpuSeconds - fixtureSelfCpuSeconds;
  return Object.freeze({
    reapedDescendantCpuSeconds,
    serverCpuSeconds: server.cpuSeconds,
    orphanAppCpuSeconds: orphanApp.cpuSeconds,
    totalCpuSeconds: reapedDescendantCpuSeconds + server.cpuSeconds + orphanApp.cpuSeconds,
  });
}
