import { describe, expect, it, vi } from "vitest";

import { createApp } from "./server.ts";

const HOST_TOKEN = "host-capability-secret";

describe("workspace pane create host capability", () => {
  it("rejects a cross-origin loopback mutation without the host token", async () => {
    const create = vi.fn();
    const app = createApp({
      remoteAccess: {
        bindHostname: "127.0.0.1",
        token: null,
        localBypassToken: HOST_TOKEN,
        ownerToken: HOST_TOKEN,
      },
      workspacePaneCreationBackend: { create },
    });

    const response = await app.request("http://localhost/api/v2/action/workspace.pane.create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://hostile.example",
      },
      body: JSON.stringify({ kind: "terminal", workspaceName: "workspace.alpha" }),
    });

    expect(response.status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it("admits the semantic mutation with the private host token", async () => {
    const create = vi.fn(async (request) => ({
      operationId: request.operationId,
      daemonInstanceId: request.expectedDaemonInstanceId,
      outcome: "created" as const,
      resource: {
        resourceVersion: 1 as const,
        workspaceName: request.intent.workspaceName,
        semanticPaneId: "pane.10000000000040008000000000000001",
        kind: "terminal" as const,
        displayTitle: "Terminal",
        harnessProfileId: null,
        role: null,
        missionId: null,
      },
    }));
    const app = createApp({
      remoteAccess: {
        bindHostname: "127.0.0.1",
        token: null,
        localBypassToken: HOST_TOKEN,
        ownerToken: HOST_TOKEN,
      },
      workspacePaneCreationBackend: { create },
    });

    const response = await app.request("http://localhost/api/v2/action/workspace.pane.create", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HOST_TOKEN}`,
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": "10000000-0000-4000-8000-000000000001",
      },
      body: JSON.stringify({ kind: "terminal", workspaceName: "workspace.alpha" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, result: { outcome: "created" } });
    expect(create).toHaveBeenCalledWith({
      operationId: "10000000-0000-4000-8000-000000000001",
      expectedDaemonInstanceId: expect.any(String),
      intent: { kind: "terminal", workspaceName: "workspace.alpha" },
    });
  });

  it("never accepts the remotely shared access token as the owner mutation capability", async () => {
    const create = vi.fn();
    const app = createApp({
      remoteAccess: {
        bindHostname: "0.0.0.0",
        token: "remotely-shared-token",
        localBypassToken: HOST_TOKEN,
        ownerToken: HOST_TOKEN,
      },
      workspacePaneCreationBackend: { create },
    });

    const response = await app.request("http://localhost/api/v2/action/workspace.pane.create", {
      method: "POST",
      headers: {
        Authorization: "Bearer remotely-shared-token",
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": "10000000-0000-4000-8000-000000000001",
      },
      body: JSON.stringify({ kind: "terminal", workspaceName: "workspace.alpha" }),
    });

    expect(response.status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps pane-creation authorities isolated per app instance", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const firstApp = createApp({
      remoteAccess: { ownerToken: HOST_TOKEN },
      workspacePaneCreationBackend: { create: first },
    });
    createApp({
      remoteAccess: { ownerToken: "another-owner" },
      workspacePaneCreationBackend: { create: second },
    });

    await firstApp.request("http://localhost/api/v2/action/workspace.pane.create", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HOST_TOKEN}`,
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": "10000000-0000-4000-8000-000000000001",
      },
      body: JSON.stringify({ kind: "terminal", workspaceName: "workspace.alpha" }),
    });

    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });
});
