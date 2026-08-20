const identityKeys = Object.freeze([
  "paneId",
  "sessionId",
  "sessionName",
  "processId",
  "cols",
  "rows",
]);

function boundedCurrentHostIdentity(value) {
  if (
    !/^%[0-9]+$/u.test(value?.paneId ?? "") ||
    !/^\$[0-9]+$/u.test(value?.sessionId ?? "") ||
    typeof value?.sessionName !== "string" ||
    value.sessionName.length < 1 ||
    value.sessionName.length > 128 ||
    !Number.isSafeInteger(value?.processId) ||
    value.processId < 1 ||
    !Number.isSafeInteger(value?.cols) ||
    value.cols < 1 ||
    !Number.isSafeInteger(value?.rows) ||
    value.rows < 1
  ) {
    return null;
  }
  return Object.freeze(Object.fromEntries(identityKeys.map((key) => [key, value[key]])));
}

export function exactProductTuiLaunchReceipt(receipt, expected) {
  const target = typeof expected === "string" ? expected : expected?.target;
  const expectedCols = typeof expected === "string" ? null : expected?.cols;
  const expectedRows = typeof expected === "string" ? null : expected?.rows;
  return (
    typeof receipt?.launchId === "string" &&
    receipt.launchId.length > 0 &&
    receipt.launchId.length <= 64 &&
    receipt.target === target &&
    Number.isSafeInteger(receipt.processId) &&
    receipt.processId > 0 &&
    receipt.processId === receipt.hostIdentity?.processId &&
    /^%[0-9]+$/u.test(receipt.hostIdentity?.paneId ?? "") &&
    /^\$[0-9]+$/u.test(receipt.hostIdentity?.sessionId ?? "") &&
    typeof receipt.hostIdentity?.sessionName === "string" &&
    receipt.hostIdentity.sessionName.length > 0 &&
    receipt.hostIdentity.sessionName.length <= 128 &&
    Number.isSafeInteger(receipt.hostIdentity?.cols) &&
    receipt.hostIdentity.cols > 0 &&
    (expectedCols === null || receipt.hostIdentity.cols === expectedCols) &&
    Number.isSafeInteger(receipt.hostIdentity?.rows) &&
    receipt.hostIdentity.rows > 0 &&
    (expectedRows === null || receipt.hostIdentity.rows === expectedRows)
  );
}

export function sameProductTuiLaunchReceipt(current, launched) {
  return (
    current?.launchId === launched.launchId &&
    current?.processId === launched.processId &&
    current?.target === launched.target &&
    identityKeys.every((key) => current?.hostIdentity?.[key] === launched.hostIdentity?.[key])
  );
}

export function classifyProductTuiCommandFailure(error, { timeoutFired = false } = {}) {
  if (!timeoutFired && (error?.code === "ABORT_ERR" || error?.name === "AbortError")) {
    return "aborted";
  }
  if (
    timeoutFired ||
    error?.code === "ETIMEDOUT" ||
    (error?.code == null && error?.killed === true && error?.signal === "SIGTERM")
  ) {
    return "host-status-timeout";
  }
  return "server-gone";
}

export async function waitForProductTuiHostReadiness({
  launched,
  readStatus,
  isProcessAlive,
  now = () => performance.now(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  deadlineMs = 10_000,
  signal,
}) {
  const startedAt = now();
  let attempts = 0;
  const failure = (reason, currentHostIdentity = null) =>
    Object.freeze({
      passed: false,
      reason,
      attempts,
      elapsedMs: Math.max(0, Math.round(now() - startedAt)),
      deadlineMs,
      currentHostIdentity: boundedCurrentHostIdentity(currentHostIdentity),
    });
  while (now() - startedAt < deadlineMs) {
    if (signal?.aborted) return failure("aborted");
    attempts += 1;
    let current;
    try {
      current = await readStatus({
        remainingMs: Math.max(1, Math.floor(deadlineMs - (now() - startedAt))),
      });
    } catch (error) {
      return failure(classifyProductTuiCommandFailure(error));
    }
    if (current?.running && sameProductTuiLaunchReceipt(current, launched)) {
      return Object.freeze({
        passed: true,
        status: current,
        attempts,
        elapsedMs: Math.max(0, Math.round(now() - startedAt)),
        deadlineMs,
      });
    }
    if (!isProcessAlive(launched.processId)) return failure("process-dead");
    const observedReason = current?.statusObservation?.reason;
    if (observedReason !== "host-status-timeout") {
      return failure(
        ["server-gone", "process-dead", "identity-invalid", "aborted"].includes(observedReason)
          ? observedReason
          : current?.running
            ? "identity-invalid"
            : "server-gone",
        current?.hostIdentity,
      );
    }
    await wait(Math.min(50, Math.max(0, deadlineMs - (now() - startedAt))));
  }
  return failure("host-status-timeout");
}
