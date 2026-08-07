import { describe, expect, it, vi } from "vitest";

import { createApp } from "./server.ts";

const HOST_TOKEN = "host-capability-secret";
const OPERATION_ID = "10000000-0000-4000-8000-000000000001";
const INPUT = {
  workspaceName: "workspace.alpha",
  sourceSemanticPaneId: "pane.source",
  targetSemanticPaneId: "pane.target",
} as const;

describe("workspace pane swap host capability", () => {
  it("rejects a swap without the private owner capability", async () => {
    const mutate = vi.fn();
    const app = createApp({
      remoteAccess: { ownerToken: HOST_TOKEN },
      workspaceMultiplexerBackend: { mutate },
    });

    const response = await app.request("http://localhost/api/v2/action/workspace.pane.swap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": OPERATION_ID,
      },
      body: JSON.stringify(INPUT),
    });

    expect(response.status).toBe(401);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("requires an operation id even from the owner", async () => {
    const mutate = vi.fn();
    const app = createApp({
      remoteAccess: { ownerToken: HOST_TOKEN },
      workspaceMultiplexerBackend: { mutate },
    });

    const response = await app.request("http://localhost/api/v2/action/workspace.pane.swap", {
      method: "POST",
      headers: { Authorization: `Bearer ${HOST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(INPUT),
    });

    expect(response.status).toBe(400);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("wraps semantic input with trusted generation metadata", async () => {
    const mutate = vi.fn(async (request) => ({
      operationId: request.operationId,
      daemonInstanceId: request.expectedDaemonInstanceId,
      outcome: "applied" as const,
      verb: "workspace.pane.swap" as const,
      workspaceName: request.intent.workspaceName,
      sourceSemanticPaneId: request.intent.sourceSemanticPaneId,
      targetSemanticPaneId: request.intent.targetSemanticPaneId,
    }));
    const app = createApp({
      remoteAccess: { ownerToken: HOST_TOKEN },
      workspaceMultiplexerBackend: { mutate },
    });

    const response = await app.request("http://localhost/api/v2/action/workspace.pane.swap", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HOST_TOKEN}`,
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": OPERATION_ID,
      },
      body: JSON.stringify(INPUT),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      result: { verb: "workspace.pane.swap", outcome: "applied", ...INPUT },
    });
    expect(mutate).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      expectedDaemonInstanceId: expect.any(String),
      intent: { verb: "workspace.pane.swap", ...INPUT },
    });
  });
});
