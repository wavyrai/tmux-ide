import { describe, expect, it } from "vitest";

import {
  buildStartupReadinessLadder,
  projectDesktopStartupReadiness,
  type DaemonChildOutputTail,
} from "@tmux-ide/contracts";

import { startupReadinessDiagnostics } from "./connection-recovery.ts";

const OBSERVED_AT = "2026-08-04T12:00:00.000Z";

const childOutput: DaemonChildOutputTail = {
  stream: "stderr",
  lines: ["Error: listen EADDRINUSE 127.0.0.1:8787", "  at Server.setupListenHandle"],
  truncated: false,
  exitCode: 1,
  signal: null,
};

describe("startup readiness diagnostics", () => {
  it("names the stuck rung, its reason, and the engine's own last words", () => {
    const lines = startupReadinessDiagnostics(
      projectDesktopStartupReadiness({
        daemon: {
          status: "unavailable",
          code: "process-not-running",
          reason: "The canonical daemon is unavailable.",
          childOutput,
        },
        ladder: null,
        observedAt: OBSERVED_AT,
      }),
    );
    expect(lines[0]).toBe(
      "Startup stalled at: starting the engine — the engine process is not running.",
    );
    expect(lines).toContain("Engine output:");
    expect(lines).toContain("  Error: listen EADDRINUSE 127.0.0.1:8787");
    expect(lines).toContain("The engine exited with code 1.");
  });

  it("says which step is merely pending when nothing is stuck", () => {
    const lines = startupReadinessDiagnostics({
      ladder: buildStartupReadinessLadder(
        [{ status: "satisfied" }, { status: "satisfied" }, { status: "satisfied" }],
        OBSERVED_AT,
      ),
    });
    expect(lines).toEqual(["Startup is waiting on: reading the terminal catalog."]);
  });

  it("names a catalog fault in the terminal-resource vocabulary", () => {
    const lines = startupReadinessDiagnostics({
      ladder: buildStartupReadinessLadder(
        [
          { status: "satisfied" },
          { status: "satisfied" },
          { status: "satisfied" },
          {
            status: "stuck",
            reason: { vocabulary: "terminal-resource-unavailable", code: "missing-semantic-stamp" },
          },
        ],
        OBSERVED_AT,
      ),
    });
    expect(lines[0]).toBe(
      "Startup stalled at: reading the terminal catalog — a pane is missing its durable tmux-ide identity.",
    );
  });

  it("distinguishes an unreachable registered session from an empty fleet", () => {
    const unreachable = startupReadinessDiagnostics({
      ladder: buildStartupReadinessLadder(
        [
          { status: "satisfied" },
          { status: "satisfied" },
          { status: "satisfied" },
          {
            status: "stuck",
            reason: { vocabulary: "startup-readiness", code: "catalog-sessions-unreachable" },
          },
        ],
        OBSERVED_AT,
      ),
    });
    expect(unreachable[0]).toContain("the registered sessions are no longer running");

    // An empty fleet is satisfied: it must never read as a failure.
    const empty = startupReadinessDiagnostics({
      ladder: buildStartupReadinessLadder(
        [
          { status: "satisfied" },
          { status: "satisfied" },
          { status: "satisfied" },
          {
            status: "satisfied",
            population: { fleet: "empty", workspaceCount: 0, attachablePaneCount: 0 },
          },
          { status: "satisfied" },
        ],
        OBSERVED_AT,
      ),
    });
    expect(empty).toEqual(["Startup readiness: every step is satisfied."]);
  });

  it("prints an unrecognized reason code rather than swallowing it", () => {
    const lines = startupReadinessDiagnostics({
      ladder: buildStartupReadinessLadder(
        [
          {
            status: "stuck",
            reason: {
              vocabulary: "desktop-daemon-host-issue",
              code: "endpoint-not-loopback",
            },
          },
        ],
        OBSERVED_AT,
      ),
    });
    expect(lines[0]).toContain("endpoint-not-loopback");
  });

  it("marks a trimmed tail and reports a terminating signal", () => {
    const lines = startupReadinessDiagnostics({
      ladder: buildStartupReadinessLadder(
        [
          {
            status: "stuck",
            reason: { vocabulary: "desktop-daemon-host-issue", code: "probe-timeout" },
          },
        ],
        OBSERVED_AT,
      ),
      childOutput: {
        stream: "stderr",
        lines: Array.from({ length: 9 }, (_value, index) => `line ${index}`),
        truncated: true,
        exitCode: null,
        signal: "SIGKILL",
      },
    });
    expect(lines).toContain("Engine output (earlier lines trimmed):");
    // Only the last five captured lines are shown.
    expect(lines).toContain("  line 8");
    expect(lines).not.toContain("  line 3");
    expect(lines.at(-1)).toBe("The engine was stopped by SIGKILL.");
  });
});
