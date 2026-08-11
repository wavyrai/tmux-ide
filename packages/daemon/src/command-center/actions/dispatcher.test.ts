import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { WorkspaceMultiplexerMutationResultSchemaZ } from "@tmux-ide/contracts";
import { ActionContractsZ } from "./contract.ts";
import { createActionDispatcher, shouldBroadcastGenericActionComplete } from "./dispatcher.ts";
import { setDaemonShutdownBackend } from "./handlers/daemon-shutdown.ts";
import type { WorkspacePaneCreationBackend } from "./handlers/workspace-pane-create.ts";
import type { WorkspaceOpenBackend } from "./handlers/workspace-open.ts";
import type { WorkspacePromotionBackend } from "./handlers/workspace-promote.ts";

const actionApp = (
  broadcast = vi.fn(),
  workspacePaneCreationBackend?: WorkspacePaneCreationBackend,
  workspaceOpenBackend?: WorkspaceOpenBackend,
) => {
  const app = new Hono();
  const resourceBroadcast = vi.fn();
  app.post(
    "/api/v2/action/:name",
    createActionDispatcher({
      broadcast,
      broadcastResourceChanged: resourceBroadcast,
      daemonInstanceId: "20000000-0000-4000-8000-000000000002",
      workspacePaneCreationBackend,
      workspaceOpenBackend,
    }),
  );
  return { app, broadcast, resourceBroadcast };
};

afterEach(() => {
  setDaemonShutdownBackend(null);
});

