import { describe, expect, it, mock } from "bun:test";

import { createWorkspacePaneAsOwner } from "./workspace-pane-client.ts";

const OPERATION = "10000000-0000-4000-8000-000000000001";
const INSTANCE = "20000000-0000-4000-8000-000000000002";

describe("workspace pane SDK client", () => {
  it("sends only validated semantic intent and parses the stable result", async () => {
    const request = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer owner-token",
        "X-Tmux-Ide-Operation-Id": OPERATION,
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        kind: "agent",
        workspaceName: "project",
        displayTitle: "Codex",
        harnessProfileId: "codex",
        role: "implementer",
      });
      return Response.json({
        ok: true,
        result: {
          operationId: OPERATION,
          daemonInstanceId: INSTANCE,
          outcome: "created",
          resource: {
            resourceVersion: 1,
            workspaceName: "project",
            semanticPaneId: "pane.stable",
            displayTitle: "Codex",
            kind: "agent",
            harnessProfileId: "codex",
            role: "implementer",
            missionId: null,
          },
        },
      });
    });

    await expect(
      createWorkspacePaneAsOwner({
        baseUrl: "http://127.0.0.1:6060",
        ownerToken: "owner-token",
        operationId: OPERATION,
        intent: {
          kind: "agent",
          workspaceName: "project",
          displayTitle: "Codex",
          harnessProfileId: "codex",
          role: "implementer",
        },
        fetch: request as typeof fetch,
      }),
    ).resolves.toMatchObject({
      outcome: "created",
      resource: { semanticPaneId: "pane.stable" },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects runtime authority fields before making a request", async () => {
    const request = mock();
    await expect(
      createWorkspacePaneAsOwner({
        baseUrl: "http://127.0.0.1:6060",
        ownerToken: "owner-token",
        operationId: OPERATION,
        intent: {
          kind: "terminal",
          workspaceName: "project",
          runtimePaneId: "%42",
        } as never,
        fetch: request as typeof fetch,
      }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
