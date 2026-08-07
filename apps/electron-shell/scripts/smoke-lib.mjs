/**
 * Pure helpers for the assembled-desktop smoke gate (`smoke-test.mjs`).
 *
 * Everything here is side-effect free and independently tested by
 * `smoke-lib.test.mjs`: the fatal-pattern scan, the deadline poller (its clock
 * and sleep are injected), fleet-session selection, and the attachability
 * report. The driver script keeps the process, tmux and HTTP io.
 */

/**
 * Substrings that mean the assembled app is broken even when the process is
 * still alive: a missing bundle, an unhandled renderer throw, or a CSP refusal
 * of the renderer's own scripts and styles.
 */
export const FATAL_OUTPUT_PATTERNS = Object.freeze([
  "Cannot find module",
  "MODULE_NOT_FOUND",
  "Uncaught Error",
  "Uncaught TypeError",
  "Uncaught ReferenceError",
  "Refused to execute",
  "Refused to apply",
]);

/**
 * Every fatal pattern occurrence in combined stdout/stderr, with the line that
 * carried it (clamped, so a megabyte-long log line cannot swamp the report).
 */
export function scanFatalPatterns(output, patterns = FATAL_OUTPUT_PATTERNS) {
  const findings = [];
  const lines = String(output ?? "").split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    for (const pattern of patterns) {
      if (!line.includes(pattern)) continue;
      findings.push({ pattern, line: line.slice(0, 400), lineNumber: index + 1 });
    }
  }
  return findings;
}

/**
 * Poll `probe` until it returns something other than null/undefined.
 *
 * `now` and `sleep` are injected so the deadline arithmetic is testable without
 * real time. The probe always runs once before the first sleep, and a probe
 * that throws aborts the poll (a broken query is not a "not yet").
 */
export async function pollUntil({
  probe,
  detail,
  timeoutMs,
  intervalMs = 100,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const deadline = now() + timeoutMs;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms (${attempts} attempts) waiting for ${detail}`,
      );
    }
    await sleep(intervalMs);
  }
}

/** The fleet-catalog entry whose sanitized label is exactly this session name. */
export function selectFleetSession(catalog, label) {
  const sessions = catalog?.sessions;
  if (!Array.isArray(sessions)) return null;
  return sessions.find((session) => session?.label === label) ?? null;
}

/**
 * Split an application-shell terminal inventory into attachable and refused
 * resources. The refusal reasons are what names the failing rung when the
 * product cannot attach a pane it just admitted.
 */
export function attachabilityReport(resources) {
  const entries = Array.isArray(resources) ? resources : [];
  const available = [];
  const unavailable = [];
  for (const entry of entries) {
    const attachability = entry?.attachability;
    if (attachability?.status === "available") {
      available.push(attachability.semanticPaneId ?? entry.id);
    } else {
      unavailable.push({ id: entry?.id ?? "unknown", reason: attachability?.reason ?? "unknown" });
    }
  }
  return { total: entries.length, available, unavailable };
}

/** Distinct refusal reasons, most frequent first — the headline for a failure. */
export function dominantRefusalReasons(report) {
  const counts = new Map();
  for (const { reason } of report.unavailable) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([reason, count]) => `${reason} x${count}`);
}