describe("command-backed action dispatcher compatibility", () => {
  it("broadcasts a non-semantic action even when test data has a multiplexer result shape", () => {
    const multiplexerResult = {
      verb: "workspace.pane.select",
      outcome: "applied",
      operationId: "10000000-0000-4000-8000-000000000001",
      daemonInstanceId: "20000000-0000-4000-8000-000000000002",
      workspaceName: "workspace.alpha",
      semanticPaneId: "pane.target",
    };
    expect(WorkspaceMultiplexerMutationResultSchemaZ.safeParse(multiplexerResult).success).toBe(
      true,
    );
    expect(shouldBroadcastGenericActionComplete("daemon.shutdown", multiplexerResult, false)).toBe(
      true,
    );
  });

  it("forwards trusted host and pane credentials out-of-band to the runtime backend", async () => {
    const mutate = vi.fn(async (input) => ({
      verb: "workspace.pane.send" as const,
      outcome: "applied" as const,
      operationId: input.operationId,
      daemonInstanceId: input.expectedDaemonInstanceId,
      workspaceName: input.intent.workspaceName,
      sourceSemanticPaneId: "pane.source",
      semanticPaneId: "pane.target",
      origin: "cli" as const,
      characterCount: 5,
      byteCount: 5,
      submitted: true,
    }));
    const app = new Hono();
    app.post(
      "/api/v2/action/:name",
      createActionDispatcher({
        broadcast: vi.fn(),
        broadcastResourceChanged: vi.fn(),
        daemonInstanceId: "20000000-0000-4000-8000-000000000002",
        workspaceMultiplexerBackend: { mutate },
      }),
    );
    await app.request("http://localhost/api/v2/action/workspace.pane.send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": "10000000-0000-4000-8000-000000000001",
        "X-Tmux-Ide-Host-Client-Id": "trusted-host",
        "X-Tmux-Ide-Pane-Source-Credential": "trusted-pane-credential",
      },
      body: JSON.stringify({
        workspaceName: "workspace.alpha",
        semanticPaneId: "pane.target",
        sourceSemanticPaneId: "pane.source",
        text: "hello",
        submit: true,
        origin: "cli",
      }),
    });
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ intent: expect.objectContaining({ text: "hello" }) }),
      "trusted-host",
      "trusted-pane-credential",
      false,
    );
  });

  it("delegates pane send and its receipt lifecycle to the runtime backend", async () => {
    const mutate = vi.fn(async (input) => ({
      verb: "workspace.pane.send" as const,
      outcome: "applied" as const,
      operationId: input.operationId,
      daemonInstanceId: input.expectedDaemonInstanceId,
      workspaceName: input.intent.workspaceName,
      sourceSemanticPaneId: "pane.orchestrator",
      semanticPaneId: "pane.editor",
      origin: "sdk" as const,
      characterCount: 14,
      byteCount: 14,
      submitted: true,
    }));
    const app = new Hono();
    const broadcast = vi.fn();
    app.post(
      "/api/v2/action/:name",
      createActionDispatcher({
        broadcast,
        broadcastResourceChanged: vi.fn(),
        daemonInstanceId: "20000000-0000-4000-8000-000000000002",
        workspaceMultiplexerBackend: { mutate },
      }),
    );
    const response = await app.request("http://localhost/api/v2/action/workspace.pane.send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": "10000000-0000-4000-8000-000000000001",
      },
      body: JSON.stringify({
        workspaceName: "workspace.alpha",
        sourceSemanticPaneId: "pane.orchestrator",
        semanticPaneId: "pane.editor",
        text: "private prompt",
        submit: true,
        origin: "sdk",
      }),
    });

    expect(response.status).toBe(200);
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ intent: expect.objectContaining({ text: "private prompt" }) }),
      undefined,
      undefined,
      false,
    );
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("publishes killed-session catalog changes on the global interest key", async () => {
    const mutate = vi.fn(async (input) => ({
      verb: "workspace.session.kill" as const,
      outcome: "applied" as const,
      operationId: input.operationId,
      daemonInstanceId: input.expectedDaemonInstanceId,
      workspaceName: input.intent.workspaceName,
    }));
    const resourceBroadcast = vi.fn();
    const app = new Hono();
    app.post(
      "/api/v2/action/:name",
      createActionDispatcher({
        broadcast: vi.fn(),
        broadcastResourceChanged: resourceBroadcast,
        daemonInstanceId: "20000000-0000-4000-8000-000000000002",
        workspaceMultiplexerBackend: { mutate },
      }),
    );
    const response = await app.request("http://localhost/api/v2/action/workspace.session.kill", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": "10000000-0000-4000-8000-000000000001",
      },
      body: JSON.stringify({ workspaceName: "workspace.alpha" }),
    });
    expect(response.status).toBe(200);
    expect(resourceBroadcast).toHaveBeenCalledWith(
      {
        workspaceName: null,
        resource: "workspace-catalog",
        causeOperationId: "10000000-0000-4000-8000-000000000001",
      },
      "20000000-0000-4000-8000-000000000002",
    );
  });
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

  it("emits a scoped versioned invalidation for an applied app-window mutation", async () => {
    const resourceBroadcast = vi.fn();
    const app = new Hono();
    app.post(
      "/api/v2/action/:name",
      createActionDispatcher({
        broadcast: vi.fn(),
        broadcastResourceChanged: resourceBroadcast,
        daemonInstanceId: "20000000-0000-4000-8000-000000000002",
        appWindowMutationBackend: {
          mutate: async (input) => ({
            operationId: input.operationId,
            daemonInstanceId: input.expectedDaemonInstanceId,
            outcome: "applied",
            workspaceName: input.intent.workspaceName,
            documentRevision: 9,
          }),
        },
      }),
    );
    const response = await app.request(
      "http://localhost/api/v2/action/workspace.app-window.mutate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tmux-Ide-Operation-Id": "10000000-0000-4000-8000-000000000001",
        },
        body: JSON.stringify({
          workspaceName: "workspace.alpha",
          expectedDocumentRevision: 8,
          command: { type: "window.focus", windowId: null },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(resourceBroadcast).toHaveBeenCalledWith(
      {
        workspaceName: "workspace.alpha",
        resource: "application-shell",
        revision: 9,
        causeOperationId: "10000000-0000-4000-8000-000000000001",
      },
      "20000000-0000-4000-8000-000000000002",
    );
    expect(resourceBroadcast).toHaveBeenCalledWith(
      {
        workspaceName: "workspace.alpha",
        resource: "workspace-missions",
        causeOperationId: "10000000-0000-4000-8000-000000000001",
      },
      "20000000-0000-4000-8000-000000000002",
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

  it("adapts owner-selected project intent and broadcasts only the semantic workspace resource", async () => {
    const open = vi.fn(async (input) => ({
      operationId: input.operationId,
      daemonInstanceId: input.expectedDaemonInstanceId,
      outcome: "created" as const,
      resource: {
        resourceVersion: 1 as const,
        workspaceName: "project-00112233445566778899aabbccddeeff",
        initialPaneId: "pane.workspace.00112233445566778899aabbccddeeff",
      },
    }));
    const { app, broadcast, resourceBroadcast } = actionApp(vi.fn(), undefined, { open });
    const response = await app.request("http://localhost/api/v2/action/workspace.open", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": "10000000-0000-4000-8000-000000000001",
      },
      body: JSON.stringify({ projectDir: "/tmp/project" }),
    });

    expect(response.status).toBe(200);
    const envelope = await response.json();
    expect(envelope).toMatchObject({
      ok: true,
      result: {
        operationId: "10000000-0000-4000-8000-000000000001",
        outcome: "created",
        resource: { workspaceName: "project-00112233445566778899aabbccddeeff" },
      },
    });
    expect(JSON.stringify(envelope)).not.toMatch(/projectDir|sessionName|paneId|tmux/u);
    expect(open).toHaveBeenCalledWith({
      operationId: "10000000-0000-4000-8000-000000000001",
      expectedDaemonInstanceId: "20000000-0000-4000-8000-000000000002",
      intent: { projectDir: "/tmp/project" },
    });
    expect(broadcast).toHaveBeenCalledWith(
      "workspace.open",
      expect.objectContaining({ operationId: "10000000-0000-4000-8000-000000000001" }),
    );
    expect(resourceBroadcast).toHaveBeenCalledWith(
      {
        workspaceName: null,
        resource: "workspace-catalog",
        causeOperationId: "10000000-0000-4000-8000-000000000001",
      },
      "20000000-0000-4000-8000-000000000002",
    );
  });

  it("rejects renderer-authored tmux identities before workspace admission", async () => {
    const open = vi.fn();
    const { app } = actionApp(vi.fn(), undefined, { open });
    const response = await app.request("http://localhost/api/v2/action/workspace.open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectDir: "/tmp/project",
        sessionName: "renderer-owned",
        paneId: "%42",
      }),
    });
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
    expect(open).not.toHaveBeenCalled();
  });
});

