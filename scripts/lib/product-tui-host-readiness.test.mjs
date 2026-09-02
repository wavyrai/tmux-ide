import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { promisify } from "node:util";

import {
  classifyProductTuiCommandFailure,
  exactProductTuiLaunchReceipt,
  waitForProductTuiHostReadiness,
} from "./product-tui-host-readiness.mjs";

const execFileAsync = promisify(execFile);

const receipt = Object.freeze({
  launchId: "launch-1",
  processId: 42,
  target: "workspace",
  hostIdentity: Object.freeze({
    paneId: "%4",
    sessionId: "$2",
    sessionName: "host",
    processId: 42,
    cols: 160,
    rows: 44,
  }),
});

test("accepts only complete immutable launch receipts", () => {
  assert.equal(exactProductTuiLaunchReceipt(receipt, "workspace"), true);
  assert.equal(
    exactProductTuiLaunchReceipt(receipt, { target: "workspace", cols: 160, rows: 44 }),
    true,
  );
  for (const changed of [
    { ...receipt, launchId: "" },
    { ...receipt, processId: 41 },
    { ...receipt, target: "other" },
    { ...receipt, hostIdentity: { ...receipt.hostIdentity, cols: 0 } },
  ]) {
    assert.equal(exactProductTuiLaunchReceipt(changed, "workspace"), false);
  }
  assert.equal(
    exactProductTuiLaunchReceipt(receipt, { target: "workspace", cols: 159, rows: 44 }),
    false,
  );
});

test("retries timeout-only atomically and accepts the exact later snapshot", async () => {
  const statuses = [
    { running: false, statusObservation: { reason: "host-status-timeout" } },
    { ...receipt, running: true },
  ];
  let active = 0;
  let maximumActive = 0;
  const result = await waitForProductTuiHostReadiness({
    launched: receipt,
    readStatus: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const value = statuses.shift();
      active -= 1;
      return value;
    },
    isProcessAlive: () => true,
    now: (() => {
      let value = 0;
      return () => value++;
    })(),
    wait: async () => {},
    deadlineMs: 100,
  });
  assert.equal(result.passed, true);
  assert.equal(result.attempts, 2);
  assert.equal(maximumActive, 1);
});

test("fails closed for persistent timeout, death, mismatch, server loss, and abort", async () => {
  const run = (status, alive = true) =>
    waitForProductTuiHostReadiness({
      launched: receipt,
      readStatus: async () => status,
      isProcessAlive: () => alive,
      now: (() => {
        let value = 0;
        return () => (value += 30);
      })(),
      wait: async () => {},
      deadlineMs: 100,
    });
  assert.equal(
    (await run({ running: false, statusObservation: { reason: "host-status-timeout" } })).reason,
    "host-status-timeout",
  );
  assert.equal(
    (await run({ running: false, statusObservation: { reason: "host-status-timeout" } }, false))
      .reason,
    "process-dead",
  );
  assert.equal(
    (await run({ ...receipt, running: true, hostIdentity: { ...receipt.hostIdentity, cols: 159 } }))
      .reason,
    "identity-invalid",
  );
  assert.equal((await run({ running: false })).reason, "server-gone");
  assert.equal(
    (await run({ running: false, statusObservation: { reason: "identity-invalid" } })).reason,
    "identity-invalid",
  );
  const mismatch = await run({
    ...receipt,
    running: true,
    launchId: "other",
    hostIdentity: { ...receipt.hostIdentity, paneId: "%8" },
  });
  assert.equal(mismatch.reason, "identity-invalid");
  assert.deepEqual(mismatch.currentHostIdentity, {
    paneId: "%8",
    sessionId: "$2",
    sessionName: "host",
    processId: 42,
    cols: 160,
    rows: 44,
  });
  const malformedIdentity = await run({
    running: true,
    launchId: "other",
    hostIdentity: { paneId: "x".repeat(10_000) },
  });
  assert.equal(malformedIdentity.reason, "identity-invalid");
  assert.equal(malformedIdentity.currentHostIdentity, null);
  const aborted = await waitForProductTuiHostReadiness({
    launched: receipt,
    readStatus: async () => {
      const error = new Error("aborted");
      error.code = "ABORT_ERR";
      throw error;
    },
    isProcessAlive: () => true,
  });
  assert.equal(aborted.reason, "aborted");
});

