import { describe, expect, it } from "vitest";

import {
  reasonIndicatesMissingTmux,
  recoveryForDaemonCapability,
  recoveryForWorkspaceOpenError,
  tmuxInstallCommand,
} from "./connection-recovery.ts";

describe("reasonIndicatesMissingTmux", () => {
  it("recognizes absence phrasings that name tmux", () => {
    expect(reasonIndicatesMissingTmux("spawn tmux ENOENT")).toBe(true);
    expect(reasonIndicatesMissingTmux("tmux: command not found")).toBe(true);
    expect(reasonIndicatesMissingTmux("tmux is not installed on this host")).toBe(true);
    expect(reasonIndicatesMissingTmux("The tmux binary could not be located")).toBe(true);
  });

  it("does not fire on a bare tmux mention or unrelated reasons", () => {
    expect(reasonIndicatesMissingTmux("Attached to the tmux session")).toBe(false);
    expect(reasonIndicatesMissingTmux("Canonical daemon health endpoint is unreachable.")).toBe(
      false,
    );
    expect(reasonIndicatesMissingTmux("a file is missing")).toBe(false);
  });
});

describe("tmuxInstallCommand", () => {
  it("is platform-appropriate", () => {
    expect(tmuxInstallCommand("darwin")).toBe("brew install tmux");
    expect(tmuxInstallCommand("linux")).toBe("sudo apt install tmux");
    expect(tmuxInstallCommand("win32")).toContain("Install tmux");
    expect(tmuxInstallCommand(undefined)).toContain("Install tmux");
  });
});

describe("recoveryForDaemonCapability", () => {
  it("elevates a missing-tmux reason to a distinct copyable-command screen", () => {
    const presentation = recoveryForDaemonCapability(
      { status: "unavailable", code: "probe-failed", reason: "spawn tmux ENOENT" },
      "darwin",
    );
    expect(presentation.title).toBe("tmux is not installed");
    expect(presentation.command).toBe("brew install tmux");
  });

  it("offers no shell command for a supervised, missing engine", () => {
    const presentation = recoveryForDaemonCapability({
      status: "unavailable",
      code: "process-not-running",
      reason: "Canonical daemon process is no longer running.",
    });
    expect(presentation.title).toContain("isn't running");
    expect(presentation.command).toBeNull();
  });

  it("frames a protocol mismatch as an update, not a shell fix", () => {
    const presentation = recoveryForDaemonCapability({
      status: "degraded",
      code: "protocol-incompatible",
      reason: "protocol 99 unsupported",
    });
    expect(presentation.title).toContain("different version");
    expect(presentation.command).toBeNull();
  });

  it("carries the raw reason through for unmapped codes", () => {
    const presentation = recoveryForDaemonCapability({
      status: "degraded",
      code: "health-mismatch",
      reason: "health metadata does not match",
    });
    expect(presentation.description).toBe("health metadata does not match");
  });
});

describe("recoveryForWorkspaceOpenError", () => {
  it("recognizes a missing tmux behind a rejected open", () => {
    const presentation = recoveryForWorkspaceOpenError(
      { code: "request-failed", reason: "could not start tmux: not installed" },
      "linux",
    );
    expect(presentation.title).toBe("tmux is not installed");
    expect(presentation.command).toBe("sudo apt install tmux");
  });

  it("keeps the daemon's own reason for an invalid folder", () => {
    const presentation = recoveryForWorkspaceOpenError({
      code: "invalid-request",
      reason: "project directory is not a directory",
    });
    expect(presentation.description).toBe("project directory is not a directory");
    expect(presentation.command).toBeNull();
  });
});
