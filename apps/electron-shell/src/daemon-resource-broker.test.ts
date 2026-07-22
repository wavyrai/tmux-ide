import {
  APPLICATION_SHELL_RESOURCE_VERSION,
  COHESION_FIXTURE_V1,
  type DesktopDaemonEvent,
  type DesktopDaemonHostState,
} from "@tmux-ide/contracts";
import { describe, expect, it, vi } from "vitest";

import { DaemonResourceBroker, type BrokerEventSocket } from "./daemon-resource-broker.ts";

const IDENTITY = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T00:00:00.000Z",
} as const;

const CONNECTED: DesktopDaemonHostState = {
  status: "connected",
  descriptor: { apiBaseUrl: "http://127.0.0.1:6060", ...IDENTITY },
};

const WORKSPACE_CATALOG = {
  version: 1,
  daemon: IDENTITY,
  workspaces: [
    {
      workspaceName: "product workspace",
      sessionName: "server/session:42",
    },
    {
      workspaceName: "docs",
      sessionName: "durable-docs",
    },
  ],
};

const APPLICATION_SHELL_ENVELOPE = {
  version: APPLICATION_SHELL_RESOURCE_VERSION,
  daemon: IDENTITY,
  resource: {
    project: COHESION_FIXTURE_V1.project,
    workspace: COHESION_FIXTURE_V1.workspace,
    dock: COHESION_FIXTURE_V1.dock,
    focus: COHESION_FIXTURE_V1.focus,
    connection: COHESION_FIXTURE_V1.connection,
  },
};

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

type FakeSocketEvent = "open" | "message" | "close" | "error";

