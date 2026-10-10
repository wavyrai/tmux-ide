import { WindowSplitLayoutUnavailable } from "../terminal/mirror/window-split-authority.ts";
import * as shellProjection from "./resources/application-shell.ts";
import { PANE_STREAM_PROTOCOL_VERSION, tmuxServerPaneStreamPath } from "@tmux-ide/contracts";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { TmuxServerOwners } from "../lib/tmux-server-owners.ts";
import type { NativeTmuxServerOwner } from "../lib/tmux-server-owner.ts";
import { mountTmuxServerRoutes } from "./tmux-servers.ts";

const base = "/api/v1/tmux-servers";
const token = "private-owner-token";
async function fixture() {
  const ownersCreated: {
    splitRead: ReturnType<typeof vi.fn>;
    catalog: ReturnType<typeof vi.fn>;
    discover: ReturnType<typeof vi.fn>;
    discoverShell: ReturnType<typeof vi.fn>;
    mutate: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    issue: ReturnType<typeof vi.fn>;
  }[] = [];
  const manager = new TmuxServerOwners<NativeTmuxServerOwner>({
    probe: async (selector) => ({
      fingerprint: JSON.stringify(selector),
      authority: { executablePath: "/private/tmux", socketSelector: selector },
      valid: () => true,
    }),
    create: async (_registration, scope) => {
      const catalog = vi.fn(async () => [
        { sessionName: "same", liveSessionId: `live-session.${"a".repeat(20)}`, paneCount: 1 },
      ]);
      const mutate = vi.fn(async (request) => ({
        operationId: request.operationId,
        daemonInstanceId: scope.generation,
        workspaceName: "same",
        verb: "workspace.pane.select",
        outcome: "applied",
        semanticPaneId: "pane.same",
      }));
      const dispose = vi.fn(async () => {});
      const issue = vi.fn(async (request, context) => ({
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        webSocketUrl: `ws://127.0.0.1:4000${tmuxServerPaneStreamPath(scope)}`,
        redemptionTicket: `ps2_${"a".repeat(43)}`,
        daemonInstanceId: scope.generation,
        requestId: context.requestId,
        expiresAt: Date.now() + 15000,
        panes: request.panes,
        effectiveViewerMode: request.viewerMode,
      }));
      const splitRead = vi.fn(async (_workspace, window) => ({
        version: 1,
        window,
        layoutId: randomUUID(),
        cols: 80,
        rows: 24,
        panes: [{ semanticPaneId: "pane.same", left: 0, top: 0, width: 80, height: 24 }],
        splits: [],
      }));
      const discover = vi.fn(async () => null);
      const discoverShell = vi.fn(async () => null);
      ownersCreated.push({ splitRead, catalog, mutate, dispose, issue, discover, discoverShell });
      return {
        readWindowSplitLayout: splitRead,
        catalog,
        terminalInventoryRuntime: {
          discoverTerminalRuntimeSession: discover,
          discoverApplicationShellSession: discoverShell,
        },
        multiplexerBackend: { mutate },
        dispose,
        workspaceRegistry: {
          list: () => [{ name: "workspace.alias", sessionName: "same" }],
          get: () => ({ name: "same", sessionName: "same", projectDir: "/private/project" }),
        },
        paneStreamRuntime: { coordinator: { issue } },
      } as unknown as NativeTmuxServerOwner;
    },
  });
  const app = new Hono();
  mountTmuxServerRoutes(app, { owners: manager, ownerToken: token });
  const request = (path: string, method = "GET", body?: unknown, auth: string | null = token) =>
    app.request(base + path, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        "Content-Type": "application/json",
      },
      ...(body !== undefined
        ? { body: typeof body === "string" ? body : JSON.stringify(body) }
        : {}),
    });
  const a = await manager.register({ label: "A", selector: { kind: "name", name: "a" } });
  const b = await manager.register({ label: "B", selector: { kind: "name", name: "b" } });
  const scope = (server: typeof a) => `/${server.serverId}/${server.generation}`;
  const mutation = (generation: string) => ({
    operationId: randomUUID(),
    expectedDaemonInstanceId: generation,
    intent: { verb: "workspace.pane.select", workspaceName: "same", semanticPaneId: "pane.same" },
  });
  return { app, manager, request, a, b, scope, mutation, ownersCreated };
}
describe("owner-only scoped tmux server routes", () => {
  it("requires owner bearer before registering or removing, even with no ordinary auth middleware", async () => {
    const f = await fixture();
    for (const auth of [null, "wrong"]) {
      expect(
        (await f.request("", "POST", { label: "C", selector: { kind: "name", name: "c" } }, auth))
          .status,
      ).toBe(401);
      expect((await f.request(`/${f.a.serverId}`, "DELETE", undefined, auth)).status).toBe(401);
      expect(
        (await f.request(f.scope(f.a) + "/mutations", "POST", f.mutation(f.a.generation!), auth))
          .status,
      ).toBe(401);
    }
    expect(f.manager.list()).toHaveLength(2);
    expect(f.ownersCreated.every((owner) => owner.mutate.mock.calls.length === 0)).toBe(true);
  });
  it("returns no socket selectors or native paths in the catalog", async () => {
    const f = await fixture();
    const response = await f.request("");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toMatch(/selector|private\/tmux|fingerprint/);
    expect(JSON.parse(text).servers).toHaveLength(2);
  });
  it("returns an authoritative workspace alias with the live session", async () => {
    const f = await fixture();
    const response = await f.request(f.scope(f.a) + "/sessions");
    expect(await response.json()).toMatchObject({
      sessions: [{ sessionName: "same", workspaceName: "workspace.alias" }],
    });
  });
  it("routes duplicate workspace names to independent owner backends", async () => {
    const f = await fixture();
    for (const server of [f.a, f.b])
      expect(
        (await f.request(f.scope(server) + "/mutations", "POST", f.mutation(server.generation!)))
          .status,
      ).toBe(200);
    for (const owner of f.ownersCreated) {
      expect(owner.mutate).toHaveBeenCalledTimes(1);
      expect(owner.mutate.mock.calls[0]?.slice(1)).toEqual([undefined, undefined, true]);
    }
  });
  it("rejects stale scope and mismatched request generation before invoking a backend", async () => {
    const f = await fixture();
    expect(
      (
        await f.request(
          `/${f.a.serverId}/${randomUUID()}/mutations`,
          "POST",
          f.mutation(f.a.generation!),
        )
      ).status,
    ).toBe(409);
    expect(
      (await f.request(f.scope(f.a) + "/mutations", "POST", f.mutation(f.b.generation!))).status,
    ).toBe(409);
    expect(f.ownersCreated[0]!.mutate).not.toHaveBeenCalled();
  });
  it("rejects malformed, oversized and arbitrary-command request bodies", async () => {
    const f = await fixture();
    for (const body of [
      "{",
      "x".repeat(65537),
      { ...f.mutation(f.a.generation!), command: "kill-server" },
    ])
      expect((await f.request(f.scope(f.a) + "/mutations", "POST", body)).status).toBe(400);
    expect(
      (
        await f.request("", "POST", {
          label: "C",
          selector: { kind: "name", name: "c" },
          serverId: f.a.serverId,
        })
      ).status,
    ).toBe(400);
    expect(f.ownersCreated[0]!.mutate).not.toHaveBeenCalled();
  });
  it("removes only its application owner", async () => {
    const f = await fixture();
    expect((await f.request(`/${f.a.serverId}`, "DELETE")).status).toBe(200);
    expect(f.ownersCreated[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(f.ownersCreated[1]!.dispose).not.toHaveBeenCalled();
    expect((await f.request(f.scope(f.a) + "/sessions")).status).toBe(404);
  });
  it("fences a late successful backend reply after owner removal", async () => {
    const f = await fixture();
    let finish!: () => void;
    f.ownersCreated[0]!.catalog.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve([]);
        }),
    );
    const reply = f.request(f.scope(f.a) + "/sessions");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await f.manager.remove(f.a.serverId);
    finish();
    expect((await reply).status).toBe(404);
  });
  it("delegates scoped stream admission with exact host and renderer metadata", async () => {
    const f = await fixture();
    const requestId = randomUUID();
    const response = await f.app.request(base + f.scope(f.a) + "/pane-streams/issue", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Origin: "tmux-ide://opentui",
        "X-Tmux-Ide-Request-Id": requestId,
        "X-Tmux-Ide-Expected-Daemon-Instance-Id": f.a.generation!,
        "X-Tmux-Ide-Host-Client-Id": "host.a",
      },
      body: JSON.stringify({
        requestId,
        expectedDaemonInstanceId: f.a.generation,
        stream: {
          protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
          workspaceName: "same",
          panes: ["pane.same"],
          viewerMode: "read-only",
        },
      }),
    });
    expect(await response.json()).toMatchObject({
      status: "issued",
      descriptor: { daemonInstanceId: f.a.generation },
    });
    expect(f.ownersCreated[0]!.issue).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      requestId,
      projectIdentity: "same",
      sessionName: "same",
      rendererOrigin: "tmux-ide://opentui",
      hostClientId: "host.a",
    });
    expect(f.ownersCreated[1]!.issue).not.toHaveBeenCalled();
  });
  it("does not open stale inventory or stream admission", async () => {
    const f = await fixture();
    const stale = `/${f.a.serverId}/${randomUUID()}`;
    expect((await f.request(stale + "/inventory/same")).status).toBe(409);
    expect((await f.request(stale + "/pane-streams/issue", "POST", {})).status).toBe(409);
    expect(f.ownersCreated[0]!.catalog).not.toHaveBeenCalled();
  });
});

