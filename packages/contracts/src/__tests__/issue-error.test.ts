import { describe, expect, it } from "vitest";

import {
  LEGACY_TERMINAL_ISSUE_ERROR_CODES,
  PaneStreamIssueErrorSchemaZ,
  PaneStreamIssueResultSchemaZ,
  TERMINAL_ISSUE_ERROR_CODES,
  TerminalAttachmentIssueErrorCodeSchemaZ,
  TerminalAttachmentIssueErrorSchemaZ,
  TerminalIssueErrorCodeSchemaZ,
  TerminalIssueErrorSchemaZ,
} from "../index.ts";

describe("the shared issue-error vocabulary", () => {
  it("is one enum wearing two names", () => {
    expect(TerminalAttachmentIssueErrorCodeSchemaZ).toBe(TerminalIssueErrorCodeSchemaZ);
    expect(TerminalAttachmentIssueErrorSchemaZ).toBe(TerminalIssueErrorSchemaZ);
    for (const code of TERMINAL_ISSUE_ERROR_CODES) {
      expect(TerminalIssueErrorCodeSchemaZ.parse(code)).toBe(code);
    }
  });

  it("gives the pane-stream path the members it used to lack", () => {
    for (const code of [
      "daemon-degraded",
      "request-timeout",
      "response-too-large",
      "invalid-response",
      "pane-not-attachable",
      "preview-only",
    ]) {
      expect(
        PaneStreamIssueErrorSchemaZ.parse({
          code,
          reason: "A pane stream could not be issued.",
          retryable: false,
        }).code,
      ).toBe(code);
    }
  });

  it("accepts a pre-merge daemon's legacy pane-stream literal and normalizes it", () => {
    expect(LEGACY_TERMINAL_ISSUE_ERROR_CODES["stream-unavailable"]).toBe("attachment-unavailable");
    expect(
      PaneStreamIssueResultSchemaZ.parse({
        status: "error",
        error: {
          code: "stream-unavailable",
          reason: "Pane streaming is unavailable.",
          retryable: true,
        },
      }),
    ).toMatchObject({ error: { code: "attachment-unavailable" } });
    // The attachment path never spoke the legacy literal, so it never accepts it.
    expect(
      TerminalAttachmentIssueErrorSchemaZ.safeParse({
        code: "stream-unavailable",
        reason: "Pane streaming is unavailable.",
        retryable: true,
      }).success,
    ).toBe(false);
  });

  it("keeps one credential-redaction discipline for both lease families", () => {
    for (const reason of [
      "Authorization was Bearer owner-secret",
      `The redemptionTicket was ta1_${"A".repeat(43)}`,
      `The redemptionTicket was ps1_${"A".repeat(43)}`,
      "ownerToken=secret",
    ]) {
      for (const schema of [TerminalAttachmentIssueErrorSchemaZ, PaneStreamIssueErrorSchemaZ]) {
        expect(schema.safeParse({ code: "request-failed", reason, retryable: false }).success).toBe(
          false,
        );
      }
    }
  });
});
