import { describe, expect, it } from "vitest";
import {
  TERMINAL_ATTACHMENT_MAX_COLS,
  TERMINAL_ATTACHMENT_MAX_ROWS,
  TERMINAL_ATTACHMENT_MIN_COLS,
  TERMINAL_ATTACHMENT_MIN_ROWS,
  TERMINAL_ATTACHMENT_ISSUE_PATH,
  TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
  TERMINAL_ATTACHMENT_REDEEM_PATH,
  TERMINAL_ATTACHMENT_WEBSOCKET_SUBPROTOCOL,
  TerminalAttachRequestSchemaZ,
  TerminalAttachmentErrorSchemaZ,
  TerminalAttachmentIssueDescriptorSchemaZ,
  TerminalAttachmentIssueErrorSchemaZ,
  TerminalAttachmentIssueMutationRequestSchemaZ,
  TerminalAttachmentIssueResultSchemaZ,
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
  it("publishes one shared issue and redemption endpoint authority", () => {
    expect(TERMINAL_ATTACHMENT_ISSUE_PATH).toBe("/api/v1/terminal/attachments/issue");
    expect(TERMINAL_ATTACHMENT_REDEEM_PATH).toBe("/v1/terminal/attachments/redeem");
  });

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

  it("accepts one strict, bounded, loopback-only issue descriptor", () => {
    const descriptor = {
      protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
      webSocketUrl: "ws://127.0.0.1:6060/v1/terminal/attachments/redeem",
      subprotocol: TERMINAL_ATTACHMENT_WEBSOCKET_SUBPROTOCOL,
      redemptionTicket: `ta1_${"A".repeat(43)}`,
      daemonInstanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
      requestId: "10000000-0000-4000-8000-000000000001",
      expiresAt: 1_784_662_860_000,
      effectiveViewerMode: "interactive" as const,
    };
    expect(TerminalAttachmentIssueDescriptorSchemaZ.parse(descriptor)).toEqual(descriptor);
    expect(TerminalAttachmentIssueResultSchemaZ.parse({ status: "issued", descriptor })).toEqual({
      status: "issued",
      descriptor,
    });

    for (const webSocketUrl of [
      "wss://127.0.0.1:6060/v1/terminal/attachments/redeem",
      "ws://192.0.2.1:6060/v1/terminal/attachments/redeem",
      "ws://secret@127.0.0.1:6060/v1/terminal/attachments/redeem",
      "ws://127.0.0.1/v1/terminal/attachments/redeem",
      "ws://127.0.0.1:6060/v1/terminal/attachments/redeem?token=secret",
      "ws://127.0.0.1:6060/another-path",
    ]) {
      expect(
        TerminalAttachmentIssueDescriptorSchemaZ.safeParse({ ...descriptor, webSocketUrl }).success,
      ).toBe(false);
    }

    for (const forbidden of [
      { tmuxPaneId: "%7" },
      { sessionName: "raw-session" },
      { cwd: "/private/project" },
      { argv: ["codex", "--yolo"] },
      { env: { SECRET: "value" } },
      { ownerToken: "secret" },
    ]) {
      expect(
        TerminalAttachmentIssueDescriptorSchemaZ.safeParse({ ...descriptor, ...forbidden }).success,
      ).toBe(false);
    }
  });

  it("keeps host-authored issue metadata outside renderer intent", () => {
    const mutation = TerminalAttachmentIssueMutationRequestSchemaZ.parse({
      requestId: "10000000-0000-4000-8000-000000000001",
      expectedDaemonInstanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
      attachment: request(),
    });
    expect(mutation.attachment).not.toHaveProperty("requestId");
    expect(mutation.attachment).not.toHaveProperty("expectedDaemonInstanceId");
    expect(
      TerminalAttachmentIssueMutationRequestSchemaZ.safeParse({
        ...mutation,
        origin: "https://renderer.example",
      }).success,
    ).toBe(false);
  });

  it("rejects credential-bearing public error text", () => {
    expect(
      TerminalAttachmentIssueErrorSchemaZ.parse({
        code: "attachment-unavailable",
        reason: "The terminal attachment is unavailable.",
        retryable: true,
      }),
    ).toMatchObject({ code: "attachment-unavailable" });
    for (const reason of [
      "Authorization was Bearer owner-secret",
      `The redemptionTicket was ta1_${"A".repeat(43)}`,
      "ownerToken=secret",
    ]) {
      expect(
        TerminalAttachmentIssueErrorSchemaZ.safeParse({
          code: "request-failed",
          reason,
          retryable: false,
        }).success,
      ).toBe(false);
    }
  });
});
