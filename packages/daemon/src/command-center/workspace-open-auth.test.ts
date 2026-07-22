import { describe, expect, it, vi } from "vitest";

import { createApp } from "./server.ts";

const OWNER_TOKEN = "workspace-owner-secret";
const OPERATION_ID = "10000000-0000-4000-8000-000000000001";

function openResult(request: { operationId: string; expectedDaemonInstanceId: string }) {
  return {
    operationId: request.operationId,
    daemonInstanceId: request.expectedDaemonInstanceId,
    outcome: "created" as const,
    resource: {
      resourceVersion: 1 as const,
      workspaceName: "project-00112233445566778899aabbccddeeff",
      initialPaneId: "pane.workspace.00112233445566778899aabbccddeeff",
    },
  };
}

describe("workspace open host capability", () => {
  it("requires the private owner token even on loopback", async () => {
    const open = vi.fn(openResult);
    const app = createApp({
      remoteAccess: {
        bindHostname: "127.0.0.1",
        token: null,
        localBypassToken: OWNER_TOKEN,
        ownerToken: OWNER_TOKEN,
      },
      workspaceOpenBackend: { open },
    });

    const response = await app.request("http://localhost/api/v2/action/workspace.open", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://hostile.example",
        "X-Tmux-Ide-Operation-Id": OPERATION_ID,
      },
      body: JSON.stringify({ projectDir: "/tmp/project" }),
    });

    expect(response.status).toBe(401);
    expect(open).not.toHaveBeenCalled();
  });

  it("requires a stable operation id before invoking the authority", async () => {
    const open = vi.fn(openResult);
    const app = createApp({
      remoteAccess: { ownerToken: OWNER_TOKEN },
      workspaceOpenBackend: { open },
    });
    const response = await app.request("http://localhost/api/v2/action/workspace.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OWNER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ projectDir: "/tmp/project" }),
    });

    expect(response.status).toBe(400);
    expect(open).not.toHaveBeenCalled();
  });

  it("never accepts the remotely shared access token as owner authority", async () => {
    const open = vi.fn(openResult);
    const app = createApp({
      remoteAccess: {
        bindHostname: "0.0.0.0",
        token: "remote-shared-token",
        localBypassToken: OWNER_TOKEN,
        ownerToken: OWNER_TOKEN,
      },
      workspaceOpenBackend: { open },
    });
    const response = await app.request("http://localhost/api/v2/action/workspace.open", {
      method: "POST",
      headers: {
        Authorization: "Bearer remote-shared-token",
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": OPERATION_ID,
      },
      body: JSON.stringify({ projectDir: "/tmp/project" }),
    });

    expect(response.status).toBe(401);
    expect(open).not.toHaveBeenCalled();
  });

  it("passes owner-authenticated intent with trusted correlation and generation", async () => {
    const open = vi.fn(openResult);
    const app = createApp({
      remoteAccess: { ownerToken: OWNER_TOKEN },
      daemonIdentity: {
        productVersion: "test",
        instanceId: "20000000-0000-4000-8000-000000000002",
        startedAt: "2026-07-22T00:00:00.000Z",
      },
      workspaceOpenBackend: { open },
    });
    const response = await app.request("http://localhost/api/v2/action/workspace.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OWNER_TOKEN}`,
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": OPERATION_ID,
      },
      body: JSON.stringify({ projectDir: "/tmp/project" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, result: { outcome: "created" } });
    expect(open).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      expectedDaemonInstanceId: "20000000-0000-4000-8000-000000000002",
      intent: { projectDir: "/tmp/project" },
    });
  });
});
