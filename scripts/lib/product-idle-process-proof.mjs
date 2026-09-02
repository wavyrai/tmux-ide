import { execFileSync } from "node:child_process";

export const PRODUCT_IDLE_CPU_BUDGET = Object.freeze({
  minimumWindowMs: 2_000,
  perProcessFloorMs: 50,
  // ps(1) exposes cumulative CPU time at platform-dependent granularity. A
  // two-percent ceiling is tight enough to reject a renderer/daemon spin while
  // leaving room for the OS/runtime housekeeping observed at true visual idle.
  perProcessRatio: 0.02,
  combinedFloorMs: 75,
  combinedRatio: 0.025,
});

function executableFromCommand(command, fallback) {
  const value = String(command ?? "").trim();
  if (value.length === 0) return fallback;
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return /^\S+/u.exec(value)?.[0] ?? fallback;
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (value[index] === "\\" && quote === '"') {
      escaped = true;
      continue;
    }
    if (value[index] === quote) return value.slice(1, index);
  }
  return fallback;
}

export function parseProductProcessCpuTime(value) {
  const match = /^(?:(\d+)-)?(\d+):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/u.exec(
    String(value ?? "").trim(),
  );
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const first = Number(match[2]);
  const second = Number(match[3]);
  const hasHours = match[4] !== undefined;
  const hours = hasHours ? first : 0;
  const minutes = hasHours ? second : first;
  const seconds = hasHours ? Number(match[4]) : second;
  const fraction = Number(`0.${match[5] ?? "0"}`);
  if (
    ![days, hours, minutes, seconds, fraction].every(Number.isFinite) ||
    minutes >= 60 ||
    seconds >= 60
  )
    return null;
  return Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds + fraction) * 1_000);
}

export function parseProductProcessRows(output) {
  return String(output ?? "")
    .trim()
    .split("\n")
    .map((line) =>
      /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(\S+)\s+(.*)$/u.exec(
        line.trim(),
      ),
    )
    .filter(Boolean)
    .flatMap((match) => {
      const cpuTimeMs = parseProductProcessCpuTime(match[6]);
      if (cpuTimeMs === null) return [];
      return [
        Object.freeze({
          pid: Number(match[1]),
          ppid: Number(match[2]),
          pgid: Number(match[3]),
          state: match[4],
          startToken: match[5],
          cpuTimeMs,
          // macOS truncates `comm` to MAXCOMLEN, so it is not a usable process
          // identity fence. Recover argv[0] from the untruncated command field.
          executable: executableFromCommand(match[8], match[7]),
          command: match[8],
        }),
      ];
    });
}

export async function waitForProductVisualQuiescence({
  sample,
  stableMs = 500,
  timeoutMs = 5_000,
  pollMs = 50,
  now = () => performance.now(),
  wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
}) {
  const startedAt = now();
  let previous = await sample();
  let previousKey = JSON.stringify(previous);
  let stableSince = startedAt;
  while (now() - startedAt <= timeoutMs) {
    await wait(pollMs);
    const current = await sample();
    const currentKey = JSON.stringify(current);
    const sampledAt = now();
    if (currentKey !== previousKey) {
      previous = current;
      previousKey = currentKey;
      stableSince = sampledAt;
      continue;
    }
    if (current?.pendingWork === 0 && sampledAt - stableSince >= stableMs)
      return Object.freeze({ settled: true, waitedMs: sampledAt - startedAt, snapshot: current });
  }
  return Object.freeze({
    settled: false,
    waitedMs: now() - startedAt,
    snapshot: previous,
    reason: previous?.pendingWork === 0 ? "visual-work-did-not-settle" : "input-work-pending",
  });
}

export function readProductProcessRows({
  platform = process.platform,
  execute = execFileSync,
} = {}) {
  if (!["darwin", "linux", "freebsd", "openbsd", "netbsd"].includes(platform))
    return Object.freeze({
      supported: false,
      reason: `unsupported-platform:${platform}`,
      rows: [],
    });
  try {
    const output = execute("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart=,time=,comm=,command="], {
      encoding: "utf8",
    });
    const rows = parseProductProcessRows(output);
    return Object.freeze({
      supported: true,
      reason: rows.length > 0 ? null : "process-table-empty",
      rows: Object.freeze(rows),
    });
  } catch (error) {
    return Object.freeze({
      supported: false,
      reason: `process-table-unavailable:${error?.code ?? "unknown"}`,
      rows: [],
    });
  }
}

