import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ActionContractsZ } from "./contract.ts";
import { createActionDispatcher } from "./dispatcher.ts";
import { setDaemonShutdownBackend } from "./handlers/daemon-shutdown.ts";
import type { WorkspacePaneCreationBackend } from "./handlers/workspace-pane-create.ts";

const actionApp = (
  broadcast = vi.fn(),
  workspacePaneCreationBackend?: WorkspacePaneCreationBackend,
) => {
  const app = new Hono();
  app.post(
    "/api/v2/action/:name",
    createActionDispatcher({
      broadcast,
      daemonInstanceId: "20000000-0000-4000-8000-000000000002",
      workspacePaneCreationBackend,
    }),
  );
  return { app, broadcast };
};

afterEach(() => {
  setDaemonShutdownBackend(null);
});

describe("command-backed action dispatcher compatibility", () => {
  it("keeps unknown action transport behavior unchanged", async () => {
    const { app } = actionApp();
    const response = await app.request("http://localhost/api/v2/action/no.suchAction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "validation_failed",
        message: "Unknown action: no.suchAction",
        details: { name: "no.suchAction" },
      },
    });
  });

  it("keeps malformed JSON a 400 transport failure", async () => {
    const { app } = actionApp();
    const response = await app.request("http://localhost/api/v2/action/project.launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
  });

  it("keeps schema failures in the existing HTTP-200 action envelope", async () => {
    const { app } = actionApp();
    const response = await app.request("http://localhost/api/v2/action/project.launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: {
        code: "validation_failed",
        message: "Input failed schema validation",
        details: { issues: expect.any(Array) },
      },
    });
  });

  it.each([
    ["null", null],
    ["array", []],
    ["scalar", 7],
  ])("keeps exact action-schema validation details for %s bodies", async (_kind, body) => {
    const direct = ActionContractsZ["project.launch"].input.safeParse(body);
    expect(direct.success).toBe(false);
    if (direct.success) throw new Error("test body unexpectedly passed the action schema");

    const { app } = actionApp();
    const response = await app.request("http://localhost/api/v2/action/project.launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "validation_failed",
        message: "Input failed schema validation",
        details: { issues: direct.error.issues },
      },
    });
  });

  it("keeps success results and action.complete broadcast payloads unchanged", async () => {
    setDaemonShutdownBackend(() => undefined);
    const { app, broadcast } = actionApp();
    const response = await app.request("http://localhost/api/v2/action/daemon.shutdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "compatibility test" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: { stopping: true } });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith("daemon.shutdown", { stopping: true });
  });

  it("adapts semantic pane intent inside the trusted host and broadcasts its stable resource", async () => {
    const create = vi.fn(async (input) => ({
      operationId: input.operationId,
      daemonInstanceId: input.expectedDaemonInstanceId,
      outcome: "created" as const,
      resource: {
        resourceVersion: 1 as const,
        workspaceName: input.intent.workspaceName,
        semanticPaneId: "pane.10000000000040008000000000000001",
        kind: "terminal" as const,
        displayTitle: "Terminal",
        harnessProfileId: null,
        role: null,
        missionId: null,
      },
    }));
    const { app, broadcast } = actionApp(vi.fn(), { create });
    const body = { kind: "terminal", workspaceName: "workspace.alpha" } as const;
    const response = await app.request("http://localhost/api/v2/action/workspace.pane.create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": "10000000-0000-4000-8000-000000000001",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      result: {
        operationId: "10000000-0000-4000-8000-000000000001",
        outcome: "created",
        resource: { workspaceName: "workspace.alpha", kind: "terminal" },
      },
    });
    expect(create).toHaveBeenCalledWith({
      operationId: "10000000-0000-4000-8000-000000000001",
      expectedDaemonInstanceId: "20000000-0000-4000-8000-000000000002",
      intent: body,
    });
    expect(broadcast).toHaveBeenCalledWith(
      "workspace.pane.create",
      expect.objectContaining({ operationId: "10000000-0000-4000-8000-000000000001" }),
    );
  });

  it("rejects renderer-authored runtime fields before pane creation", async () => {
    const create = vi.fn();
    const { app } = actionApp(vi.fn(), { create });
    const response = await app.request("http://localhost/api/v2/action/workspace.pane.create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "agent",
        workspaceName: "workspace.alpha",
        harnessProfileId: "codex",
        role: "implementer",
        argv: ["codex", "--yolo"],
        env: { SECRET: "renderer-owned" },
        paneId: "%42",
      }),
    });
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
    expect(create).not.toHaveBeenCalled();
  });
});