describe("workspace.promote completion receipt", () => {
  const promoteApp = (
    promote: WorkspacePromotionBackend["promote"],
    receipts: Array<{ workspaceName: string; outcome: string }>,
  ) => {
    const broadcast = vi.fn();
    const resourceBroadcast = vi.fn();
    const app = new Hono();
    app.post(
      "/api/v2/action/:name",
      createActionDispatcher({
        broadcast,
        broadcastResourceChanged: resourceBroadcast,
        broadcastPromotionCompleted: (workspaceName, outcome) =>
          receipts.push({ workspaceName, outcome }),
        daemonInstanceId: "20000000-0000-4000-8000-000000000002",
        workspacePromotionBackend: { promote },
      }),
    );
    return { app, broadcast, resourceBroadcast };
  };
  const dispatchPromote = (app: Hono) =>
    app.request("http://localhost/api/v2/action/workspace.promote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": "10000000-0000-4000-8000-000000000001",
      },
      body: JSON.stringify({ sessionId: `session.${"a".repeat(32)}` }),
    });

  it("broadcasts one typed receipt alongside action.complete on success", async () => {
    const receipts: Array<{ workspaceName: string; outcome: string }> = [];
    const { app, broadcast } = promoteApp(
      async (input) => ({
        operationId: input.operationId,
        daemonInstanceId: input.expectedDaemonInstanceId,
        outcome: "replayed" as const,
        resource: { resourceVersion: 1 as const, workspaceName: "fleet-alpha" },
      }),
      receipts,
    );
    const response = await dispatchPromote(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, result: { outcome: "replayed" } });
    expect(receipts).toEqual([{ workspaceName: "fleet-alpha", outcome: "replayed" }]);
    expect(broadcast).toHaveBeenCalledWith(
      "workspace.promote",
      expect.objectContaining({ outcome: "replayed" }),
    );
  });

  it("publishes promoted workspace-catalog changes on the global interest key", async () => {
    const receipts: Array<{ workspaceName: string; outcome: string }> = [];
    const { app, resourceBroadcast } = promoteApp(
      async (input) => ({
        operationId: input.operationId,
        daemonInstanceId: input.expectedDaemonInstanceId,
        outcome: "promoted" as const,
        resource: { resourceVersion: 1 as const, workspaceName: "fleet-alpha" },
      }),
      receipts,
    );
    const response = await dispatchPromote(app);
    expect(response.status).toBe(200);
    expect(resourceBroadcast).toHaveBeenCalledWith(
      {
        workspaceName: null,
        resource: "workspace-catalog",
        causeOperationId: "10000000-0000-4000-8000-000000000001",
      },
      "20000000-0000-4000-8000-000000000002",
    );
  });

  it("emits no receipt when the promotion fails", async () => {
    const receipts: Array<{ workspaceName: string; outcome: string }> = [];
    const { app } = promoteApp(async () => {
      throw new Error("tmux went away");
    }, receipts);
    const response = await dispatchPromote(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(receipts).toEqual([]);
  });
});
