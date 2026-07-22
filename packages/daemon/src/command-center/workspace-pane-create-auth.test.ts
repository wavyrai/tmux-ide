import { afterEach, describe, expect, it, vi } from "vitest";

import { setWorkspacePaneCreationBackend } from "./actions/handlers/workspace-pane-create.ts";
import { createApp } from "./server.ts";

const HOST_TOKEN = "host-capability-secret";

afterEach(() => setWorkspacePaneCreationBackend(null));

describe("workspace pane create host capability", () => {
  it("rejects a cross-origin loopback mutation without the host token", async () => {
    const create = vi.fn();
    setWorkspacePaneCreationBackend({ create });
    const app = createApp({
      remoteAccess: {
        bindHostname: "127.0.0.1",
        token: null,
        localBypassToken: HOST_TOKEN,
      },
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
    setWorkspacePaneCreationBackend({ create });
    const app = createApp({
      remoteAccess: {
        bindHostname: "127.0.0.1",
        token: null,
        localBypassToken: HOST_TOKEN,
      },
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
});
