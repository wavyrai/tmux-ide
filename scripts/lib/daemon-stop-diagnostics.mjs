import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a daemon that ignored SIGTERM was doing (#839).
 *
 * A stop that hangs and an event loop that is blocked look the same from the
 * outside: the process stays. These diagnostics tell them apart. A Node
 * diagnostic report needs a running loop, so "no report" plus a child in the
 * process tree means the main thread is blocked on that child; a report shows
 * the JavaScript stack and every handle that is still open.
 */
export const DAEMON_REPORT_SIGNAL = "SIGUSR2";
const MAX_TREE_ROWS = 40;
const MAX_HANDLES = 40;
const MAX_FRAMES = 24;

/** NODE_OPTIONS that make the daemon write a diagnostic report on DAEMON_REPORT_SIGNAL. */
export function daemonReportNodeOptions(reportDirectory, inherited = "") {
  if (
    typeof reportDirectory !== "string" ||
    reportDirectory.length === 0 ||
    /\s/u.test(reportDirectory)
  )
    throw new Error("report directory must be a path without whitespace");
  return [
    inherited.trim(),
    "--report-on-signal",
    `--report-signal=${DAEMON_REPORT_SIGNAL}`,
    `--report-directory=${reportDirectory}`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** The daemon and its descendants from `ps -A -o pid=,ppid=,stat=,etime=,args=` output. */
export function daemonProcessTree(psOutput, rootPid) {
  const rows = [];
  for (const line of String(psOutput).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/u.exec(line);
    if (match)
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        stat: match[3],
        elapsed: match[4],
        command: match[5].slice(0, 240),
      });
  }
  const tree = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length > 0 && tree.length < MAX_TREE_ROWS) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = rows.find((candidate) => candidate.pid === pid);
    if (row) tree.push(row);
    for (const child of rows) if (child.ppid === pid) queue.push(child.pid);
  }
  return tree;
}

/** The parts of a Node diagnostic report that explain a process that will not end. */
export function summarizeNodeReport(report) {
  const handles = Array.isArray(report?.libuv) ? report.libuv : [];
  const active = handles.filter((handle) => handle?.is_active === true);
  const byType = {};
  for (const handle of active) byType[handle.type] = (byType[handle.type] ?? 0) + 1;
  return {
    trigger: report?.header?.trigger ?? null,
    javascriptStack: [report?.javascriptStack?.message, ...(report?.javascriptStack?.stack ?? [])]
      .filter((frame) => typeof frame === "string")
      .slice(0, MAX_FRAMES),
    nativeStack: (report?.nativeStack ?? [])
      .map((frame) => frame?.symbol)
      .filter((symbol) => typeof symbol === "string")
      .slice(0, MAX_FRAMES),
    activeHandles: byType,
    // Referenced handles are what keep the loop, and so the process, alive.
    referencedHandles: active
      .filter((handle) => handle.is_referenced === true)
      .slice(0, MAX_HANDLES)
      .map((handle) => ({
        type: handle.type,
        ...(handle.pid === undefined ? {} : { pid: handle.pid }),
        ...(handle.repeat === undefined ? {} : { repeat: handle.repeat }),
        ...(handle.firesInMsFromNow === undefined
          ? {}
          : { firesInMsFromNow: handle.firesInMsFromNow }),
        ...(handle.localEndpoint?.port === undefined ? {} : { port: handle.localEndpoint.port }),
        ...(handle.signal === undefined ? {} : { signal: handle.signal }),
      })),
  };
}

function linuxThreads(pid, readFile, readDir) {
  try {
    return readDir(`/proc/${pid}/task`)
      .slice(0, 64)
      .map((tid) => {
        // "tid (comm) state ...": comm may contain spaces, state follows the last ")".
        const stat = readFile(`/proc/${pid}/task/${tid}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        return `${tid} ${stat.slice(stat.indexOf("(") + 1, close)} ${stat.slice(close + 2, close + 3)}`;
      });
  } catch {
    return null;
  }
}

/**
 * Collect the diagnostics for one stuck daemon. Never throws: a diagnostic
 * failure must not replace the timeout it explains.
 */
export async function collectDaemonStopDiagnostics({
  pid,
  reportDirectory = null,
  waitMs = 3_000,
  platform = process.platform,
  run = spawnSync,
  kill = process.kill.bind(process),
  readDir = readdirSync,
  readFile = readFileSync,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const diagnostics = { pid };
  try {
    const ps = run("ps", ["-A", "-o", "pid=,ppid=,stat=,etime=,args="], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    diagnostics.processTree = daemonProcessTree(ps.stdout ?? "", pid);
  } catch (error) {
    diagnostics.processTree = `unavailable: ${String(error?.message ?? error).slice(0, 200)}`;
  }
  if (platform === "linux") diagnostics.threads = linuxThreads(pid, readFile, readDir);
  if (!reportDirectory) {
    diagnostics.nodeReport = "not requested";
    return diagnostics;
  }
  try {
    const before = new Set(readDir(reportDirectory));
    kill(pid, DAEMON_REPORT_SIGNAL);
    const deadline = Date.now() + waitMs;
    let name = null;
    while (!name && Date.now() < deadline) {
      await sleep(100);
      name = readDir(reportDirectory).find(
        (entry) => !before.has(entry) && entry.endsWith(".json"),
      );
    }
    if (!name) {
      diagnostics.nodeReport = `none within ${waitMs}ms of ${DAEMON_REPORT_SIGNAL}: the event loop is not running JavaScript (blocked in a synchronous call; see processTree for the child it waits on)`;
      return diagnostics;
    }
    // The report is written in one piece, but allow the writer a moment to finish it.
    let parsed = null;
    for (let attempt = 0; attempt < 10 && !parsed; attempt += 1) {
      try {
        parsed = JSON.parse(readFile(join(reportDirectory, name), "utf8"));
      } catch {
        await sleep(100);
      }
    }
    diagnostics.nodeReportFile = join(reportDirectory, name);
    diagnostics.nodeReport = parsed ? summarizeNodeReport(parsed) : "written but not readable";
  } catch (error) {
    diagnostics.nodeReport = `unavailable: ${String(error?.message ?? error).slice(0, 200)}`;
  }
  return diagnostics;
}
