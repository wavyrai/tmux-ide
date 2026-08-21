import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { runBoundedChildCommand } from "./bounded-child-command.mjs";
import {
  TESTDRIVE_INPUT_OBSERVATION_PREFIX,
  parseTestdriveInputFailureObservation,
  testdriveInputSupervisorTimeout,
} from "./tui-testdrive-input.mjs";

test("bounded child remains tracked until its retained callback settles after abort", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kills: [],
    kill(signal) {
      this.kills.push(signal);
      return true;
    },
  });
  let callback;
  const tracked = new Set();
  const controller = new AbortController();
  const promise = runBoundedChildCommand({
    executable: "fake",
    args: [],
    options: {},
    timeoutMs: 1_000,
    signal: controller.signal,
    onSpawn: (pid) => tracked.add(pid),
    onSettled: (pid) => tracked.delete(pid),
    execFileImpl: (_executable, _args, _options, done) => {
      callback = done;
      return child;
    },
  });
  controller.abort();
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.deepEqual([...tracked], [4242]);
  const error = Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" });
  callback(error, "", "");
  await assert.rejects(promise, (caught) => caught.code === "ABORT_ERR");
  assert.deepEqual([...tracked], []);
});

test("bounded child retains capped command streams on failure for structured diagnostics", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 4343,
    exitCode: null,
    signalCode: null,
    kill() {
      return true;
    },
  });
  let callback;
  const promise = runBoundedChildCommand({
    executable: "fake",
    args: [],
    options: { maxBuffer: 64 * 1_024 },
    timeoutMs: 1_000,
    execFileImpl: (_executable, _args, _options, done) => {
      callback = done;
      return child;
    },
  });
  const failure = new Error("failed");
  callback(failure, "bounded stdout", "bounded stderr");
  await assert.rejects(promise, (error) => {
    assert.equal(error.stdout, "bounded stdout");
    assert.equal(error.stderr, "bounded stderr");
    return true;
  });
});

test("bounded child uses the callback-specific escalation grace and still reaps", async () => {
  const tracked = new Set();
  const startedAt = performance.now();
  await assert.rejects(
    runBoundedChildCommand({
      executable: process.execPath,
      args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},2147483647)"],
      options: { encoding: "utf8", maxBuffer: 4_096 },
      timeoutMs: 100,
      terminationGraceMs: 50,
      onSpawn: (pid) => tracked.add(pid),
      onSettled: (pid) => tracked.delete(pid),
    }),
    (error) => error.productRigReason === "command-timeout",
  );
  assert.ok(performance.now() - startedAt < 500);
  assert.deepEqual([...tracked], []);
});

test("hung input child is killed and reaped at the inner deadline plus reporting grace", async () => {
  const tracked = new Set();
  const startedAt = performance.now();
  await assert.rejects(
    runBoundedChildCommand({
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},2147483647)"],
      options: { encoding: "utf8", maxBuffer: 64 * 1_024 },
      timeoutMs: testdriveInputSupervisorTimeout(50),
      onSpawn: (pid) => tracked.add(pid),
      onSettled: (pid) => tracked.delete(pid),
    }),
    (error) => error.productRigReason === "command-timeout",
  );
  const elapsed = performance.now() - startedAt;
  assert.ok(elapsed >= 500 && elapsed < 1_500, `unexpected bounded elapsed ${elapsed}`);
  assert.deepEqual([...tracked], []);
});

test("reporting grace retains an inner deadline's exact typed progress", async () => {
  const observation = {
    operation: "tui-testdrive-input",
    kind: "selection-drag",
    substage: "clipboard-wait",
    completedPhases: 22,
    totalPhases: 22,
    completedTransportCalls: 5,
    totalTransportCalls: 5,
    completedPhysicalTransportCalls: 5,
    totalPhysicalTransportCalls: 5,
    cause: "timeout",
    elapsedMs: 50,
    remainingMs: 0,
  };
  const script = `setTimeout(()=>{process.stderr.write(${JSON.stringify(`${TESTDRIVE_INPUT_OBSERVATION_PREFIX}${JSON.stringify(observation)}\n`)});process.exitCode=1},50)`;
  await assert.rejects(
    runBoundedChildCommand({
      executable: process.execPath,
      args: ["-e", script],
      options: { encoding: "utf8", maxBuffer: 64 * 1_024 },
      timeoutMs: testdriveInputSupervisorTimeout(50),
    }),
    (error) => {
      assert.deepEqual(
        parseTestdriveInputFailureObservation(error.stderr, "selection-drag"),
        observation,
      );
      assert.equal(error.productRigReason, undefined);
      return true;
    },
  );
});
