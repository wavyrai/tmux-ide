import { spawn } from "node:child_process";

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function childHasExited(child, observedExit) {
  return observedExit || child.exitCode !== null || child.signalCode !== null;
}

/**
 * Hold a macOS idle-sleep assertion for the exact ProductRig owner process.
 *
 * This is qualification infrastructure, not product behavior. A suspended host
 * cannot produce a meaningful wall-clock launch sample, so the runner fails
 * closed if it cannot acquire and retain the assertion. `-w` is a second
 * lifetime fence; normal cleanup still terminates and reaps the exact child.
 */
export async function acquireProductRigSleepAssertion({
  platform = process.platform,
  ownerPid = process.pid,
  spawnProcess = spawn,
  settle = nextTurn,
  signal,
} = {}) {
  if (platform !== "darwin") {
    return Object.freeze({
      kind: "not-required",
      pid: null,
      active: () => true,
      failure: new Promise(() => undefined),
      release: async () => undefined,
    });
  }
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0)
    throw new TypeError("ProductRig sleep assertion owner PID must be a positive safe integer");

  const child = spawnProcess("/usr/bin/caffeinate", ["-i", "-w", String(ownerPid)], {
    stdio: "ignore",
  });
  let observedExit = false;
  let released = false;
  let releasePromise = null;
  let rejectFailure;
  const failure = new Promise((_, reject) => {
    rejectFailure = reject;
  });
  // The owner attaches its fail-closed handler immediately after acquisition,
  // but observe the promise here as well so a close in that hand-off cannot
  // become a process-level unhandled rejection.
  void failure.catch(() => undefined);
  child.on("error", (error) => {
    if (!released)
      rejectFailure(
        new Error(
          `ProductRig macOS idle-sleep assertion failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  });
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  child.once("close", (code, closeSignal) => {
    observedExit = true;
    resolveClosed();
    if (!released)
      rejectFailure(
        new Error(
          `ProductRig macOS idle-sleep assertion exited unexpectedly (${closeSignal ?? code ?? "unknown"})`,
        ),
      );
  });

  const spawned = new Promise((resolve, reject) => {
    const onError = (error) => {
      child.off("spawn", onSpawn);
      reject(
        new Error(
          `ProductRig could not acquire the macOS idle-sleep assertion: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    };
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
  let rejectAborted;
  const aborted = new Promise((_, reject) => {
    rejectAborted = reject;
  });
  const onAbort = () => {
    released = true;
    void spawned
      .catch(() => undefined)
      .then(async () => {
        if (!childHasExited(child, observedExit)) child.kill("SIGTERM");
        if (!observedExit) await closed;
      })
      .finally(() =>
        rejectAborted(new Error("ProductRig macOS idle-sleep assertion acquisition aborted")),
      );
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([spawned, aborted]);
    await Promise.race([settle(), aborted]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || childHasExited(child, observedExit)) {
    throw new Error("ProductRig macOS idle-sleep assertion exited before acquisition completed");
  }

  const release = async () => {
    if (releasePromise) return releasePromise;
    releasePromise = (async () => {
      released = true;
      if (!childHasExited(child, observedExit)) child.kill("SIGTERM");
      if (!observedExit) await closed;
    })();
    return releasePromise;
  };
  return Object.freeze({
    kind: "macos-idle-sleep",
    pid: child.pid,
    active: () => !released && !childHasExited(child, observedExit),
    failure,
    release,
  });
}
