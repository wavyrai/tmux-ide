import { test } from "node:test";
import assert from "node:assert/strict";
import { assessPackedInterruption } from "./packed-interruption-qualification.mjs";

function fixture() {
  return {
    mode: "hold-input-ready",
    pid: 100,
    exitCode: 1,
    signal: null,
    ready: {
      runnerPid: 100,
      mode: "hold-input-ready",
      runtimePid: 101,
      directPids: [102],
      tmuxWitness: { pid: 103, path: "/private/fixture/socket" },
      roots: ["/private/fixture/a", "/private/fixture/b"],
    },
    proof: {
      completed: false,
      retainedRoots: [],
      interruption: { requested: true, signal: "SIGTERM", commands: [{ pid: 104 }] },
      cleanup: {
        runtime: true,
        tmuxSocketRemoved: true,
        tmuxOwnerDead: true,
        children: { confirmed: true },
        installationScenarios: true,
        failures: [],
      },
    },
    absentPid: () => true,
    absentPath: () => true,
  };
}
test("accepts only the intended failed journey with observed SIGTERM and owned cleanup", () => {
  const result = assessPackedInterruption(fixture());
  assert.equal(result.ok, true);
  assert.deepEqual(result.recordedPids, [100, 101, 103, 102, 104]);
});
test("a successful exit, completed journey or missing signal cannot qualify interruption", () => {
  for (const modify of [
    (value) => {
      value.exitCode = 0;
    },
    (value) => {
      value.proof.completed = true;
    },
    (value) => {
      value.proof.interruption.requested = false;
    },
    (value) => {
      value.signal = "SIGKILL";
    },
  ]) {
    const value = fixture();
    modify(value);
    assert.equal(assessPackedInterruption(value).ok, false);
  }
});
test("unknown or present process/path evidence and runtime refusal stay unqualified", () => {
  for (const modify of [
    (value) => {
      value.absentPid = () => false;
    },
    (value) => {
      value.absentPath = () => false;
    },
    (value) => {
      value.ready.runtimePid = null;
    },
    (value) => {
      value.ready.roots = [];
    },
    (value) => {
      value.proof.cleanup.runtime = false;
    },
    (value) => {
      value.proof.retainedRoots = ["/private/fixture/a"];
    },
  ]) {
    const value = fixture();
    modify(value);
    assert.equal(assessPackedInterruption(value).ok, false);
  }
});
test("injected failure is distinct from SIGTERM but still requires exact ready ownership", () => {
  const value = fixture();
  value.mode = value.ready.mode = "fail-input-ready";
  value.proof.interruption.requested = false;
  value.proof.interruption.signal = null;
  assert.equal(assessPackedInterruption(value).ok, true);
  value.proof.interruption.requested = true;
  value.proof.interruption.signal = "SIGTERM";
  assert.equal(assessPackedInterruption(value).ok, false);
  value.proof.interruption.requested = false;
  value.proof.interruption.signal = null;
  value.ready.runnerPid++;
  assert.equal(assessPackedInterruption(value).ok, false);
});