function exactRole(role, rows, phase) {
  const candidates = [...new Set(role[`${phase}CandidatePids`] ?? [])];
  const row = rows.find(({ pid }) => pid === role.pid) ?? null;
  return Object.freeze({
    role: role.role,
    pid: role.pid,
    ownerGeneration: role.ownerGeneration,
    candidatePids: Object.freeze(candidates),
    singleton: candidates.length === 1 && candidates[0] === role.pid,
    row,
  });
}

export function assessProductIdleProcessWindow({
  label,
  durationMs,
  before,
  after,
  roles,
  work,
  budget = PRODUCT_IDLE_CPU_BUDGET,
}) {
  const measured = before?.supported === true && after?.supported === true;
  const perProcessBudgetMs = Math.max(
    budget.perProcessFloorMs,
    Math.ceil(durationMs * budget.perProcessRatio),
  );
  const combinedBudgetMs = Math.max(
    budget.combinedFloorMs,
    Math.ceil(durationMs * budget.combinedRatio),
  );
  const ledger = (roles ?? []).map((role) => {
    const started = exactRole(role, before?.rows ?? [], "before");
    const ended = exactRole(role, after?.rows ?? [], "after");
    const identityStable =
      started.row !== null &&
      ended.row !== null &&
      started.row.startToken === ended.row.startToken &&
      started.row.executable === ended.row.executable;
    const cpuDeltaMs = identityStable ? ended.row.cpuTimeMs - started.row.cpuTimeMs : null;
    return Object.freeze({
      role: role.role,
      pid: role.pid,
      ownerGeneration: role.ownerGeneration,
      startToken: started.row?.startToken ?? null,
      executable: started.row?.executable ?? null,
      command: started.row?.command ?? null,
      beforeCandidatePids: started.candidatePids,
      afterCandidatePids: ended.candidatePids,
      singleton: started.singleton && ended.singleton,
      identityStable,
      cpuTimeBeforeMs: started.row?.cpuTimeMs ?? null,
      cpuTimeAfterMs: ended.row?.cpuTimeMs ?? null,
      cpuDeltaMs,
      withinBudget:
        Number.isFinite(cpuDeltaMs) && cpuDeltaMs >= 0 && cpuDeltaMs <= perProcessBudgetMs,
    });
  });
  const combinedCpuDeltaMs = ledger.reduce(
    (total, entry) => total + (Number.isFinite(entry.cpuDeltaMs) ? entry.cpuDeltaMs : 0),
    0,
  );
  const workCounts = [
    work?.gridWork,
    work?.fullBlits,
    work?.reconnects,
    work?.pendingWork,
    work?.frames,
    work?.terminalPaints,
  ];
  const workQuiescent =
    workCounts.every((value) => value === 0) && work?.framebufferStable === true;
  const passed =
    measured &&
    durationMs >= budget.minimumWindowMs &&
    ledger.length === 2 &&
    new Set(ledger.map(({ role }) => role)).size === 2 &&
    new Set(ledger.map(({ pid }) => pid)).size === 2 &&
    ledger.every(
      ({ singleton, identityStable, withinBudget }) => singleton && identityStable && withinBudget,
    ) &&
    combinedCpuDeltaMs <= combinedBudgetMs &&
    workQuiescent;
  return Object.freeze({
    version: 1,
    label,
    status: measured ? (passed ? "passed" : "failed") : "unmeasured",
    durationMs,
    perProcessBudgetMs,
    combinedBudgetMs,
    combinedCpuDeltaMs,
    workQuiescent,
    work: Object.freeze({ ...work }),
    ledger: Object.freeze(ledger),
    reason: measured ? null : (before?.reason ?? after?.reason ?? "process-sampling-unavailable"),
  });
}

export function assessProductProcessRetirement(identity, rows) {
  if (
    !identity ||
    !Number.isSafeInteger(identity.pid) ||
    typeof identity.startToken !== "string" ||
    typeof identity.executable !== "string" ||
    !Array.isArray(rows)
  )
    return Object.freeze({ status: "unmeasured", retired: false });
  const live = rows.some(
    (row) =>
      row.pid === identity.pid &&
      row.startToken === identity.startToken &&
      row.executable === identity.executable,
  );
  return Object.freeze({
    status: live ? "failed" : "passed",
    retired: !live,
    pid: identity.pid,
    startToken: identity.startToken,
    executable: identity.executable,
    ownerGeneration: identity.ownerGeneration ?? null,
  });
}
