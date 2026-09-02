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
        "X-Tmux-Ide-Host-Client-Id": "opentui:42",
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
        hostClientId: "opentui:42",
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

  it("keeps one operation id across a bounded delayed retry schedule", async () => {
    const request = mock()
      .mockRejectedValueOnce(new Error("first deadline"))
      .mockRejectedValueOnce(new Error("second deadline"))
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
    const waits: number[] = [];

    await expect(
      dispatchOwnerAction({
        baseUrl: "http://127.0.0.1:4000",
        ownerToken: "owner-token",
        name: "workspace.pane.kill",
        input: { workspaceName: "project", semanticPaneId: "pane.editor" },
        operationId,
        fetch: request as typeof fetch,
        maximumAttempts: 3,
        retryDelayMs: (completedAttempts) => completedAttempts * 25,
        wait: async (delayMs) => {
          waits.push(delayMs);
        },
      }),
    ).resolves.toMatchObject({ outcome: "applied", verb: "workspace.pane.kill" });

    expect(waits).toEqual([25, 50]);
    expect(request).toHaveBeenCalledTimes(3);
    for (const [, init] of request.mock.calls) {
      expect(init?.headers).toMatchObject({ "X-Tmux-Ide-Operation-Id": operationId });
    }
  });

  it("recovers a promotion whose first response outlives the client deadline", async () => {
    const operationIds: Array<string | undefined> = [];
    let attempt = 0;
    const request = mock((_url: string | URL | Request, init?: RequestInit) => {
      operationIds.push((init?.headers as Record<string, string>)?.["X-Tmux-Ide-Operation-Id"]);
      attempt += 1;
      if (attempt === 1)
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      return Promise.resolve(
        Response.json({
          ok: true,
          result: {
            operationId,
            daemonInstanceId,
            outcome: "replayed",
            resource: { resourceVersion: 1, workspaceName: "workspace.alpha" },
          },
        }),
      );
    });

    await expect(
      dispatchOwnerAction({
        baseUrl: "http://127.0.0.1:4000",
        ownerToken: "owner-token",
        name: "workspace.promote",
        input: { sessionId: "session.aaaaaaaaaaaaaaaaaaaa" },
        operationId,
        fetch: request as typeof fetch,
        timeoutMs: 5,
        maximumAttempts: 2,
        retryDelayMs: () => 1,
      }),
    ).resolves.toMatchObject({ operationId, outcome: "replayed" });
    expect(operationIds).toEqual([operationId, operationId]);
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
