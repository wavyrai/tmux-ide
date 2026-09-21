import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** ps TIME is cumulative CPU, not elapsed time or CPU utilization. */
export function parseCpuTime(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) throw new Error(`Invalid ps CPU time: ${value}`);
  const [, days, hours, minutes, seconds] = match;
  if (Number(seconds) >= 60 || (hours !== undefined && Number(minutes) >= 60))
    throw new Error(`Invalid ps CPU time: ${value}`);
  const result =
    Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
  if (!Number.isFinite(result)) throw new Error(`Invalid ps CPU time: ${value}`);
  return result;
}

export function parsePsSnapshot(output) {
  const seen = new Set();
  return output
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
      if (!match) throw new Error("Malformed ps process row");
      const [, pidText, ppidText, rssText, cpuText] = match;
      const pid = Number(pidText);
      const ppid = Number(ppidText);
      const rssKiB = Number(rssText);
      if (
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        !Number.isSafeInteger(ppid) ||
        !Number.isSafeInteger(rssKiB) ||
        seen.has(pid)
      )
        throw new Error("Invalid or duplicate ps process identity");
      seen.add(pid);
      return { pid, ppid, rssKiB, cpuSeconds: parseCpuTime(cpuText) };
    });
}

function validatePids(pids) {
  if (!Array.isArray(pids) || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0))
    throw new TypeError("Process roots must be an array of positive integer PIDs");
  return [...new Set(pids)];
}

/** Select only explicitly owned roots and currently parented descendants. */
export function selectProcessTree(snapshot, ownedRootPids, producerPids = []) {
  const roots = validatePids(ownedRootPids);
  const producers = validatePids(producerPids);
  const byPid = new Map(snapshot.map((entry) => [entry.pid, entry]));
  const children = new Map();
  for (const entry of snapshot) {
    const siblings = children.get(entry.ppid) ?? [];
    siblings.push(entry.pid);
    children.set(entry.ppid, siblings);
  }
  const descendants = (initial) => {
    const selected = new Set();
    const pending = [...initial];
    while (pending.length) {
      const pid = pending.pop();
      if (selected.has(pid)) continue;
      selected.add(pid);
      pending.push(...(children.get(pid) ?? []));
    }
    return selected;
  };
  const included = descendants(roots);
  const excluded = descendants(producers);
  const processes = snapshot
    .filter(({ pid }) => included.has(pid) && !excluded.has(pid))
    .sort((left, right) => left.pid - right.pid);
  return {
    rssKiB: processes.reduce((sum, entry) => sum + entry.rssKiB, 0),
    cpuSeconds: processes.reduce((sum, entry) => sum + entry.cpuSeconds, 0),
    processes,
    missingRootPids: roots.filter((pid) => !byPid.has(pid)),
    excludedProducerPids: snapshot
      .filter(({ pid }) => included.has(pid) && excluded.has(pid))
      .map(({ pid }) => pid)
      .sort((left, right) => left - right),
  };
}

/** One bounded system snapshot; callers choose idle/workload sampling cadence. */
export async function sampleProcessTree(ownedRootPids, producerPids = []) {
  validatePids(ownedRootPids);
  validatePids(producerPids);
  const startedAt = new Date().toISOString();
  const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,rss=,time="], {
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return {
    sampledAt: new Date().toISOString(),
    startedAt,
    ...selectProcessTree(parsePsSnapshot(stdout), ownedRootPids, producerPids),
    limitations: [
      "RSS sums may count shared pages more than once; this is not unique physical memory",
      "ps scans processes over an interval; this is not an atomic kernel snapshot or a peak",
      "CPU is cumulative seconds for sampled live processes, not utilization; exited children are absent",
      "Reparented descendants require explicit owned roots; PID reuse cannot be detected from these fields",
    ],
  };
}
