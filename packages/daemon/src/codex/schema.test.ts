import { describe, expect, it } from "bun:test";

import {
  ApplyPatchApprovalRequestZ,
  ApplyPatchApprovalResponseZ,
  ChatgptAuthTokensRefreshRequestZ,
  ChatgptAuthTokensRefreshResponseZ,
  CodexAgentEventZ,
} from "./schema.ts";

describe("Codex schema", () => {
  it("round-trips a sample agentMessage notification", () => {
    const event = {
      method: "item/agentMessage/delta",
      params: {
        delta: "Hello from Codex.",
        itemId: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
      },
    };

    expect(CodexAgentEventZ.parse(event)).toEqual(event);
  });

  it("round-trips a sample apply-patch approval request and response", () => {
    const request = {
      callId: "call-1",
      conversationId: "thread-1",
      fileChanges: {
        "/tmp/app.ts": {
          type: "update",
          unified_diff: "--- a/app.ts\n+++ b/app.ts\n@@\n-old\n+new\n",
        },
      },
      grantRoot: "/tmp",
      reason: "Need write access",
    };

    expect(ApplyPatchApprovalRequestZ.parse(request)).toEqual(request);
    expect(ApplyPatchApprovalResponseZ.parse({ decision: "approved" })).toEqual({
      decision: "approved",
    });
  });

  it("validates ChatGPT token refresh request and response shapes", () => {
    expect(
      ChatgptAuthTokensRefreshRequestZ.parse({
        previousAccountId: "acct-1",
        reason: "unauthorized",
      }),
    ).toEqual({ previousAccountId: "acct-1", reason: "unauthorized" });
    expect(
      ChatgptAuthTokensRefreshResponseZ.parse({
        accessToken: "token",
        chatgptAccountId: "acct-1",
        chatgptPlanType: null,
      }),
    ).toEqual({ accessToken: "token", chatgptAccountId: "acct-1", chatgptPlanType: null });
  });
});
