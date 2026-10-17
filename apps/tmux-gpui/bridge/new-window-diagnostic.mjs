// Failure evidence only: never retain arbitrary helper stderr or response data.
const refreshStages = new Set([
  "retire",
  "inventory",
  "created-pane",
  "original-pane",
  "sessions",
  "selected-session",
  "attach",
  "unknown",
]);
const catalogStages = new Set([
  "list-sessions",
  "revalidate-sessions",
  "open-session",
  "inventory",
  "connection-validation",
]);
const reasons = new Set([
  "selection unavailable",
  "unclassified failure",
  "catalog retired",
  "scope mismatch",
  "request failed",
  "invalid response",
  "transport or response failure",
  "request timed out",
  "request aborted",
]);
export function newWindowDiagnostic(stderr) {
  let result = null;
  for (const line of stderr.split("\n")) {
    if (line.length > 1024) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value?.stage !== "new-window-refresh-failed" || !refreshStages.has(value.refreshStage))
      continue;
    result = { refreshStage: value.refreshStage };
    const c = value.catalog;
    if (c && catalogStages.has(c.stage) && reasons.has(c.reason)) {
      result.catalog = { stage: c.stage, reason: c.reason };
      if (Number.isInteger(c.status) && c.status >= 100 && c.status <= 599)
        result.catalog.status = c.status;
    }
  }
  return result;
}
