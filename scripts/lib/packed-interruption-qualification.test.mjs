import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessPackedInterruption,
  verifyPackedArtifactInventory,
} from "./packed-interruption-qualification.mjs";

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

function artifactProof(mode = "bundled") {
  const names = [
    "cli-resolution-case.json",
    "cli-resolution-vitest.json",
    "tmux-ide-2.9.5.tgz",
    "tmux-ide-sdk-0.1.0.tgz",
    "tmux-ide-tui-linux-x64",
    "tmux-ide-tui-linux-x64.gz",
    "tmux-ide-tui-linux-x64.gz.sha256",
    "tmux-ide-cli.js",
  ];
  return {
    version: "2.9.5",
    platform: "linux-x64",
    automation: { sdkVersion: "0.1.0" },
    cliResolution: {
      passed: 1,
      nativeMode: mode,
      case: { nativeMode: mode, bundledCleanPath: { applicable: mode === "bundled" } },
    },
    artifacts: names.map((name) => ({ name, bytes: 1, sha256: "a".repeat(64) })),
  };
}
test("interruption requires eight named artifacts including CLI resolution in both modes", () => {
  for (const mode of ["bundled", "system-fallback"]) {
    const proof = artifactProof(mode);
    assert.equal(verifyPackedArtifactInventory(proof).length, 8);
    for (let i = 0; i < 8; i++) {
      const missing = structuredClone(proof);
      missing.artifacts.splice(i, 1);
      assert.throws(() => verifyPackedArtifactInventory(missing), /artifact-inventory/);
    }
  }
});
test("artifact inventory rejects duplicates, substitutions, malformed hashes and false mode coverage", () => {
  for (const mutate of [
    (p) => {
      p.artifacts[0] = p.artifacts[1];
    },
    (p) => {
      p.artifacts[0].name = "unrelated.json";
    },
    (p) => {
      p.artifacts[0].sha256 = "wrong";
    },
    (p) => {
      p.artifacts[0].bytes = -1;
    },
    (p) => {
      p.cliResolution.case.bundledCleanPath.applicable = false;
    },
    (p) => {
      p.cliResolution.passed = 0;
    },
    (p) => {
      p.cliResolution.nativeMode = "automatic";
    },
  ]) {
    const proof = artifactProof();
    mutate(proof);
    assert.throws(() => verifyPackedArtifactInventory(proof));
  }
});
