import { describe, expect, it } from "vitest";

import {
  reasonIndicatesMissingTmux,
  terminalIssueFaultLabel,
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

  it("presents a halted supervisor as final and carries its typed reason", () => {
    const presentation = recoveryForDaemonCapability({
      status: "degraded",
      code: "supervisor-halted",
      reason:
        "The bundled engine stopped after 3 consecutive fatal startup failures (record-invalid).",
    });
    expect(presentation.title).toContain("stopped after repeated failures");
    expect(presentation.description).toContain("record-invalid");
    // A recheck cannot recover a halted supervisor, so the guidance must not
    // suggest one — reopening the app is the honest next step.
    expect(presentation.guidance).toContain("Reopen tmux-ide");
    expect(presentation.guidance).not.toContain("Recheck");
    expect(presentation.command).toBeNull();
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

describe("terminalIssueFaultLabel", () => {
  it("labels the codes a lease issue can fail with, on either lease family", () => {
    expect(terminalIssueFaultLabel("interactive-viewer-conflict")).toBe(
      "another viewer already holds that pane",
    );
    expect(terminalIssueFaultLabel("daemon-degraded")).toBe(
      "the engine was degraded when the attachment was requested",
    );
    expect(terminalIssueFaultLabel("response-too-large")).toBe(
      "the engine's answer was too large to trust",
    );
  });

  it("returns null for a code it does not own, so the caller keeps the raw reason", () => {
    // A pane-stream FRAME code — a different vocabulary that was never merged.
    expect(terminalIssueFaultLabel("stream-closed")).toBeNull();
    expect(terminalIssueFaultLabel("event-unavailable")).toBeNull();
  });
});