class FakeSocket implements BrokerEventSocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly close = vi.fn((_: number, __: string) => {
    this.readyState = 3;
  });
  readonly #listeners = new Map<FakeSocketEvent, Array<(event: { data?: unknown }) => void>>();

  addEventListener(type: FakeSocketEvent, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  emit(type: FakeSocketEvent, data?: unknown): void {
    if (type === "open") this.readyState = 1;
    if (type === "close") this.readyState = 3;
    for (const listener of this.#listeners.get(type) ?? []) listener({ data });
  }
}

describe("Electron main daemon resource broker", () => {
  it("keeps the owner token in main and reuses one operation id across a transport retry", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const operationId = "10000000-0000-4000-8000-000000000001";
    let attempt = 0;
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async (input, init) => {
        requests.push({ url: input.toString(), init });
        attempt += 1;
        if (attempt === 1) throw new Error("transport timeout after commit");
        return json({
          ok: true,
          result: {
            operationId,
            daemonInstanceId: IDENTITY.instanceId,
            outcome: "replayed",
            resource: {
              resourceVersion: 1,
              workspaceName: "product workspace",
              semanticPaneId: "pane.10000000000040008000000000000001",
              kind: "terminal",
              displayTitle: "Terminal",
              harnessProfileId: null,
              role: null,
              missionId: null,
            },
          },
        });
      },
    });

    await expect(
      broker.createWorkspacePane({
        operationId,
        expectedDaemonInstanceId: IDENTITY.instanceId,
        intent: { kind: "terminal", workspaceName: "product workspace" },
      }),
    ).resolves.toMatchObject({ operationId, outcome: "replayed" });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe("http://127.0.0.1:6060/api/v2/action/workspace.pane.create");
      expect(new Headers(request.init?.headers)).toMatchObject({});
      expect(new Headers(request.init?.headers).get("authorization")).toBe(
        "Bearer owner-only-token",
      );
      expect(new Headers(request.init?.headers).get("x-tmux-ide-operation-id")).toBe(operationId);
      expect(JSON.parse(String(request.init?.body))).toEqual({
        kind: "terminal",
        workspaceName: "product workspace",
      });
    }
  });

  it("issues a bounded terminal attachment against only the exact owner-authorized endpoint", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const now = 1_784_662_800_000;
    const requestId = "10000000-0000-4000-8000-000000000001";
    const descriptor = {
      protocolVersion: 1 as const,
      webSocketUrl: "ws://127.0.0.1:6060/v1/terminal/attachments/redeem",
      subprotocol: "tmux-ide-terminal.v1" as const,
      redemptionTicket: `ta1_${"A".repeat(43)}`,
      daemonInstanceId: IDENTITY.instanceId,
      requestId,
      expiresAt: now + 30_000,
      effectiveViewerMode: "interactive" as const,
    };
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      now: () => now,
      fetch: async (input, init) => {
        requests.push({ url: input.toString(), init });
        return json({ status: "issued", descriptor });
      },
    });
    const mutation = {
      requestId,
      expectedDaemonInstanceId: IDENTITY.instanceId,
      attachment: {
        protocolVersion: 1 as const,
        target: { workspaceName: "product", semanticPaneId: "pane.worker" },
        viewerMode: "interactive" as const,
        viewport: { cols: 120, rows: 40 },
      },
    };

    await expect(
      broker.issueTerminalAttachment(mutation, "http://127.0.0.1:5173"),
    ).resolves.toEqual({ status: "issued", descriptor });
    expect(requests).toHaveLength(1);
    const sent = requests[0]!;
    expect(sent.url).toBe("http://127.0.0.1:6060/api/v1/terminal/attachments/issue");
    expect(sent.init).toMatchObject({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
    const headers = new Headers(sent.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer owner-only-token");
    expect(headers.get("origin")).toBe("http://127.0.0.1:5173");
    expect(headers.get("x-tmux-ide-request-id")).toBe(requestId);
    expect(headers.get("x-tmux-ide-expected-daemon-instance-id")).toBe(IDENTITY.instanceId);
    expect(JSON.parse(String(sent.init?.body))).toEqual(mutation);
    expect(JSON.stringify(sent)).not.toContain(descriptor.redemptionTicket);
  });

  it("does not accept a remote capability in place of the canonical owner secret", async () => {
    const fetch = vi.fn();
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      fetch,
      // A renderer/remote bearer is not a constructor capability and is ignored.
      remoteToken: "remote-access-token",
    } as ConstructorParameters<typeof DaemonResourceBroker>[0] & { remoteToken: string });
    await expect(
      broker.issueTerminalAttachment(
        {
          requestId: "10000000-0000-4000-8000-000000000001",
          expectedDaemonInstanceId: IDENTITY.instanceId,
          attachment: {
            protocolVersion: 1,
            target: { workspaceName: "product", semanticPaneId: "pane.worker" },
            viewerMode: "interactive",
            viewport: { cols: 120, rows: 40 },
          },
        },
        "http://127.0.0.1:5173",
      ),
    ).resolves.toMatchObject({ status: "error", error: { code: "daemon-unavailable" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("redacts an invalid daemon issue response instead of reflecting credential text", async () => {
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async () =>
        json({
          status: "error",
          error: {
            code: "request-failed",
            reason: "Authorization: Bearer leaked-owner-token",
            retryable: false,
          },
        }),
    });
    const result = await broker.issueTerminalAttachment(
      {
        requestId: "10000000-0000-4000-8000-000000000001",
        expectedDaemonInstanceId: IDENTITY.instanceId,
        attachment: {
          protocolVersion: 1,
          target: { workspaceName: "product", semanticPaneId: "pane.worker" },
          viewerMode: "interactive",
          viewport: { cols: 120, rows: 40 },
        },
      },
      "http://127.0.0.1:5173",
    );
    expect(result).toMatchObject({ status: "error", error: { code: "invalid-response" } });
    expect(JSON.stringify(result)).not.toMatch(/bearer|owner.?token|authorization/iu);
  });

  it("applies a narrow response bound to terminal attachment issuance", async () => {
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async () =>
        json(
          { status: "error", error: { code: "request-failed", reason: "ignored" } },
          { headers: { "content-length": String(16 * 1024 + 1) } },
        ),
    });
    await expect(
      broker.issueTerminalAttachment(
        {
          requestId: "10000000-0000-4000-8000-000000000001",
          expectedDaemonInstanceId: IDENTITY.instanceId,
          attachment: {
            protocolVersion: 1,
            target: { workspaceName: "product", semanticPaneId: "pane.worker" },
            viewerMode: "interactive",
            viewport: { cols: 120, rows: 40 },
          },
        },
        "http://127.0.0.1:5173",
      ),
    ).resolves.toMatchObject({ status: "error", error: { code: "response-too-large" } });
  });

  it("keeps one physical socket for an empty catalog-only subscription", async () => {
    const socket = new FakeSocket();
    const events: DesktopDaemonEvent[] = [];
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      fetch: async () => json(WORKSPACE_CATALOG),
      createWebSocket: () => socket,
    });
    const result = await broker.subscribe([], (event) => events.push(event));
    expect(result.status).toBe("subscribed");
    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "hello", daemon: IDENTITY, sessions: [] }));
    expect(socket.sent).toEqual([]);
    expect(events).toEqual([{ type: "connection.changed", state: "live", error: null }]);

    socket.emit(
      "message",
      JSON.stringify({
        type: "workspace.added",
        workspace: {
          name: "new-workspace",
          sessionName: "private-route",
          projectDir: "/private/project",
          ideConfigPath: null,
          addedAt: "2026-07-21T00:00:00.000Z",
        },
      }),
    );
    expect(events.at(-1)).toEqual({ type: "workspaces.changed" });
    expect(JSON.stringify(events)).not.toMatch(/private-route|private\/project|sessionName/iu);
    if (result.status === "subscribed") result.unsubscribe();
    expect(socket.close).toHaveBeenCalledWith(1000, "renderer released");
  });

  it("resolves a semantic workspace through the typed catalog and exposes no daemon route facts", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, init });
      return url.endsWith("/api/resources/workspace-catalog")
        ? json(WORKSPACE_CATALOG)
        : json(APPLICATION_SHELL_ENVELOPE);
    });
    const broker = new DaemonResourceBroker({ daemon: CONNECTED, fetch });

    const listed = await broker.listWorkspaces();
    expect(listed).toEqual({
      status: "ok",
      daemon: IDENTITY,
      workspaces: [{ workspaceName: "product workspace" }, { workspaceName: "docs" }],
    });
    expect(JSON.stringify(listed)).not.toMatch(/sessionName|projectDir|apiBaseUrl|private|token/iu);

    const resource = await broker.fetchApplicationShell("product workspace");
    expect(resource).toEqual({ status: "ok", envelope: APPLICATION_SHELL_ENVELOPE });
    expect(requests.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:6060/api/resources/workspace-catalog",
      "http://127.0.0.1:6060/api/resources/workspace-catalog",
      "http://127.0.0.1:6060/api/project/server%2Fsession%3A42/application-shell",
    ]);
    expect(requests.every(({ init }) => init?.method === "GET" && init.redirect === "error")).toBe(
      true,
    );
    expect(JSON.stringify(requests.map(({ init }) => init?.headers))).not.toMatch(/bearer|token/iu);
  });

  it("never lets an unknown semantic name become a daemon route", async () => {
    const fetch = vi.fn(async () => json(WORKSPACE_CATALOG));
    const broker = new DaemonResourceBroker({ daemon: CONNECTED, fetch });
    await expect(broker.fetchApplicationShell("../../escape")).resolves.toEqual({
      status: "error",
      error: {
        code: "workspace-not-found",
        reason: "The requested workspace is unavailable.",
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["protocolVersion", { protocolVersion: 2 }],
    ["productVersion", { productVersion: "2.8.1" }],
    ["instanceId", { instanceId: "66ab67ed-18fe-431b-913b-70972b78c96f" }],
    ["startedAt", { startedAt: "2026-07-21T00:00:01.000Z" }],
  ])("rejects a catalog whose daemon %s is from another generation", async (_field, changed) => {
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      fetch: async () =>
        json({ ...WORKSPACE_CATALOG, daemon: { ...WORKSPACE_CATALOG.daemon, ...changed } }),
    });
    await expect(broker.listWorkspaces()).resolves.toMatchObject({
      status: "error",
      error: { code: "daemon-identity-mismatch" },
    });
  });

  it.each([" docs ", "docs "])(
    "rejects a non-canonical raw catalog workspace name %j",
    async (workspaceName) => {
      const broker = new DaemonResourceBroker({
        daemon: CONNECTED,
        fetch: async () =>
          json({
            ...WORKSPACE_CATALOG,
            workspaces: [{ workspaceName, sessionName: "docs-one" }],
          }),
      });
      await expect(broker.listWorkspaces()).resolves.toMatchObject({
        status: "error",
        error: { code: "invalid-response" },
      });
    },
  );

  it("rejects duplicate canonical raw catalog identities", async () => {
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      fetch: async () =>
        json({
          ...WORKSPACE_CATALOG,
          workspaces: [
            { workspaceName: "docs", sessionName: "docs-one" },
            { workspaceName: "docs", sessionName: "docs-two" },
          ],
        }),
    });
    await expect(broker.listWorkspaces()).resolves.toMatchObject({
      status: "error",
      error: { code: "invalid-response" },
    });
  });

  it("rejects duplicate subscription names after semantic normalization", async () => {
    const fetch = vi.fn(async () => json(WORKSPACE_CATALOG));
    const broker = new DaemonResourceBroker({ daemon: CONNECTED, fetch });
    await expect(broker.subscribe(["docs", " docs "], vi.fn())).resolves.toMatchObject({
      status: "error",
      error: { code: "invalid-request" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "redirect",
      fetch: async () =>
        Object.defineProperty(json(WORKSPACE_CATALOG), "redirected", { value: true }) as Response,
      code: "request-failed",
    },
    {
      name: "oversized",
      fetch: async () =>
        new Response(JSON.stringify(WORKSPACE_CATALOG), {
          headers: { "content-type": "application/json", "content-length": "9999999" },
        }),
      code: "response-too-large",
    },
    {
      name: "wrong content type",
      fetch: async () => new Response("{}", { headers: { "content-type": "text/html" } }),
      code: "invalid-response",
    },
    {
      name: "JSON-derived but non-JSON media type",
      fetch: async () =>
        new Response(JSON.stringify(WORKSPACE_CATALOG), {
          headers: { "content-type": "application/json-patch+json" },
        }),
      code: "invalid-response",
    },
    {
      name: "invalid strict schema",
      fetch: async () => json({ ...WORKSPACE_CATALOG, token: "do-not-reflect" }),
      code: "invalid-response",
    },
  ])("returns a bounded redacted error for $name", async ({ fetch, code }) => {
    const broker = new DaemonResourceBroker({ daemon: CONNECTED, fetch });
    const result = await broker.listWorkspaces();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(code);
      expect(JSON.stringify(result.error)).not.toMatch(/6060|workspaces|private|token|html/iu);
      expect(result.error.reason.length).toBeLessThanOrEqual(240);
    }
  });

  it("bounds request time and aborts a renderer generation on release", async () => {
    let signal: AbortSignal | undefined;
    const never = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          init?.signal?.addEventListener("abort", () => reject(new Error("secret abort detail")));
        }),
    );
    const timed = new DaemonResourceBroker({
      daemon: CONNECTED,
      fetch: never,
      requestTimeoutMs: 5,
    });
    await expect(timed.listWorkspaces()).resolves.toMatchObject({
      status: "error",
      error: { code: "request-timeout" },
    });
    expect(signal?.aborted).toBe(true);

    const released = new DaemonResourceBroker({ daemon: CONNECTED, fetch: never });
    const pending = released.listWorkspaces();
    await vi.waitFor(() => expect(never).toHaveBeenCalledTimes(2));
    released.releaseRenderer();
    await expect(pending).resolves.toMatchObject({ status: "error", error: { code: "disposed" } });
  });

  it("does no HTTP or WebSocket work when the verified daemon is unavailable", async () => {
    const fetch = vi.fn();
    const createWebSocket = vi.fn();
    const broker = new DaemonResourceBroker({
      daemon: {
        status: "unavailable",
        code: "record-missing",
        reason: "/private/path must not be reflected",
      },
      fetch,
      createWebSocket,
    });
    expect(await broker.listWorkspaces()).toMatchObject({
      status: "error",
      error: { code: "daemon-unavailable" },
    });
    expect(await broker.subscribe(["product workspace"], vi.fn())).toMatchObject({
      status: "error",
      error: { code: "daemon-unavailable" },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(createWebSocket).not.toHaveBeenCalled();
  });

  it("multiplexes semantic subscribers over one identity-gated socket and sanitizes frames", async () => {
    const fetch = vi.fn(async () => json(WORKSPACE_CATALOG));
    const socket = new FakeSocket();
    const createWebSocket = vi.fn(() => socket);
    const first: DesktopDaemonEvent[] = [];
    const second: DesktopDaemonEvent[] = [];
    const broker = new DaemonResourceBroker({ daemon: CONNECTED, fetch, createWebSocket });

    const one = await broker.subscribe(["product workspace"], (event) => first.push(event));
    const two = await broker.subscribe(["docs"], (event) => second.push(event));
    expect(one.status).toBe("subscribed");
    expect(two.status).toBe("subscribed");
    expect(createWebSocket).toHaveBeenCalledOnce();
    expect(createWebSocket).toHaveBeenCalledWith("ws://127.0.0.1:6060/ws/events");

    socket.emit("open");
    expect(socket.sent).toEqual([]);
    socket.emit("message", JSON.stringify({ type: "hello", daemon: IDENTITY, sessions: [] }));
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: "subscribe",
      sessions: ["server/session:42", "durable-docs"],
    });
    socket.emit(
      "message",
      JSON.stringify({ type: "terminals.changed", sessionName: "server/session:42" }),
    );
    expect(first.at(-1)).toEqual({
      type: "application-shell.changed",
      workspaceName: "product workspace",
    });
    expect(second.some((event) => event.type === "application-shell.changed")).toBe(false);

    socket.emit(
      "message",
      JSON.stringify({
        type: "workspace.added",
        workspace: {
          name: "secret-free",
          sessionName: "raw-secret-session",
          projectDir: "/private/leak",
          ideConfigPath: null,
          addedAt: "2026-07-21T00:00:00.000Z",
        },
      }),
    );
    expect(first.at(-1)).toEqual({ type: "workspaces.changed" });
    expect(JSON.stringify([...first, ...second])).not.toMatch(
      /raw-secret|private\/leak|sessionName/iu,
    );

    if (one.status === "subscribed") one.unsubscribe();
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "unsubscribe",
      sessions: ["server/session:42"],
    });
    if (two.status === "subscribed") two.unsubscribe();
    expect(socket.close).toHaveBeenCalledWith(1000, "renderer released");
  });

  it("targets an immediate verified live event to a subscriber joining an open socket", async () => {
    const socket = new FakeSocket();
    const first: DesktopDaemonEvent[] = [];
    const second: DesktopDaemonEvent[] = [];
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      fetch: async () => json(WORKSPACE_CATALOG),
      createWebSocket: () => socket,
    });
    expect(
      (await broker.subscribe(["product workspace"], (event) => first.push(event))).status,
    ).toBe("subscribed");
    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "hello", daemon: IDENTITY, sessions: [] }));
    expect(first.filter((event) => event.type === "connection.changed")).toHaveLength(1);

    expect((await broker.subscribe(["docs"], (event) => second.push(event))).status).toBe(
      "subscribed",
    );
    expect(second).toEqual([{ type: "connection.changed", state: "live", error: null }]);
    expect(first.filter((event) => event.type === "connection.changed")).toHaveLength(1);
  });

  it.each([
    {
      name: "padded add",
      frame: {
        type: "workspace.added",
        workspace: {
          name: " docs ",
          sessionName: "docs-replaced",
          projectDir: "/private/replaced",
          ideConfigPath: null,
          addedAt: "2026-07-21T00:00:00.000Z",
        },
      },
    },
    { name: "padded remove", frame: { type: "workspace.removed", name: " docs " } },
    {
      name: "canonical add collision",
      frame: {
        type: "workspace.added",
        workspace: {
          name: "docs",
          sessionName: "docs-replaced",
          projectDir: "/private/replaced",
          ideConfigPath: null,
          addedAt: "2026-07-21T00:00:00.000Z",
        },
      },
    },
  ])(
    "rejects $name, reloads the stamped catalog, and preserves the original subscription",
    async ({ frame }) => {
      const originalSocket = new FakeSocket();
      const refreshedSocket = new FakeSocket();
      const sockets = [originalSocket, refreshedSocket];
      const fetch = vi.fn(async () => json(WORKSPACE_CATALOG));
      const createWebSocket = vi.fn(() => sockets.shift()!);
      const events: DesktopDaemonEvent[] = [];
      const broker = new DaemonResourceBroker({
        daemon: CONNECTED,
        fetch,
        createWebSocket,
      });
      expect((await broker.subscribe(["docs"], (event) => events.push(event))).status).toBe(
        "subscribed",
      );
      originalSocket.emit("open");
      originalSocket.emit(
        "message",
        JSON.stringify({ type: "hello", daemon: IDENTITY, sessions: [] }),
      );
      events.length = 0;

      originalSocket.emit("message", JSON.stringify(frame));
      expect(originalSocket.close).toHaveBeenCalledWith(1002, expect.any(String));
      expect(events.at(-1)).toMatchObject({
        type: "connection.changed",
        state: "degraded",
        error: { code: "invalid-response" },
      });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(createWebSocket).toHaveBeenCalledTimes(2));

      refreshedSocket.emit("open");
      refreshedSocket.emit(
        "message",
        JSON.stringify({ type: "hello", daemon: IDENTITY, sessions: [] }),
      );
      expect(refreshedSocket.sent.map((value) => JSON.parse(value))).toContainEqual({
        type: "subscribe",
        sessions: ["durable-docs"],
      });
      events.length = 0;
      refreshedSocket.emit(
        "message",
        JSON.stringify({ type: "terminals.changed", sessionName: "durable-docs" }),
      );
      refreshedSocket.emit(
        "message",
        JSON.stringify({ type: "terminals.changed", sessionName: "docs-replaced" }),
      );
      expect(events).toEqual([{ type: "application-shell.changed", workspaceName: "docs" }]);
    },
  );

  it.each(["success", "failure"] as const)(
    "drops a released renderer's rejected-update refresh %s before a replacement renderer",
    async (settlement) => {
      let resolveOldRefresh!: (response: Response) => void;
      let rejectOldRefresh!: (error: unknown) => void;
      const oldRefresh = new Promise<Response>((resolve, reject) => {
        resolveOldRefresh = resolve;
        rejectOldRefresh = reject;
      });
      let fetchCalls = 0;
      const fetch = vi.fn(() => {
        fetchCalls += 1;
        return fetchCalls === 2 ? oldRefresh : Promise.resolve(json(WORKSPACE_CATALOG));
      });
      const originalSocket = new FakeSocket();
      const replacementSocket = new FakeSocket();
      const sockets = [originalSocket, replacementSocket];
      const createWebSocket = vi.fn(() => sockets.shift()!);
      const originalEvents: DesktopDaemonEvent[] = [];
      const replacementEvents: DesktopDaemonEvent[] = [];
      const broker = new DaemonResourceBroker({
        daemon: CONNECTED,
        fetch,
        createWebSocket,
      });

      expect((await broker.subscribe(["docs"], (event) => originalEvents.push(event))).status).toBe(
        "subscribed",
      );
      originalSocket.emit("open");
      originalSocket.emit(
        "message",
        JSON.stringify({ type: "hello", daemon: IDENTITY, sessions: [] }),
      );
      originalSocket.emit(
        "message",
        JSON.stringify({
          type: "workspace.added",
          workspace: {
            name: " docs ",
            sessionName: "old-private-route",
            projectDir: "/old/private/project",
            ideConfigPath: null,
            addedAt: "2026-07-21T00:00:00.000Z",
          },
        }),
      );
      expect(fetch).toHaveBeenCalledTimes(2);

      broker.releaseRenderer();
      expect(
        (await broker.subscribe(["docs"], (event) => replacementEvents.push(event))).status,
      ).toBe("subscribed");
      replacementSocket.emit("open");
      replacementSocket.emit(
        "message",
        JSON.stringify({ type: "hello", daemon: IDENTITY, sessions: [] }),
      );
      replacementEvents.length = 0;

      if (settlement === "success") resolveOldRefresh(json(WORKSPACE_CATALOG));
      else rejectOldRefresh(new Error("private released-renderer failure"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(replacementEvents).toEqual([]);
      expect(createWebSocket).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(replacementEvents)).not.toMatch(/disposed|degraded|private/iu);
      broker.dispose();
    },
  );

  it.each([false, true])(
    "bounds the event handshake when socket open=%s and clears it on release",
    async (opened) => {
      vi.useFakeTimers();
      try {
        const socket = new FakeSocket();
        const events: DesktopDaemonEvent[] = [];
        const broker = new DaemonResourceBroker({
          daemon: CONNECTED,
          fetch: async () => json(WORKSPACE_CATALOG),
          createWebSocket: () => socket,
          eventHandshakeTimeoutMs: 10,
        });
        expect((await broker.subscribe(["docs"], (event) => events.push(event))).status).toBe(
          "subscribed",
        );
        if (opened) socket.emit("open");
        await vi.advanceTimersByTimeAsync(10);
        expect(events.at(-1)).toMatchObject({
          type: "connection.changed",
          state: "degraded",
          error: { code: "event-unavailable" },
        });
        expect(socket.close).toHaveBeenCalledWith(1008, "event handshake timeout");

        const releasedSocket = new FakeSocket();
        const releasedEvents: DesktopDaemonEvent[] = [];
        const released = new DaemonResourceBroker({
          daemon: CONNECTED,
          fetch: async () => json(WORKSPACE_CATALOG),
          createWebSocket: () => releasedSocket,
          eventHandshakeTimeoutMs: 10,
        });
        await released.subscribe(["docs"], (event) => releasedEvents.push(event));
        released.releaseRenderer();
        await vi.advanceTimersByTimeAsync(10);
        expect(releasedEvents).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("closes an errored physical event socket", async () => {
    const socket = new FakeSocket();
    const events: DesktopDaemonEvent[] = [];
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      fetch: async () => json(WORKSPACE_CATALOG),
      createWebSocket: () => socket,
    });
    await broker.subscribe(["docs"], (event) => events.push(event));
    socket.emit("error");
    expect(socket.close).toHaveBeenCalledWith(1011, "event connection failed");
    expect(events.at(-1)).toMatchObject({ error: { code: "event-unavailable" } });
  });

  it("recovers a retained logical subscriber over one physical socket at a time", async () => {
    vi.useFakeTimers();
    try {
      const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
      const createWebSocket = vi.fn(() => sockets[createWebSocket.mock.calls.length - 1]!);
      const events: DesktopDaemonEvent[] = [];
      const broker = new DaemonResourceBroker({
        daemon: CONNECTED,
        fetch: async () => json(WORKSPACE_CATALOG),
        createWebSocket,
        eventReconnectInitialDelayMs: 10,
        eventReconnectMaximumDelayMs: 10,
        eventReconnectMaximumAttempts: 2,
      });
      const result = await broker.subscribe([], (event) => events.push(event));
      expect(result.status).toBe("subscribed");
      expect(createWebSocket).toHaveBeenCalledOnce();

      sockets[0]!.emit("close");
      await vi.advanceTimersByTimeAsync(9);
      expect(createWebSocket).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(createWebSocket).toHaveBeenCalledTimes(2);
      sockets[0]!.emit("close");
      expect(createWebSocket).toHaveBeenCalledTimes(2);

      sockets[1]!.emit("open");
      sockets[1]!.emit(
        "message",
        JSON.stringify({ type: "hello", daemon: IDENTITY, sessions: [] }),
      );
      expect(events.at(-1)).toEqual({ type: "connection.changed", state: "live", error: null });
      sockets[1]!.emit("close");
      await vi.advanceTimersByTimeAsync(10);
      expect(createWebSocket).toHaveBeenCalledTimes(3);
      if (result.status === "subscribed") result.unsubscribe();
      expect(sockets[2]!.close).toHaveBeenCalledWith(1000, "renderer released");
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives the default reconnect maximum from a larger initial delay override", async () => {
    vi.useFakeTimers();
    try {
      const first = new FakeSocket();
      const second = new FakeSocket();
      const sockets = [first, second];
      const createWebSocket = vi.fn(() => sockets.shift()!);
      const broker = new DaemonResourceBroker({
        daemon: CONNECTED,
        fetch: async () => json(WORKSPACE_CATALOG),
        createWebSocket,
        eventReconnectInitialDelayMs: 5_000,
        eventReconnectMaximumAttempts: 1,
      });
      const result = await broker.subscribe([], vi.fn());
      first.emit("close");
      await vi.advanceTimersByTimeAsync(4_999);
      expect(createWebSocket).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(createWebSocket).toHaveBeenCalledTimes(2);
      if (result.status === "subscribed") result.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds physical reconnect attempts while logical subscribers remain", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const createWebSocket = vi.fn(() => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      });
      const broker = new DaemonResourceBroker({
        daemon: CONNECTED,
        fetch: async () => json(WORKSPACE_CATALOG),
        createWebSocket,
        eventReconnectInitialDelayMs: 10,
        eventReconnectMaximumDelayMs: 10,
        eventReconnectMaximumAttempts: 2,
      });
      const result = await broker.subscribe([], vi.fn());
      sockets[0]!.emit("close");
      await vi.advanceTimersByTimeAsync(10);
      sockets[1]!.emit("close");
      await vi.advanceTimersByTimeAsync(10);
      sockets[2]!.emit("close");
      await vi.advanceTimersByTimeAsync(100);
      expect(createWebSocket).toHaveBeenCalledTimes(3);
      if (result.status === "subscribed") result.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      label: "protocol error",
      frame: {
        type: "protocol.error",
        code: "invalid-frame",
        message: "Client frame does not match the daemon event protocol.",
      },
      close: [1002, "daemon protocol error"] as const,
    },
    {
      label: "malformed frame",
      frame: { type: "not-a-frame", private: "/must/not/leak" },
      close: [1002, "invalid event frame"] as const,
    },
  ])("recovers its physical socket after a $label", async ({ frame, close }) => {
    vi.useFakeTimers();
    try {
      const first = new FakeSocket();
      const second = new FakeSocket();
      const sockets = [first, second];
      const createWebSocket = vi.fn(() => sockets.shift()!);
      const events: DesktopDaemonEvent[] = [];
      const broker = new DaemonResourceBroker({
        daemon: CONNECTED,
        fetch: async () => json(WORKSPACE_CATALOG),
        createWebSocket,
        eventReconnectInitialDelayMs: 10,
        eventReconnectMaximumDelayMs: 10,
        eventReconnectMaximumAttempts: 1,
      });
      const result = await broker.subscribe([], (event) => events.push(event));
      first.emit("open");
      first.emit("message", JSON.stringify({ type: "hello", daemon: IDENTITY, sessions: [] }));
      first.emit("message", JSON.stringify(frame));
      expect(first.close).toHaveBeenCalledWith(...close);
      expect(events.at(-1)).toMatchObject({ type: "connection.changed", state: "degraded" });
      expect(JSON.stringify(events)).not.toMatch(/must\/not\/leak|private/iu);
      await vi.advanceTimersByTimeAsync(10);
      expect(createWebSocket).toHaveBeenCalledTimes(2);
      if (result.status === "subscribed") result.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an event peer mismatch and never sends the subscription", async () => {
    vi.useFakeTimers();
    try {
      const first = new FakeSocket();
      const second = new FakeSocket();
      const sockets = [first, second];
      const createWebSocket = vi.fn(() => sockets.shift()!);
      const events: DesktopDaemonEvent[] = [];
      const broker = new DaemonResourceBroker({
        daemon: CONNECTED,
        fetch: async () => json(WORKSPACE_CATALOG),
        createWebSocket,
        eventReconnectInitialDelayMs: 10,
        eventReconnectMaximumDelayMs: 10,
        eventReconnectMaximumAttempts: 1,
      });
      const result = await broker.subscribe(["docs"], (event) => events.push(event));
      expect(result.status).toBe("subscribed");
      first.emit("open");
      first.emit(
        "message",
        JSON.stringify({
          type: "hello",
          daemon: { ...IDENTITY, instanceId: "66ab67ed-18fe-431b-913b-70972b78c96f" },
          sessions: [],
        }),
      );
      expect(first.sent).toEqual([]);
      expect(first.close).toHaveBeenCalledWith(1008, "daemon generation mismatch");
      expect(events.at(-1)).toMatchObject({
        type: "connection.changed",
        state: "degraded",
        error: { code: "daemon-identity-mismatch" },
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(createWebSocket).toHaveBeenCalledTimes(2);
      if (result.status === "subscribed") result.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects event data that arrives before the socket open boundary", async () => {
    const socket = new FakeSocket();
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      fetch: async () => json(WORKSPACE_CATALOG),
      createWebSocket: () => socket,
    });
    expect((await broker.subscribe(["docs"], vi.fn())).status).toBe("subscribed");
    socket.emit("message", JSON.stringify({ type: "hello", daemon: IDENTITY, sessions: [] }));
    expect(socket.sent).toEqual([]);
    expect(socket.close).toHaveBeenCalledWith(1002, "event frame before open");
  });
});
