import assert from "node:assert/strict";
/** Verify a deliberately failed journey; never equate it with a completed product journey. */
export function assessPackedInterruption({
  mode,
  pid,
  exitCode,
  signal,
  ready,
  proof,
  absentPid,
  absentPath,
}) {
  const failures = [];
  const require = (condition, reason) => {
    if (!condition) failures.push(reason);
  };
  require(["hold-input-ready", "fail-input-ready"].includes(mode), "unknown-mode");
  require(ready?.runnerPid === pid && ready?.mode === mode, "ready-owner-mismatch");
  require(Number.isInteger(exitCode) && exitCode !== 0 && signal === null, "expected-failed-exit");
  require(proof?.completed === false, "journey-must-remain-incomplete");
  require(Array.isArray(proof?.retainedRoots) &&
    proof.retainedRoots.length === 0, "retained-roots");
  const cleanup = proof?.cleanup;
  require(cleanup?.runtime &&
    cleanup.tmuxSocketRemoved &&
    cleanup.tmuxOwnerDead &&
    cleanup.children?.confirmed &&
    cleanup.installationScenarios &&
    Array.isArray(cleanup.failures) &&
    cleanup.failures.length === 0, "cleanup-unconfirmed");
  if (mode === "hold-input-ready")
    require(proof?.interruption?.requested &&
      proof.interruption.signal === "SIGTERM", "signal-not-observed");
  if (mode === "fail-input-ready")
    require(proof?.interruption?.requested === false &&
      proof.interruption.signal === null, "unexpected-cancellation");
  const pids = [
    ...new Set([
      pid,
      ready?.runtimePid,
      ready?.tmuxWitness?.pid,
      ...(ready?.directPids ?? []),
      ...(proof?.interruption?.commands ?? []).map((entry) => entry.pid),
    ]),
  ];
  const validPids = pids.every((value) => Number.isSafeInteger(value) && value > 1);
  require(validPids, "invalid-pid-evidence");
  const presentPids = validPids ? pids.filter((value) => !absentPid(value)) : [];
  require(presentPids.length === 0, "recorded-process-present");
  const paths = [...(ready?.roots ?? []), ready?.tmuxWitness?.path];
  const validPaths =
    paths.length >= 3 && paths.every((value) => typeof value === "string" && value.startsWith("/"));
  require(validPaths, "invalid-path-evidence");
  const presentPaths = validPaths ? paths.filter((value) => !absentPath(value)) : [];
  require(presentPaths.length === 0, "recorded-path-present");
  return {
    ok: failures.length === 0,
    failures,
    recordedPids: pids,
    presentPids,
    recordedPathCount: paths.length,
    presentPathCount: presentPaths.length,
  };
}

/** Both native modes run CLI resolution and retain its two independently checked reports. */
export function verifyPackedArtifactInventory(proof) {
  assert(
    ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].includes(proof.platform),
    "artifact-platform",
  );
  assert(
    typeof proof.version === "string" &&
      /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(proof.version),
    "artifact-version",
  );
  const sdkVersion = proof.automation?.sdkVersion;
  assert(
    typeof sdkVersion === "string" &&
      /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(sdkVersion),
    "artifact-sdk-version",
  );
  const resolution = proof.cliResolution;
  assert(
    resolution?.passed === 1 && ["bundled", "system-fallback"].includes(resolution.nativeMode),
    "artifact-resolution-mode",
  );
  assert(resolution.case?.nativeMode === resolution.nativeMode, "artifact-resolution-mode");
  assert.equal(
    resolution.case?.bundledCleanPath?.applicable,
    resolution.nativeMode === "bundled",
    "artifact-bundled-coverage",
  );
  const names = [
    "cli-resolution-case.json",
    "cli-resolution-vitest.json",
    `tmux-ide-${proof.version}.tgz`,
    `tmux-ide-sdk-${sdkVersion}.tgz`,
    `tmux-ide-tui-${proof.platform}`,
    `tmux-ide-tui-${proof.platform}.gz`,
    `tmux-ide-tui-${proof.platform}.gz.sha256`,
    "tmux-ide-cli.js",
  ];
  assert(Array.isArray(proof.artifacts), "artifact-inventory");
  assert.deepEqual(proof.artifacts.map((a) => a.name).sort(), names.sort(), "artifact-inventory");
  for (const artifact of proof.artifacts) {
    assert(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0, "artifact-bytes");
    assert(
      typeof artifact.sha256 === "string" && /^[a-f0-9]{64}$/.test(artifact.sha256),
      "artifact-hash",
    );
  }
  return proof.artifacts;
}
