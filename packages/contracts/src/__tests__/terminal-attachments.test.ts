import { describe, expect, it } from "vitest";
import {
  TERMINAL_ATTACHMENT_MAX_COLS,
  TERMINAL_ATTACHMENT_MAX_ROWS,
  TERMINAL_ATTACHMENT_MIN_COLS,
  TERMINAL_ATTACHMENT_MIN_ROWS,
  TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
  TerminalAttachRequestSchemaZ,
  TerminalAttachmentErrorSchemaZ,
  TerminalAttachmentPlanResponseSchemaZ,
} from "../terminal-attachments.ts";

const target = {
  workspaceName: "workspace.alpha-2",
  semanticPaneId: "pane.codex_worker-3",
};

function request() {
  return {
    protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
    target,
    viewerMode: "interactive" as const,
    viewport: { cols: 120, rows: 40 },
  };
}

describe("terminal attachment contracts", () => {
  it("accepts alternate semantic ids and both viewer modes", () => {
    expect(TerminalAttachRequestSchemaZ.parse(request()).target).toEqual(target);
    expect(
      TerminalAttachRequestSchemaZ.safeParse({ ...request(), viewerMode: "read-only" }).success,
    ).toBe(true);
  });

  it("enforces fixed integer viewport limits", () => {
    for (const viewport of [
      { cols: TERMINAL_ATTACHMENT_MIN_COLS - 1, rows: 40 },
      { cols: TERMINAL_ATTACHMENT_MAX_COLS + 1, rows: 40 },
      { cols: 120, rows: TERMINAL_ATTACHMENT_MIN_ROWS - 1 },
      { cols: 120, rows: TERMINAL_ATTACHMENT_MAX_ROWS + 1 },
      { cols: 120.5, rows: 40 },
    ]) {
      expect(TerminalAttachRequestSchemaZ.safeParse({ ...request(), viewport }).success).toBe(
        false,
      );
    }
    expect(
      TerminalAttachRequestSchemaZ.safeParse({
        ...request(),
        viewport: { cols: TERMINAL_ATTACHMENT_MAX_COLS, rows: TERMINAL_ATTACHMENT_MAX_ROWS },
      }).success,
    ).toBe(true);
  });

  it("rejects renderer-supplied execution, runtime-target, and credential fields", () => {
    for (const forbidden of [
      { cmd: "sh -c whoami" },
      { command: "codex --yolo" },
      { cwd: "/tmp" },
      { paneId: "%7" },
      { tmuxTarget: "owner:@9" },
      { authToken: "secret" },
    ]) {
      expect(TerminalAttachRequestSchemaZ.safeParse({ ...request(), ...forbidden }).success).toBe(
        false,
      );
    }
    expect(
      TerminalAttachRequestSchemaZ.safeParse({
        ...request(),
        target: { ...target, paneId: "%7" },
      }).success,
    ).toBe(false);
  });

  it("rejects protocol drift and hostile values instead of treating them as targets", () => {
    expect(
      TerminalAttachRequestSchemaZ.safeParse({ ...request(), protocolVersion: 2 }).success,
    ).toBe(false);
    for (const hostile of ["%7", "owner:@1", "$(touch-pwned)", "pane;kill-server"] as const) {
      expect(
        TerminalAttachRequestSchemaZ.safeParse({
          ...request(),
          target: { ...target, workspaceName: hostile },
        }).success,
      ).toBe(false);
    }
  });

  it("keeps planning responses non-redeemable, strict, and renderer-safe", () => {
    const response = {
      ok: true as const,
      protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
      descriptor: {
        attachmentId: "2ddc3f17-723b-4e16-a3d2-ad751fb01b2e",
        target,
        viewerMode: "interactive" as const,
        viewport: { cols: 120, rows: 40 },
        status: "planned" as const,
      },
      handle: {
        requestId: "2a215cf2-547e-42a2-91c7-454df8e56121",
      },
    };
    expect(TerminalAttachmentPlanResponseSchemaZ.parse(response)).toEqual(response);
    for (const forbidden of [
      { authToken: "secret" },
      { tmuxTarget: "owner:@7" },
      { paneId: "%7" },
      { command: "tmux attach" },
      { cwd: "/repo" },
    ]) {
      expect(
        TerminalAttachmentPlanResponseSchemaZ.safeParse({
          ...response,
          descriptor: { ...response.descriptor, ...forbidden },
        }).success,
      ).toBe(false);
    }

    for (const forbidden of [
      { ticket: "redeem-me" },
      { ticketId: "2a215cf2-547e-42a2-91c7-454df8e56121" },
      { token: "secret" },
      { auth: "secret" },
      { authToken: "secret" },
    ]) {
      expect(
        TerminalAttachmentPlanResponseSchemaZ.safeParse({ ...response, ...forbidden }).success,
      ).toBe(false);
    }

    expect(
      TerminalAttachmentErrorSchemaZ.safeParse({
        code: "pane-not-attachable",
        message: "The pane belongs to a split window",
        target,
        reason: "not-single-pane-window",
        retryable: false,
      }).success,
    ).toBe(true);
    expect(
      TerminalAttachmentErrorSchemaZ.safeParse({
        code: "protocol-version-unsupported",
        message: "Upgrade required",
        receivedVersion: 2,
        supportedVersions: [TERMINAL_ATTACHMENT_PROTOCOL_VERSION],
        retryable: false,
      }).success,
    ).toBe(true);
  });
});