test("classifies the real promisified execFile timeout shape and preserves explicit abort", async () => {
  let timeoutError = null;
  try {
    await execFileAsync(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { timeout: 10 });
  } catch (error) {
    timeoutError = error;
  }
  assert.ok(timeoutError);
  assert.equal(classifyProductTuiCommandFailure(timeoutError), "host-status-timeout");
  const aborted = new Error("aborted");
  aborted.code = "ABORT_ERR";
  aborted.killed = true;
  aborted.signal = "SIGTERM";
  assert.equal(classifyProductTuiCommandFailure(aborted), "aborted");
  assert.equal(
    classifyProductTuiCommandFailure(aborted, { timeoutFired: true }),
    "host-status-timeout",
  );
});

test("real runner timeout is retryable but a persistent real timeout terminates", async () => {
  const timeoutStatus = async () => {
    try {
      await execFileAsync(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { timeout: 10 });
    } catch (error) {
      if (classifyProductTuiCommandFailure(error) === "host-status-timeout") {
        return { running: false, statusObservation: { reason: "host-status-timeout" } };
      }
      throw error;
    }
    assert.fail("runner unexpectedly completed");
  };
  let calls = 0;
  const recovered = await waitForProductTuiHostReadiness({
    launched: receipt,
    readStatus: async () => (++calls === 1 ? timeoutStatus() : { ...receipt, running: true }),
    isProcessAlive: () => true,
    wait: async () => {},
    deadlineMs: 500,
  });
  assert.equal(recovered.passed, true);
  assert.equal(recovered.attempts, 2);
  const persistent = await waitForProductTuiHostReadiness({
    launched: receipt,
    readStatus: timeoutStatus,
    isProcessAlive: () => true,
    wait: async () => {},
    deadlineMs: 35,
  });
  assert.equal(persistent.reason, "host-status-timeout");
  assert.ok(persistent.elapsedMs >= persistent.deadlineMs);
});

test("post-frame revalidation rejects host replacement and shared abort settles immediately", async () => {
  const initial = await waitForProductTuiHostReadiness({
    launched: receipt,
    readStatus: async () => ({ ...receipt, running: true }),
    isProcessAlive: () => true,
  });
  assert.equal(initial.passed, true);
  const replaced = await waitForProductTuiHostReadiness({
    launched: receipt,
    readStatus: async () => ({
      ...receipt,
      running: true,
      launchId: "replacement",
      hostIdentity: { ...receipt.hostIdentity, paneId: "%9" },
    }),
    isProcessAlive: () => true,
  });
  assert.equal(replaced.reason, "identity-invalid");
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  const aborted = await waitForProductTuiHostReadiness({
    launched: receipt,
    readStatus: async () => {
      reads += 1;
      return { ...receipt, running: true };
    },
    isProcessAlive: () => true,
    signal: controller.signal,
  });
  assert.equal(aborted.reason, "aborted");
  assert.equal(reads, 0);
});

test("status uses one atomic async host query and the focus owner never reuses synchronous status", () => {
  const testdrive = readFileSync(new URL("../tui-testdrive.mjs", import.meta.url), "utf8");
  const statusSource = testdrive.slice(
    testdrive.indexOf("async function status("),
    testdrive.indexOf("async function smoke("),
  );
  assert.match(statusSource, /await atomicHostPaneIdentity/u);
  assert.doesNotMatch(statusSource, /sessionExists|liveHostSize|resolveHostPaneIdentity|tmux\(/u);
  const startSource = testdrive.slice(
    testdrive.indexOf("async function start("),
    testdrive.indexOf("async function status("),
  );
  assert.ok(startSource.indexOf("if (options.json)") < startSource.indexOf("await waitForFrame"));
  assert.match(startSource, /"new-session"[\s\S]*"-P"[\s\S]*"-F"/u);
  const rig = readFileSync(new URL("../product-test-rig.mjs", import.meta.url), "utf8");
  const focusLaunch = rig.slice(
    rig.indexOf("launchFocusTui: async (namespace)"),
    rig.indexOf("proveFocusBaseline:", rig.indexOf("launchFocusTui: async (namespace)")),
  );
  assert.match(focusLaunch, /tuiCommandAsync/u);
  assert.match(rig, /signal: controller\.signal/u);
  assert.match(rig, /clearTimeout\(timer\)/u);
  assert.match(focusLaunch, /focus-tui-started/u);
  assert.match(focusLaunch, /focus-host-ready/u);
  assert.doesNotMatch(focusLaunch, /tuiCommand\(/u);
  assert.match(rig, /error instanceof SyntaxError/u);
  assert.match(rig, /reason: "identity-invalid"/u);
});