it("rejects a session replaced during scoped agent-shell discovery before projecting its data", async () => {
  const f = await fixture();
  const owner = f.ownersCreated[0]!;
  const project = vi
    .spyOn(shellProjection, "projectApplicationShellResource")
    .mockReturnValue({ replacement: true } as never);
  owner.discoverShell.mockImplementationOnce(async () => {
    owner.catalog.mockResolvedValue([
      { sessionName: "same", liveSessionId: `live-session.${"b".repeat(20)}`, paneCount: 1 },
    ]);
    return {};
  });
  try {
    const response = await f.request(
      f.scope(f.a) + `/application-shell/same?liveSessionId=live-session.${"a".repeat(20)}`,
    );
    expect(response.status).toBe(409);
    expect(project).not.toHaveBeenCalled();
    expect(owner.catalog).toHaveBeenCalledTimes(2);
  } finally {
    project.mockRestore();
    await f.manager.dispose();
  }
});

it("uses enriched agent discovery for scoped shells so fleet statuses match pane headers", async () => {
  const f = await fixture();
  const owner = f.ownersCreated[0]!;
  const now = Math.floor(Date.now() / 1000);
  const session = {
    name: "same",
    runtimeSessionId: "$4",
    catalogIssue: "missing-semantic-stamp" as const,
    dir: "/private/project",
    panes: ["done", "blocked", "idle", "working"].map((state, index) => ({
      runtimePaneId: `%${index}`,
      semanticPaneId: `pane.agent${index}`,
      index,
      title: `Agent ${index}`,
      currentCommand: "claude",
      active: index === 0,
      windowPaneCount: 4,
      role: "agent",
      name: `Agent ${index}`,
      type: "agent",
      agentStateRaw: `${state}:${now}`,
      agentScrapeState: null,
    })),
  };
  owner.discoverShell.mockResolvedValue(session);
  // Raw terminal inventory deliberately has no agent status enrichment.
  owner.discover.mockResolvedValue({
    ...session,
    panes: session.panes.map(
      ({ agentStateRaw: _state, agentScrapeState: _scrape, ...pane }) => pane,
    ),
  });
  try {
    const response = await f.request(
      f.scope(f.a) + `/application-shell/same?liveSessionId=live-session.${"a".repeat(20)}`,
    );
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(
      body.resource.workspace.sidebar.agents.map((agent: { activity: string }) => agent.activity),
    ).toEqual(["complete", "waiting", "idle", "running"]);
    expect(owner.discoverShell).toHaveBeenCalledExactlyOnceWith("same");
    expect(owner.discover).not.toHaveBeenCalled();
    expect(f.ownersCreated[1]!.discoverShell).not.toHaveBeenCalled();
  } finally {
    await f.manager.dispose();
  }
});

