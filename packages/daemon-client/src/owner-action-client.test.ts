import { describe, expect, it, mock } from "bun:test";

import { DaemonActionInvocationError, dispatchOwnerAction } from "./owner-action-client.ts";

const operationId = "10000000-0000-4000-8000-000000000001";
const daemonInstanceId = "20000000-0000-4000-8000-000000000002";
const mutation = {
  operationId,
  daemonInstanceId,
  outcome: "applied" as const,
  workspaceName: "project",
};

describe("owner action client", () => {
  it("sends the owner credential and stable operation id", async () => {
    const request = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({
        "Content-Type": "application/json",
        Authorization: "Bearer owner-token",
        "X-Tmux-Ide-Operation-Id": operationId,
      });
      return Response.json({
        ok: true,
        result: {
          ...mutation,
          verb: "workspace.window.split",
          direction: "right",
          semanticPaneId: "pane.created",
          displayTitle: "Terminal",
        },
      });
    });

    await expect(
      dispatchOwnerAction({
        baseUrl: "http://127.0.0.1:4000",
        ownerToken: "owner-token",
        name: "workspace.window.split",
        input: {
          workspaceName: "project",
          semanticPaneId: "pane.editor",
          direction: "right",
        },
        operationId,
        fetch: request as typeof fetch,
      }),
    ).resolves.toMatchObject({ outcome: "applied", verb: "workspace.window.split" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries one ambiguous response when the operation is idempotent", async () => {
    const request = mock()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          result: {
            ...mutation,
            verb: "workspace.pane.kill",
            windowClosed: false,
            remainingWindowCount: 1,
          },
        }),
      );

    await expect(
      dispatchOwnerAction({
        baseUrl: "http://127.0.0.1:4000",
        ownerToken: "owner-token",
        name: "workspace.pane.kill",
        input: { workspaceName: "project", semanticPaneId: "pane.editor" },
        operationId,
        fetch: request as typeof fetch,
      }),
    ).resolves.toMatchObject({ outcome: "applied", verb: "workspace.pane.kill" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("surfaces typed daemon refusals", async () => {
    const request = mock(async () =>
      Response.json({
        ok: false,
        error: { code: "bad_request", message: "Cannot close the last pane" },
      }),
    );

    const result = dispatchOwnerAction({
      baseUrl: "http://127.0.0.1:4000",
      ownerToken: "owner-token",
      name: "workspace.pane.kill",
      input: { workspaceName: "project", semanticPaneId: "pane.editor" },
      fetch: request as typeof fetch,
    });
    await expect(result).rejects.toBeInstanceOf(DaemonActionInvocationError);
    await expect(result).rejects.toThrow("Cannot close the last pane");
  });
});
