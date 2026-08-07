import { describe, expect, it, vi } from "vitest";

import { createApp } from "./server.ts";

const OWNER = "app-window-owner";
const OPERATION = "10000000-0000-4000-8000-000000000001";
const INSTANCE = "20000000-0000-4000-8000-000000000002";
const body = {
  workspaceName: "alpha",
  expectedDocumentRevision: 3,
  command: { type: "window.focus", windowId: null },
};

describe("AppWindow mutation host capability", () => {
  it("requires owner bearer and stable operation correlation", async () => {
    const mutate = vi.fn();
    const app = createApp({
      remoteAccess: { ownerToken: OWNER },
      appWindowMutationBackend: { mutate },
    });
    for (const headers of [
      { "Content-Type": "application/json", "X-Tmux-Ide-Operation-Id": OPERATION },
      { "Content-Type": "application/json", Authorization: `Bearer ${OWNER}` },
    ]) {
      const response = await app.request(
        "http://localhost/api/v2/action/workspace.app-window.mutate",
        { method: "POST", headers, body: JSON.stringify(body) },
      );
      expect(response.status).toBe(headers.Authorization ? 400 : 401);
    }
    expect(mutate).not.toHaveBeenCalled();
  });

  it("adds daemon generation and operation id outside renderer input", async () => {
    const mutate = vi.fn(async (request) => ({
      operationId: request.operationId,
      daemonInstanceId: request.expectedDaemonInstanceId,
      outcome: "unchanged" as const,
      workspaceName: request.intent.workspaceName,
      documentRevision: 3,
    }));
    const app = createApp({
      remoteAccess: { ownerToken: OWNER },
      daemonIdentity: {
        productVersion: "test",
        instanceId: INSTANCE,
        startedAt: "2026-07-22T00:00:00.000Z",
      },
      appWindowMutationBackend: { mutate },
    });
    const response = await app.request(
      "http://localhost/api/v2/action/workspace.app-window.mutate",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OWNER}`,
          "Content-Type": "application/json",
          "X-Tmux-Ide-Operation-Id": OPERATION,
        },
        body: JSON.stringify(body),
      },
    );
    expect(response.status).toBe(200);
    expect(mutate).toHaveBeenCalledWith({
      operationId: OPERATION,
      expectedDaemonInstanceId: INSTANCE,
      intent: body,
    });
  });
});
