/** Bounded read-only resource observations for explicitly owned native fixtures. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import { sampleProcessTree } from "./comparative-terminal-resources.mjs";
const execute = promisify(execFile);
export const ISOLATION_LIMITS = Object.freeze({
  processes: 40,
  fdsPerProcess: 512,
  totalFds: 2048,
});
export function parseLsofDescriptors(text, expectedPids) {
  const allowed = new Set(expectedPids);
  const descriptors = new Map();
  let pid = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      if (!Number.isSafeInteger(pid) || !allowed.has(pid)) throw new Error("Unowned lsof PID");
      if (descriptors.has(pid)) throw new Error("Duplicate lsof process");
      descriptors.set(pid, new Set());
    } else if (line.startsWith("f")) {
      if (pid === null) throw new Error("Descriptor without process");
      // cwd/txt/mem are mappings, not numbered file descriptors.
      const match = /^f(\d+)(?:[a-z]*)$/u.exec(line);
      if (match) descriptors.get(pid).add(Number(match[1]));
    } else if (line !== "") throw new Error("Unexpected lsof field");
  }
  return Object.fromEntries([...descriptors].map(([key, values]) => [key, values.size]));
}
export function assertIsolationResourceBudget(sample, limits = ISOLATION_LIMITS) {
  if (sample.processes.length > limits.processes) throw new Error("Owned process budget exceeded");
  const values = Object.values(sample.fdCounts);
  if (
    values.some(
      (count) => !Number.isSafeInteger(count) || count < 0 || count > limits.fdsPerProcess,
    )
  )
    throw new Error("Per-process descriptor budget exceeded");
  if (values.reduce((total, count) => total + count, 0) > limits.totalFds)
    throw new Error("Total descriptor budget exceeded");
  if (sample.missingRootPids.length)
    throw new Error("Owned process root disappeared during sampling");
}
export function partialLsofOutput(error) {
  if (error.code !== 1 || error.stderr !== "" || typeof error.stdout !== "string") throw error;
  return error.stdout;
}
export async function countLinuxDescriptors(pids, ownedPids, readDirectory = readdir) {
  const results = await Promise.all(
    pids.map(async (pid) => {
      try {
        return [
          pid,
          (await readDirectory(`/proc/${pid}/fd`)).filter((name) => /^\d+$/u.test(name)).length,
        ];
      } catch (error) {
        if (error.code === "ENOENT" && !ownedPids.includes(pid)) return null;
        throw new Error("Owned descriptor root missing or unreadable", { cause: error });
      }
    }),
  );
  return Object.fromEntries(results.filter(Boolean));
}
export async function sampleIsolationResources(ownedPids, readIncarnation) {
  if (typeof readIncarnation !== "function")
    throw new Error("Owned process incarnation reader required");
  const before = await Promise.all(ownedPids.map(readIncarnation));
  if (before.some((value) => !value)) throw new Error("Owned process root missing before sampling");
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("Unsupported native resource platform");
  const tree = await sampleProcessTree(ownedPids);
  if (tree.processes.length > ISOLATION_LIMITS.processes)
    throw new Error("Owned process budget exceeded");
  const pids = tree.processes.map(({ pid }) => pid);
  let fdCounts;
  if (process.platform === "darwin") {
    let stdout;
    try {
      ({ stdout } = await execute("/usr/sbin/lsof", ["-nP", "-a", "-p", pids.join(","), "-Fpf"], {
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        env: { ...process.env, LC_ALL: "C" },
      }));
    } catch (error) {
      stdout = partialLsofOutput(error);
    }
    fdCounts = parseLsofDescriptors(stdout, pids);
  } else {
    fdCounts = await countLinuxDescriptors(pids, ownedPids);
  }
  for (const pid of ownedPids)
    if (fdCounts[pid] === undefined) throw new Error("Owned descriptor root missing");
  const after = await Promise.all(ownedPids.map(readIncarnation));
  if (after.some((value, index) => value !== before[index]))
    throw new Error("Owned process incarnation changed during sampling");
  const sample = {
    ...tree,
    fdCounts,
    omittedExitedChildren: pids.filter((pid) => fdCounts[pid] === undefined),
    totalFds: Object.values(fdCounts).reduce((sum, count) => sum + count, 0),
    limits: ISOLATION_LIMITS,
    subscriptionScope: "Gate-owned HTTP event-stream transports only; no internal listener census",
    limitations: [
      ...tree.limitations,
      "FD observations are point-in-time counts, not peaks; short-lived children may exit between ps and lsof/proc reads",
    ],
  };
  assertIsolationResourceBudget(sample);
  return sample;
}
