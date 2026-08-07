import { describe, expect, it } from "vitest";

import {
  classifyDaemonStartFailure,
  daemonRestartDelayMs,
  supervisorHaltReason,
  DEFAULT_DAEMON_RESTART_POLICY,
  type DaemonStartFailure,
} from "./daemon-supervision-policy.ts";

const midpoint = (): number => 0.5;

describe("daemon start failure classification", () => {
  it.each([
    ["record-invalid", "record-invalid"],
    ["protocol-incompatible", "protocol-incompatible"],
    ["endpoint-not-loopback", "endpoint-not-loopback"],
    ["identity-mismatch", "identity-mismatch"],
    ["health-mismatch", "health-mismatch"],
  ] as const)("classifies degraded preflight %s as fatal", (code, reason) => {
    expect(classifyDaemonStartFailure({ kind: "preflight", status: "degraded", code })).toEqual({
      severity: "fatal",
      reason,
    });
  });

  it("keeps non-structural degraded preflight codes transient", () => {
    expect(
      classifyDaemonStartFailure({
        kind: "preflight",
        status: "degraded",
        code: "resource-broker-failed",
      }),
    ).toEqual({ severity: "transient" });
  });

  it.each([
    "record-missing",
    "process-not-running",
    "identity-unreachable",
    "health-unreachable",
    "probe-failed",
    "probe-timeout",
  ] as const)("classifies unavailable preflight %s as transient", (code) => {
    expect(classifyDaemonStartFailure({ kind: "preflight", status: "unavailable", code })).toEqual({
      severity: "transient",
    });
  });

  it("classifies a failed spawn as fatal", () => {
    expect(classifyDaemonStartFailure({ kind: "spawn-failed" })).toEqual({
      severity: "fatal",
      reason: "spawn-failed",
    });
  });

  it("classifies the structural child exit code 2 as fatal", () => {
    expect(classifyDaemonStartFailure({ kind: "child-exit", exitCode: 2, signal: null })).toEqual({
      severity: "fatal",
      reason: "child-fatal-exit",
    });
  });

  it.each([
    { kind: "child-exit", exitCode: 1, signal: null },
    { kind: "child-exit", exitCode: null, signal: "SIGKILL" },
    { kind: "readiness-timeout" },
    { kind: "identity-changed" },
  ] as const satisfies readonly DaemonStartFailure[])(
    "keeps environmental failures transient (%o)",
    (failure) => {
      expect(classifyDaemonStartFailure(failure)).toEqual({ severity: "transient" });
    },
  );
});

describe("daemon restart backoff", () => {
  it("doubles from the initial delay and caps at the maximum", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 7].map((failures) =>
      daemonRestartDelayMs(failures, DEFAULT_DAEMON_RESTART_POLICY, midpoint),
    );
    expect(delays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000]);
  });

  it("keeps jitter within the configured ratio and inside the cap", () => {
    expect(daemonRestartDelayMs(0, DEFAULT_DAEMON_RESTART_POLICY, () => 0)).toBe(400);
    expect(daemonRestartDelayMs(0, DEFAULT_DAEMON_RESTART_POLICY, () => 1)).toBe(600);
    expect(daemonRestartDelayMs(50, DEFAULT_DAEMON_RESTART_POLICY, () => 1)).toBe(10_000);
    expect(daemonRestartDelayMs(-3, DEFAULT_DAEMON_RESTART_POLICY, () => 0)).toBe(400);
  });

  it("never returns a negative delay", () => {
    const policy = { ...DEFAULT_DAEMON_RESTART_POLICY, jitterRatio: 2 };
    expect(daemonRestartDelayMs(0, policy, () => 0)).toBeGreaterThanOrEqual(0);
  });
});

describe("supervisor halt reason", () => {
  it("names the typed reason, the ceiling, and the last failure", () => {
    const reason = supervisorHaltReason("record-invalid", 3, "daemon.json is not trustworthy");
    expect(reason).toContain("3 consecutive fatal startup failures");
    expect(reason).toContain("(record-invalid)");
    expect(reason).toContain("daemon.json is not trustworthy");
  });

  it("stays within the renderer-safe 240 character bound", () => {
    const reason = supervisorHaltReason("spawn-failed", 3, "x".repeat(1_000));
    expect(reason.length).toBeLessThanOrEqual(240);
    expect(reason.endsWith("…")).toBe(true);
  });

  it("omits the detail clause when the last failure carried no reason", () => {
    const reason = supervisorHaltReason("spawn-failed", 3, "  ");
    expect(reason).not.toContain("Last failure:");
  });
});