describe("split layout reads", () => {
  const target = {
    liveSessionId: `live-session.${"a".repeat(20)}`,
    linkId: `window-link.${"b".repeat(32)}`,
    expectedSemanticWindowId: "window.same",
    linkRevision: 0,
  };
  it("requires owner auth and exact generation before reading", async () => {
    const f = await fixture();
    const path = f.scope(f.a) + "/split-layout/same";
    expect((await f.request(path, "POST", target, null)).status).toBe(401);
    expect(
      (await f.request(`/${f.a.serverId}/${randomUUID()}/split-layout/same`, "POST", target))
        .status,
    ).toBe(409);
    expect(f.ownersCreated.every((owner) => owner.splitRead.mock.calls.length === 0)).toBe(true);
  });
  it("rejects native addresses and exposes a no-store semantic resource", async () => {
    const f = await fixture();
    const path = f.scope(f.a) + "/split-layout/same";
    expect((await f.request(path, "POST", { ...target, nativeWindowId: "@1" })).status).toBe(400);
    const response = await f.request(path, "POST", target);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      version: 1,
      server: { serverId: f.a.serverId, generation: f.a.generation },
      resource: { window: target, panes: [{ semanticPaneId: "pane.same" }] },
    });
    expect(f.ownersCreated[0]!.splitRead).toHaveBeenCalledExactlyOnceWith("same", target);
    expect(f.ownersCreated[1]!.splitRead).not.toHaveBeenCalled();
  });
  it("reports retired layouts without leaking internal diagnostics", async () => {
    const f = await fixture();
    f.ownersCreated[0]!.splitRead.mockRejectedValueOnce(new WindowSplitLayoutUnavailable());
    const response = await f.request(f.scope(f.a) + "/split-layout/same", "POST", target);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "split-layout-stale" } });
  });
});
