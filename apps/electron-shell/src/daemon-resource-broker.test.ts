import {
  APPLICATION_SHELL_RESOURCE_V2_VERSION,
  APPLICATION_SHELL_RESOURCE_V3_VERSION,
  APP_WINDOW_MAX_ID_LENGTH,
  APP_WINDOW_MAX_LAYOUTS,
  APP_WINDOW_TIMESTAMP_MAX_LENGTH,
  APP_WINDOW_MAX_WINDOWS,
  ApplicationShellResourceV3SchemaZ,
  AppWindowDocumentV1SchemaZ,
  COHESION_FIXTURE_V1,
  DESKTOP_PACKAGED_RENDERER_ORIGIN,
  TERMINAL_ATTACHMENT_ISSUE_PATH,
  PANE_STREAM_ISSUE_PATH,
  type DesktopDaemonEvent,
  type DesktopDaemonHostState,
  type AppWindowDockNodeShape,
  type AppWindowInstance,
} from "@tmux-ide/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  APPLICATION_SHELL_V3_MAX_RESPONSE_BYTES,
  DaemonResourceBroker,
  workspacePromotionFailureFromUnknown,
  type BrokerEventSocket,
} from "./daemon-resource-broker.ts";

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
  version: APPLICATION_SHELL_RESOURCE_V2_VERSION,
  daemon: IDENTITY,
  resource: {
    project: COHESION_FIXTURE_V1.project,
    workspace: {
      ...COHESION_FIXTURE_V1.workspace,
      sidebar: {
        ...COHESION_FIXTURE_V1.workspace.sidebar,
        agents: COHESION_FIXTURE_V1.workspace.sidebar.agents.map((agent) => ({
          ...agent,
          paneId: null,
        })),
      },
    },
    dock: COHESION_FIXTURE_V1.dock,
    focus: COHESION_FIXTURE_V1.focus,
    connection: COHESION_FIXTURE_V1.connection,
    terminalInventory: { activeResourceId: null, resources: [] },
  },
};

const APPLICATION_SHELL_V3_ENVELOPE = {
  version: APPLICATION_SHELL_RESOURCE_V3_VERSION,
  daemon: IDENTITY,
  resource: {
    ...APPLICATION_SHELL_ENVELOPE.resource,
    appWindows: {
      version: 1,
      revision: 0,
      updatedAt: "2026-07-22T10:00:00.000Z",
      windows: {},
      dockRoot: null,
      dockState: { mode: "collapsed", preferredHeight: null, focusZone: "canvas" },
      floatingOrder: [],
      focusedWindowId: null,
      activeLayoutId: null,
      layouts: {},
    },
  },
};

function maximumSemanticId(prefix: string, index: number): string {
  const head = `${prefix}${String(index).padStart(3, "0")}`;
  return `${head}${"x".repeat(APP_WINDOW_MAX_ID_LENGTH - head.length)}`;
}

const MAXIMUM_APP_WINDOW_TIMESTAMP = "2026-07-22T10:00:00.123456789Z";

/** Current schema maxima with maximum timestamps and six-byte JSON-expanded bounded text. */
function maximumApplicationShellV3Envelope() {
  const escapedText = "\u0001";
  const windows: Record<string, AppWindowInstance> = {};
  let dockNodes: AppWindowDockNodeShape[] = Array.from(
    { length: APP_WINDOW_MAX_WINDOWS },
    (_, index) => {
      const windowId = maximumSemanticId("window.", index);
      const stackId = maximumSemanticId("stack.", index);
      windows[windowId] = {
        id: windowId,
        source: {
          kind: "terminal",
          terminalSourceId: maximumSemanticId("terminal.", index),
        },
        title: escapedText.repeat(160),
        placement: {
          mode: "docked",
          docked: { stackId, index: 0 },
          floating: { x: -1_000_000, y: -1_000_000, width: 1_000_000, height: 1_000_000 },
        },
      };
      return {
        type: "stack",
        id: stackId,
        windowIds: [windowId],
        activeWindowId: windowId,
      };
    },
  );
  let level = 0;
  while (dockNodes.length > 1) {
    const next: AppWindowDockNodeShape[] = [];
    for (let index = 0; index < dockNodes.length; index += 2) {
      const left = dockNodes[index]!;
      const right = dockNodes[index + 1];
      if (!right) {
        next.push(left);
        continue;
      }
      next.push({
        type: "split",
        id: maximumSemanticId(`split.${level}.`, index / 2),
        axis: level % 2 === 0 ? "horizontal" : "vertical",
        children: [left, right],
        weights: [1_000_000, 1_000_000],
      });
    }
    dockNodes = next;
    level += 1;
  }
  const focusedWindowId = Object.keys(windows)[0]!;
  const scene = {
    windows,
    dockRoot: dockNodes[0]!,
    dockState: { mode: "maximized", preferredHeight: 1_000_000, focusZone: "dock-body" },
    floatingOrder: [],
    focusedWindowId,
  };
  const layouts = Object.fromEntries(
    Array.from({ length: APP_WINDOW_MAX_LAYOUTS }, (_, index) => {
      const layoutId = maximumSemanticId("layout.", index);
      return [
        layoutId,
        {
          id: layoutId,
          name: escapedText.repeat(80),
          description: escapedText.repeat(512),
          revision: Number.MAX_SAFE_INTEGER,
          createdAt: MAXIMUM_APP_WINDOW_TIMESTAMP,
          updatedAt: MAXIMUM_APP_WINDOW_TIMESTAMP,
          scene,
        },
      ];
    }),
  );
  const appWindows = AppWindowDocumentV1SchemaZ.parse({
    ...scene,
    version: 1,
    revision: Number.MAX_SAFE_INTEGER,
    updatedAt: MAXIMUM_APP_WINDOW_TIMESTAMP,
    activeLayoutId: Object.keys(layouts)[0],
    layouts,
  });
  return ApplicationShellResourceV3SchemaZ.parse({
    ...APPLICATION_SHELL_V3_ENVELOPE,
    resource: {
      ...APPLICATION_SHELL_V3_ENVELOPE.resource,
      terminalInventory: {
        activeResourceId: null,
        resources: Array.from({ length: 512 }, (_, index) => ({
          id: maximumSemanticId("resource.", index),
          title: escapedText.repeat(160),
          kind: "terminal",
          active: false,
          attachability: { status: "unavailable", reason: "invalid-runtime-proof" },
        })),
      },
      appWindows,
    },
  });
}

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
  it("negotiates owner-authenticated AppWindow availability and treats an old 404 as unsupported", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async (input, init) => {
        requests.push({ url: input.toString(), init });
        return new Response("missing", { status: 404 });
      },
    });
    await expect(broker.capabilities()).resolves.toEqual({
      status: "ok",
      daemon: IDENTITY,
      capabilities: {
        appWindowMutation: {
          available: false,
          reason: "This daemon predates durable AppWindow mutation support.",
        },
      },
    });
    expect(requests[0]?.url).toBe("http://127.0.0.1:6060/api/v2/capabilities");
    expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBe(
      "Bearer owner-only-token",
    );
    expect(requests[0]?.init?.redirect).toBe("error");
  });

  it("rejects a capability catalog stamped by another daemon generation", async () => {
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async () =>
        json({
          status: "ok",
          daemon: { ...IDENTITY, instanceId: "00000000-0000-4000-8000-000000000099" },
          capabilities: { appWindowMutation: { available: true } },
        }),
    });
    await expect(broker.capabilities()).resolves.toMatchObject({
      status: "error",
      error: { code: "daemon-identity-mismatch" },
    });
  });

  it("reuses one AppWindow operation id across a single uncertain transport retry", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const operationId = "30000000-0000-4000-8000-000000000003";
    let mutationAttempt = 0;
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async (input, init) => {
        const url = input.toString();
        requests.push({ url, init });
        if (url.endsWith("/api/resources/workspace-catalog")) return json(WORKSPACE_CATALOG);
        mutationAttempt += 1;
        if (mutationAttempt === 1) throw new Error("transport timeout after commit");
        return json({
          ok: true,
          result: {
            operationId,
            daemonInstanceId: IDENTITY.instanceId,
            outcome: "replayed",
            workspaceName: "product workspace",
            documentRevision: 5,
          },
        });
      },
    });

    await expect(
      broker.mutateAppWindow({
        operationId,
        expectedDaemonInstanceId: IDENTITY.instanceId,
        intent: {
          workspaceName: "product workspace",
          expectedDocumentRevision: 4,
          command: { type: "window.focus", windowId: null },
        },
      }),
    ).resolves.toMatchObject({ operationId, outcome: "replayed", documentRevision: 5 });
    const mutationRequests = requests.filter(({ url }) =>
      url.endsWith("/api/v2/action/workspace.app-window.mutate"),
    );
    expect(mutationRequests).toHaveLength(2);
    for (const request of mutationRequests) {
      expect(new Headers(request.init?.headers).get("x-tmux-ide-operation-id")).toBe(operationId);
      expect(new Headers(request.init?.headers).get("authorization")).toBe(
        "Bearer owner-only-token",
      );
    }
  });

  it("does not replay a deterministic AppWindow revision conflict", async () => {
    const requests: string[] = [];
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async (input) => {
        const url = input.toString();
        requests.push(url);
        if (url.endsWith("/api/resources/workspace-catalog")) return json(WORKSPACE_CATALOG);
        return json({
          ok: false,
          error: {
            code: "workspace_resource_changed",
            message: "The workspace layout changed.",
          },
        });
      },
    });

    await expect(
      broker.mutateAppWindow({
        operationId: "40000000-0000-4000-8000-000000000004",
        expectedDaemonInstanceId: IDENTITY.instanceId,
        intent: {
          workspaceName: "product workspace",
          expectedDocumentRevision: 4,
          command: { type: "window.focus", windowId: null },
        },
      }),
    ).rejects.toMatchObject({ error: { code: "resource-changed" } });
    expect(
      requests.filter((url) => url.endsWith("/api/v2/action/workspace.app-window.mutate")),
    ).toHaveLength(1);
  });

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

  it("replays one host-authored workspace open across a transport retry", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const operationId = "20000000-0000-4000-8000-000000000002";
    let attempt = 0;
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async (input, init) => {
        requests.push({ url: input.toString(), init });
        attempt += 1;
        if (attempt === 1) throw new Error("transport timeout after workspace commit");
        return json({
          ok: true,
          result: {
            operationId,
            daemonInstanceId: IDENTITY.instanceId,
            outcome: "replayed",
            resource: {
              resourceVersion: 1,
              workspaceName: "project-00112233445566778899aabbccddeeff",
              initialPaneId: "pane.workspace.00112233445566778899aabbccddeeff",
            },
          },
        });
      },
    });

    await expect(
      broker.openWorkspace({
        operationId,
        expectedDaemonInstanceId: IDENTITY.instanceId,
        intent: { projectDir: "/selected/private/project" },
      }),
    ).resolves.toMatchObject({ operationId, outcome: "replayed" });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe("http://127.0.0.1:6060/api/v2/action/workspace.open");
      expect(new Headers(request.init?.headers).get("authorization")).toBe(
        "Bearer owner-only-token",
      );
      expect(new Headers(request.init?.headers).get("x-tmux-ide-operation-id")).toBe(operationId);
      expect(JSON.parse(String(request.init?.body))).toEqual({
        projectDir: "/selected/private/project",
      });
    }
  });

  it.each(["http://127.0.0.1:5173", DESKTOP_PACKAGED_RENDERER_ORIGIN])(
    "issues a bounded terminal attachment for renderer origin %s against only the exact owner-authorized endpoint",
    async (rendererOrigin) => {
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
        effectiveGeometryOwnership: "passive" as const,
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
          geometryOwnership: "passive" as const,
          viewport: { cols: 120, rows: 40 },
        },
      };

      await expect(broker.issueTerminalAttachment(mutation, rendererOrigin)).resolves.toEqual({
        status: "issued",
        descriptor,
      });
      expect(requests).toHaveLength(1);
      const sent = requests[0]!;
      expect(sent.url).toBe(`${CONNECTED.descriptor.apiBaseUrl}${TERMINAL_ATTACHMENT_ISSUE_PATH}`);
      expect(sent.init).toMatchObject({
        method: "POST",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      });
      const headers = new Headers(sent.init?.headers);
      expect(headers.get("authorization")).toBe("Bearer owner-only-token");
      expect(headers.get("origin")).toBe(rendererOrigin);
      expect(headers.get("x-tmux-ide-request-id")).toBe(requestId);
      expect(headers.get("x-tmux-ide-expected-daemon-instance-id")).toBe(IDENTITY.instanceId);
      expect(JSON.parse(String(sent.init?.body))).toEqual(mutation);
      expect(JSON.stringify(sent)).not.toContain(descriptor.redemptionTicket);
    },
  );

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
            geometryOwnership: "passive",
            viewport: { cols: 120, rows: 40 },
          },
        },
        "http://127.0.0.1:5173",
      ),
    ).resolves.toMatchObject({ status: "error", error: { code: "daemon-unavailable" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a daemon that grants geometry ownership the renderer did not ask for", async () => {
    /*
     * Bug this catches: the renderer asks for a passive attachment — a mirror, a
     * peek at a pane someone else is working in — and the daemon comes back with
     * an owning one. Nothing downstream would notice: the surface renders the
     * same either way, and the first symptom is a colleague's window silently
     * reflowing to the size of a card in someone else's app.
     *
     * The broker already refuses viewer-mode drift for the same reason. This is
     * the second axis of the same authority.
     */
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async () =>
        json({
          status: "issued",
          descriptor: {
            protocolVersion: 1 as const,
            webSocketUrl: "ws://127.0.0.1:6060/v1/terminal/attachments/redeem",
            subprotocol: "tmux-ide-terminal.v1" as const,
            redemptionTicket: `ta1_${"A".repeat(43)}`,
            daemonInstanceId: IDENTITY.instanceId,
            requestId: "10000000-0000-4000-8000-000000000001",
            expiresAt: Date.now() + 30_000,
            effectiveViewerMode: "interactive" as const,
            effectiveGeometryOwnership: "owner" as const,
          },
        }),
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
            geometryOwnership: "passive",
            viewport: { cols: 120, rows: 40 },
          },
        },
        "http://127.0.0.1:5173",
      ),
    ).resolves.toMatchObject({ status: "error", error: { code: "daemon-identity-mismatch" } });
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
          geometryOwnership: "passive",
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
            geometryOwnership: "passive",
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
    expect(events).toEqual([
      { type: "transport.changed", transport: { phase: "connecting" } },
      { type: "transport.changed", transport: { phase: "connected" } },
      { type: "connection.changed", state: "live", error: null },
    ]);

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
      if (url.endsWith("/api/resources/workspace-catalog")) return json(WORKSPACE_CATALOG);
      if (url.endsWith("application-shell?version=3")) {
        return json({ error: "Unsupported resource version" }, { status: 400 });
      }
      return json(APPLICATION_SHELL_ENVELOPE);
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
      "http://127.0.0.1:6060/api/project/server%2Fsession%3A42/application-shell?version=3",
      "http://127.0.0.1:6060/api/project/server%2Fsession%3A42/application-shell?version=2",
    ]);
    expect(requests.every(({ init }) => init?.method === "GET" && init.redirect === "error")).toBe(
      true,
    );
    expect(JSON.stringify(requests.map(({ init }) => init?.headers))).not.toMatch(/bearer|token/iu);
  });

  it("honors an explicit V2 request without probing V3", async () => {
    const requests: string[] = [];
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      fetch: async (input) => {
        const url = input.toString();
        requests.push(url);
        return url.endsWith("/api/resources/workspace-catalog")
          ? json(WORKSPACE_CATALOG)
          : json(APPLICATION_SHELL_ENVELOPE);
      },
    });

    await expect(
      broker.fetchApplicationShell("product workspace", APPLICATION_SHELL_RESOURCE_V2_VERSION),
    ).resolves.toEqual({ status: "ok", envelope: APPLICATION_SHELL_ENVELOPE });
    expect(requests).toEqual([
      "http://127.0.0.1:6060/api/resources/workspace-catalog",
      "http://127.0.0.1:6060/api/project/server%2Fsession%3A42/application-shell?version=2",
    ]);
  });

  it("returns V3 directly when the daemon supports it", async () => {
    const requests: string[] = [];
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      fetch: async (input) => {
        const url = input.toString();
        requests.push(url);
        return url.endsWith("/api/resources/workspace-catalog")
          ? json(WORKSPACE_CATALOG)
          : json(APPLICATION_SHELL_V3_ENVELOPE);
      },
    });

    await expect(
      broker.fetchApplicationShell("product workspace", APPLICATION_SHELL_RESOURCE_V3_VERSION),
    ).resolves.toEqual({ status: "ok", envelope: APPLICATION_SHELL_V3_ENVELOPE });
    expect(requests.at(-1)).toContain("application-shell?version=3");
    expect(requests).toHaveLength(2);
  });

  it("accepts the schema-maximum app-window document above the generic response cap", async () => {
    const envelope = maximumApplicationShellV3Envelope();
    const serialized = JSON.stringify(envelope);
    const payloadBytes = new TextEncoder().encode(serialized).byteLength;
    expect(MAXIMUM_APP_WINDOW_TIMESTAMP).toHaveLength(APP_WINDOW_TIMESTAMP_MAX_LENGTH);
    expect(payloadBytes).toBeGreaterThan(1024 * 1024);
    expect(payloadBytes).toBeLessThanOrEqual(APPLICATION_SHELL_V3_MAX_RESPONSE_BYTES);
    expect(APPLICATION_SHELL_V3_MAX_RESPONSE_BYTES - payloadBytes).toBeGreaterThan(5 * 1024 * 1024);
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      fetch: async (input) =>
        input.toString().endsWith("/api/resources/workspace-catalog")
          ? json(WORKSPACE_CATALOG)
          : new Response(serialized, { headers: { "content-type": "application/json" } }),
    });

    const result = await broker.fetchApplicationShell(
      "product workspace",
      APPLICATION_SHELL_RESOURCE_V3_VERSION,
    );
    expect(result.status).toBe("ok");
    if (
      result.status === "ok" &&
      result.envelope.version === APPLICATION_SHELL_RESOURCE_V3_VERSION
    ) {
      expect(Object.keys(result.envelope.resource.appWindows.windows)).toHaveLength(
        APP_WINDOW_MAX_WINDOWS,
      );
      expect(Object.keys(result.envelope.resource.appWindows.layouts)).toHaveLength(
        APP_WINDOW_MAX_LAYOUTS,
      );
    }
  });

  it("rejects a V3 response one byte beyond its dedicated ceiling", async () => {
    const requests: string[] = [];
    const oversizedBody = `"${"x".repeat(APPLICATION_SHELL_V3_MAX_RESPONSE_BYTES - 1)}"`;
    expect(new TextEncoder().encode(oversizedBody)).toHaveLength(
      APPLICATION_SHELL_V3_MAX_RESPONSE_BYTES + 1,
    );
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      fetch: async (input) => {
        const url = input.toString();
        requests.push(url);
        if (url.endsWith("/api/resources/workspace-catalog")) return json(WORKSPACE_CATALOG);
        return new Response(oversizedBody, { headers: { "content-type": "application/json" } });
      },
    });

    await expect(
      broker.fetchApplicationShell("product workspace", APPLICATION_SHELL_RESOURCE_V3_VERSION),
    ).resolves.toMatchObject({
      status: "error",
      error: { code: "response-too-large" },
    });
    expect(requests).toHaveLength(2);
    expect(requests.at(-1)).toContain("application-shell?version=3");
  });

  it("keeps V2 application-shell responses on the generic one MiB ceiling", async () => {
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      fetch: async (input) =>
        input.toString().endsWith("/api/resources/workspace-catalog")
          ? json(WORKSPACE_CATALOG)
          : new Response("{}", {
              headers: {
                "content-type": "application/json",
                "content-length": String(1024 * 1024 + 1),
              },
            }),
    });

    await expect(
      broker.fetchApplicationShell("product workspace", APPLICATION_SHELL_RESOURCE_V2_VERSION),
    ).resolves.toMatchObject({
      status: "error",
      error: { code: "response-too-large" },
    });
  });

  it("classifies a bounded malformed V3 envelope without exposing parser details", async () => {
    const malformed = {
      ...APPLICATION_SHELL_V3_ENVELOPE,
      resource: {
        ...APPLICATION_SHELL_V3_ENVELOPE.resource,
        appWindows: { ...APPLICATION_SHELL_V3_ENVELOPE.resource.appWindows, unexpected: true },
      },
    };
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      fetch: async (input) =>
        input.toString().endsWith("/api/resources/workspace-catalog")
          ? json(WORKSPACE_CATALOG)
          : json(malformed),
    });

    await expect(
      broker.fetchApplicationShell("product workspace", APPLICATION_SHELL_RESOURCE_V3_VERSION),
    ).resolves.toEqual({
      status: "error",
      error: {
        code: "invalid-response",
        reason: "The daemon returned an invalid resource response.",
      },
    });
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
    expect(second).toEqual([
      { type: "transport.changed", transport: { phase: "connected" } },
      { type: "connection.changed", state: "live", error: null },
    ]);
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
      expect(events.filter((event) => event.type === "connection.changed").at(-1)).toMatchObject({
        state: "degraded",
        error: { code: "invalid-response" },
      });
      expect(events.at(-1)).toMatchObject({
        type: "transport.changed",
        transport: { phase: "reconnecting", attempt: 1 },
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
        expect(events.filter((event) => event.type === "connection.changed").at(-1)).toMatchObject({
          state: "degraded",
          error: { code: "event-unavailable" },
        });
        expect(events.at(-1)).toMatchObject({
          type: "transport.changed",
          transport: { phase: "reconnecting", attempt: 1 },
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
        releasedEvents.length = 0;
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
    expect(events.filter((event) => event.type === "connection.changed").at(-1)).toMatchObject({
      error: { code: "event-unavailable" },
    });
    expect(events.at(-1)).toMatchObject({
      type: "transport.changed",
      transport: { phase: "reconnecting", attempt: 1, maximumAttempts: 4 },
    });
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

  it("surfaces the fatal retry ceiling as a stopped transport instead of dying silently", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const createWebSocket = vi.fn(() => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      });
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
      sockets[0]!.emit("close");
      await vi.advanceTimersByTimeAsync(10);
      sockets[1]!.emit("close");
      expect(events.at(-1)).toEqual({
        type: "transport.changed",
        transport: {
          phase: "stopped",
          error: { code: "event-unavailable", reason: expect.any(String) },
        },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(createWebSocket).toHaveBeenCalledTimes(2);
      if (result.status === "subscribed") result.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("wakes a stopped transport on an explicit retry and reconnects immediately", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const createWebSocket = vi.fn(() => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      });
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
      sockets[0]!.emit("close");
      await vi.advanceTimersByTimeAsync(10);
      sockets[1]!.emit("close");
      expect(events.at(-1)).toMatchObject({
        type: "transport.changed",
        transport: { phase: "stopped" },
      });

      broker.retryTransport();
      expect(createWebSocket).toHaveBeenCalledTimes(3);
      sockets[2]!.emit("open");
      sockets[2]!.emit(
        "message",
        JSON.stringify({ type: "hello", daemon: IDENTITY, sessions: [] }),
      );
      expect(events.at(-1)).toEqual({ type: "connection.changed", state: "live", error: null });
      expect(broker.transportState()).toEqual({ phase: "connected" });
      if (result.status === "subscribed") result.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("interrupts a scheduled backoff on an explicit transport wakeup", async () => {
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
        eventReconnectInitialDelayMs: 5_000,
        eventReconnectMaximumDelayMs: 5_000,
        eventReconnectMaximumAttempts: 2,
      });
      const result = await broker.subscribe([], vi.fn());
      sockets[0]!.emit("close");
      expect(broker.transportState()).toMatchObject({ phase: "reconnecting", attempt: 1 });
      broker.retryTransport();
      expect(createWebSocket).toHaveBeenCalledTimes(2);
      sockets[1]!.emit("open");
      sockets[1]!.emit(
        "message",
        JSON.stringify({ type: "hello", daemon: IDENTITY, sessions: [] }),
      );
      // The interrupted backoff timer never spawns a parallel socket.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(createWebSocket).toHaveBeenCalledTimes(2);
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
      expect(events.filter((event) => event.type === "connection.changed").at(-1)).toMatchObject({
        state: "degraded",
      });
      expect(events.at(-1)).toMatchObject({
        type: "transport.changed",
        transport: { phase: "reconnecting", attempt: 1 },
      });
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
      expect(events.filter((event) => event.type === "connection.changed").at(-1)).toMatchObject({
        state: "degraded",
        error: { code: "daemon-identity-mismatch" },
      });
      expect(events.at(-1)).toMatchObject({
        type: "transport.changed",
        transport: { phase: "reconnecting", attempt: 1 },
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

const FILES_CATALOG_ENVELOPE = {
  version: 1,
  daemon: IDENTITY,
  resource: {
    status: "ready" as const,
    workspaceName: "product workspace",
    revision: "files-rev.revrevrevrevrev01",
    rootId: "file.rootrootrootroot01",
    directory: {
      id: "file.rootrootrootroot01",
      name: "product",
      relativePath: null,
      parentId: null,
    },
    breadcrumbs: [{ id: "file.rootrootrootroot01", label: "product" }],
    entries: [
      {
        id: "file.entryentryentry001",
        parentId: "file.rootrootrootroot01",
        name: "README.md",
        relativePath: "README.md",
        kind: "file" as const,
        hidden: false,
        ignored: false,
        hasChildren: false,
        gitStatus: null,
      },
    ],
    totalEntries: 1,
    truncated: false,
  },
};

const FILE_PREVIEW_ENVELOPE = {
  version: 1,
  daemon: IDENTITY,
  resource: {
    status: "ready" as const,
    workspaceName: "product workspace",
    catalogRevision: "files-rev.revrevrevrevrev01",
    fileId: "file.entryentryentry001",
    name: "README.md",
    relativePath: "README.md",
    encoding: "utf-8" as const,
    languageHint: "markdown",
    content: "# Title\n",
    totalBytes: 8,
    totalLines: 2,
    truncated: false,
  },
};

const CHANGES_CATALOG_ENVELOPE = {
  version: 1,
  daemon: IDENTITY,
  resource: {
    status: "ready" as const,
    workspaceName: "product workspace",
    revision: "changes-rev.revrevrevrevrev01",
    branch: "main",
    detached: false,
    entries: [
      {
        id: "change.changechangechange01",
        group: "unstaged" as const,
        status: "modified" as const,
        name: "README.md",
        relativePath: "README.md",
        originPath: null,
        binary: false,
        additions: 3,
        deletions: 1,
      },
    ],
    totalEntries: 1,
    truncated: false,
  },
};

const CHANGE_DIFF_ENVELOPE = {
  version: 1,
  daemon: IDENTITY,
  resource: {
    status: "ready" as const,
    workspaceName: "product workspace",
    changesRevision: "changes-rev.revrevrevrevrev01",
    changeId: "change.changechangechange01",
    group: "unstaged" as const,
    relativePath: "README.md",
    originPath: null,
    hunks: [
      {
        header: "@@ -1 +1 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { kind: "delete" as const, content: "old", oldLine: 1, newLine: null },
          { kind: "insert" as const, content: "new", oldLine: null, newLine: 1 },
        ],
      },
    ],
    totalHunks: 1,
    totalLines: 2,
    truncated: false,
  },
};

describe("Electron main daemon workspace read resources", () => {
  it("authenticates a files catalog read and routes by encoded workspace name", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async (input, init) => {
        const url = input.toString();
        requests.push({ url, init });
        if (url.endsWith("/api/resources/workspace-catalog")) return json(WORKSPACE_CATALOG);
        return json(FILES_CATALOG_ENVELOPE);
      },
    });
    const result = await broker.fetchWorkspaceFiles({ workspaceName: "product workspace" });
    expect(result).toMatchObject({ status: "ok", envelope: { resource: { status: "ready" } } });
    const filesRequest = requests.find(({ url }) => url.includes("/files"));
    expect(filesRequest?.url).toBe("http://127.0.0.1:6060/api/project/product%20workspace/files");
    expect(new Headers(filesRequest?.init?.headers).get("authorization")).toBe(
      "Bearer owner-only-token",
    );
  });

  it("passes a directory id as a query for incremental tree expansion", async () => {
    const requests: string[] = [];
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async (input) => {
        const url = input.toString();
        requests.push(url);
        if (url.endsWith("/api/resources/workspace-catalog")) return json(WORKSPACE_CATALOG);
        return json(FILES_CATALOG_ENVELOPE);
      },
    });
    await broker.fetchWorkspaceFiles({
      workspaceName: "product workspace",
      directoryId: "file.rootrootrootroot01",
    });
    expect(requests).toContain(
      "http://127.0.0.1:6060/api/project/product%20workspace/files?directoryId=file.rootrootrootroot01",
    );
  });

  it("maps an unknown workspace to workspace-not-found without a resource request", async () => {
    const requests: string[] = [];
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async (input) => {
        requests.push(input.toString());
        return json(WORKSPACE_CATALOG);
      },
    });
    await expect(broker.fetchWorkspaceChanges({ workspaceName: "ghost" })).resolves.toMatchObject({
      status: "error",
      error: { code: "workspace-not-found" },
    });
    expect(requests.some((url) => url.includes("/changes"))).toBe(false);
  });

  it("refuses a read without an owner capability", async () => {
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      fetch: async () => json(WORKSPACE_CATALOG),
    });
    await expect(
      broker.fetchWorkspaceFiles({ workspaceName: "product workspace" }),
    ).resolves.toMatchObject({ status: "error", error: { code: "daemon-unavailable" } });
  });

  it("rejects a files catalog stamped by another daemon generation", async () => {
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async (input) => {
        const url = input.toString();
        if (url.endsWith("/api/resources/workspace-catalog")) return json(WORKSPACE_CATALOG);
        return json({
          ...FILES_CATALOG_ENVELOPE,
          daemon: { ...IDENTITY, instanceId: "00000000-0000-4000-8000-000000000099" },
        });
      },
    });
    await expect(
      broker.fetchWorkspaceFiles({ workspaceName: "product workspace" }),
    ).resolves.toMatchObject({ status: "error", error: { code: "daemon-identity-mismatch" } });
  });

  it("rejects a malformed resource envelope", async () => {
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async (input) => {
        const url = input.toString();
        if (url.endsWith("/api/resources/workspace-catalog")) return json(WORKSPACE_CATALOG);
        return json({ version: 1, daemon: IDENTITY, resource: { status: "bogus" } });
      },
    });
    await expect(
      broker.fetchWorkspaceChangeDiff({
        workspaceName: "product workspace",
        changeId: "change.changechangechange01",
      }),
    ).resolves.toMatchObject({ status: "error", error: { code: "invalid-response" } });
  });

  it("reads a file preview and a change diff over authenticated query routes", async () => {
    const requests: string[] = [];
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async (input) => {
        const url = input.toString();
        requests.push(url);
        if (url.endsWith("/api/resources/workspace-catalog")) return json(WORKSPACE_CATALOG);
        if (url.includes("/file-preview")) return json(FILE_PREVIEW_ENVELOPE);
        if (url.includes("/change-diff")) return json(CHANGE_DIFF_ENVELOPE);
        return json(CHANGES_CATALOG_ENVELOPE);
      },
    });
    await expect(
      broker.fetchWorkspaceFilePreview({
        workspaceName: "product workspace",
        fileId: "file.entryentryentry001",
      }),
    ).resolves.toMatchObject({ status: "ok", envelope: { resource: { status: "ready" } } });
    await expect(
      broker.fetchWorkspaceChangeDiff({
        workspaceName: "product workspace",
        changeId: "change.changechangechange01",
      }),
    ).resolves.toMatchObject({ status: "ok", envelope: { resource: { status: "ready" } } });
    await expect(
      broker.fetchWorkspaceChanges({ workspaceName: "product workspace" }),
    ).resolves.toMatchObject({ status: "ok", envelope: { resource: { status: "ready" } } });
    expect(requests).toContain(
      "http://127.0.0.1:6060/api/project/product%20workspace/file-preview?fileId=file.entryentryentry001",
    );
    expect(requests).toContain(
      "http://127.0.0.1:6060/api/project/product%20workspace/change-diff?changeId=change.changechangechange01",
    );
  });

  it("reads the owner-gated fleet catalog and rejects a foreign daemon generation", async () => {
    const fleetCatalog = {
      version: 1,
      daemon: IDENTITY,
      sessions: [
        {
          sessionId: "session.aaaaaaaaaaaaaaaa",
          label: "web",
          projectLabel: "web-app",
          appCreated: true,
          paneCount: 3,
          agents: [
            {
              agentId: "agent.aaaaaaaaaaaaaaaa",
              name: "Claude",
              harness: "claude-code",
              activity: "running",
              attention: false,
              statusSource: "authority",
            },
          ],
        },
      ],
    };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async (input, init) => {
        requests.push({ url: input.toString(), init });
        return json(fleetCatalog);
      },
    });

    await expect(broker.fetchFleetCatalog()).resolves.toEqual({
      status: "ok",
      envelope: fleetCatalog,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("http://127.0.0.1:6060/api/resources/fleet-catalog");
    expect(new Headers(requests[0]!.init?.headers).get("authorization")).toBe(
      "Bearer owner-only-token",
    );

    const foreign = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async () =>
        json({ ...fleetCatalog, daemon: { ...IDENTITY, instanceId: crypto.randomUUID() } }),
    });
    await expect(foreign.fetchFleetCatalog()).resolves.toMatchObject({
      status: "error",
      error: { code: "daemon-identity-mismatch" },
    });
  });

  it("refuses a fleet catalog read without the owner secret", async () => {
    const fetch = vi.fn();
    const broker = new DaemonResourceBroker({ daemon: CONNECTED, fetch });
    await expect(broker.fetchFleetCatalog()).resolves.toMatchObject({
      status: "error",
      error: { code: "daemon-unavailable" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("replays one host-authored workspace promotion across a transport retry", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const operationId = "30000000-0000-4000-8000-000000000003";
    let attempt = 0;
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async (input, init) => {
        requests.push({ url: input.toString(), init });
        attempt += 1;
        if (attempt === 1) throw new Error("transport timeout after promotion commit");
        return json({
          ok: true,
          result: {
            operationId,
            daemonInstanceId: IDENTITY.instanceId,
            outcome: "replayed",
            resource: { resourceVersion: 1, workspaceName: "web" },
          },
        });
      },
    });

    await expect(
      broker.promoteWorkspace({
        operationId,
        expectedDaemonInstanceId: IDENTITY.instanceId,
        intent: { sessionId: "session.aaaaaaaaaaaaaaaa" },
      }),
    ).resolves.toMatchObject({ operationId, outcome: "replayed" });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe("http://127.0.0.1:6060/api/v2/action/workspace.promote");
      expect(new Headers(request.init?.headers).get("authorization")).toBe(
        "Bearer owner-only-token",
      );
      expect(new Headers(request.init?.headers).get("x-tmux-ide-operation-id")).toBe(operationId);
      expect(JSON.parse(String(request.init?.body))).toEqual({
        sessionId: "session.aaaaaaaaaaaaaaaa",
      });
    }
  });

  it("surfaces a typed promotion verdict without retrying it", async () => {
    const operationId = "40000000-0000-4000-8000-000000000004";
    let attempts = 0;
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async () => {
        attempts += 1;
        // The daemon's typed `{ ok: false }` verdict is HTTP 200 by contract.
        return json({
          ok: false,
          error: {
            code: "promotion_verification_failed",
            message: "The promoted session did not pass admission verification.",
            details: { reason: "project_directory_unavailable" },
          },
        });
      },
    });

    const error = await broker
      .promoteWorkspace({
        operationId,
        expectedDaemonInstanceId: IDENTITY.instanceId,
        intent: { sessionId: "session.aaaaaaaaaaaaaaaa" },
      })
      .then(
        () => null,
        (rejection: unknown) => rejection,
      );

    // A deterministic verdict is thrown as a typed promotion failure and never retried.
    expect(attempts).toBe(1);
    expect(workspacePromotionFailureFromUnknown(error)).toEqual({
      kind: "promotion",
      code: "promotion_verification_failed",
      reason: "project_directory_unavailable",
    });
  });

  it("treats an unknown ok:false code as a generic transport failure, not a typed verdict", async () => {
    const operationId = "40000000-0000-4000-8000-000000000005";
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async () => json({ ok: false, error: { code: "internal", message: "boom" } }),
    });

    const error = await broker
      .promoteWorkspace({
        operationId,
        expectedDaemonInstanceId: IDENTITY.instanceId,
        intent: { sessionId: "session.aaaaaaaaaaaaaaaa" },
      })
      .then(
        () => null,
        (rejection: unknown) => rejection,
      );

    // An unrecognized code carries no promotion taxonomy — the caller falls back
    // to the generic transport line rather than inventing a typed reason.
    expect(workspacePromotionFailureFromUnknown(error)).toBeNull();
  });

  it("folds daemon fleet.changed and agent-status.changed frames into one renderer fleet invalidation", async () => {
    const socket = new FakeSocket();
    const events: DesktopDaemonEvent[] = [];
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      fetch: async () => json(WORKSPACE_CATALOG),
      createWebSocket: () => socket,
    });
    const result = await broker.subscribe(["docs"], (event) => events.push(event));
    expect(result.status).toBe("subscribed");
    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "hello", daemon: IDENTITY, sessions: [] }));

    socket.emit("message", JSON.stringify({ type: "fleet.changed" }));
    expect(events.at(-1)).toEqual({ type: "fleet.changed" });

    socket.emit(
      "message",
      JSON.stringify({ type: "agent-status.changed", sessionName: "durable-docs" }),
    );
    // Session-scoped status refreshes the open workspace AND the whole fleet.
    expect(events).toContainEqual({ type: "application-shell.changed", workspaceName: "docs" });
    expect(events.at(-1)).toEqual({ type: "fleet.changed" });
    // A raw tmux session name never crosses to the renderer.
    expect(JSON.stringify(events)).not.toMatch(/durable-docs|sessionName/iu);
    if (result.status === "subscribed") result.unsubscribe();
  });

  it("folds agent-status.changed into fleet.changed for an empty-set (fleet catalog) subscription", async () => {
    // The fleet-catalog store subscribes with an empty workspace set. It receives
    // NO application-shell.changed (those are workspace-filtered), but MUST still
    // receive the fleet-wide fleet.changed folded from a session-scoped
    // agent-status.changed — this is the whole status-push path for the sidebar.
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
    events.length = 0;

    socket.emit(
      "message",
      JSON.stringify({ type: "agent-status.changed", sessionName: "durable-docs" }),
    );

    // The empty-set subscription sees the fleet invalidation but never a
    // workspace-scoped application-shell.changed, and no raw session name leaks.
    expect(events).toEqual([{ type: "fleet.changed" }]);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "application-shell.changed" }),
    );
    expect(JSON.stringify(events)).not.toMatch(/durable-docs|sessionName/iu);
    if (result.status === "subscribed") result.unsubscribe();
  });
});

describe("Electron main pane-stream issuance (m43 card 3)", () => {
  const now = 1_784_662_800_000;
  const requestId = "10000000-0000-4000-8000-000000000002";
  const panes = ["pane.workspace.a1", "pane.workspace.b2"] as const;

  function paneStreamDescriptor(overrides: Record<string, unknown> = {}) {
    return {
      protocolVersion: 1 as const,
      webSocketUrl: "ws://127.0.0.1:6060/v1/terminal/pane-streams/redeem",
      subprotocol: "tmux-ide-pane-stream.v1" as const,
      redemptionTicket: `ps1_${"B".repeat(43)}`,
      daemonInstanceId: IDENTITY.instanceId,
      requestId,
      expiresAt: now + 15_000,
      panes: [...panes],
      effectiveViewerMode: "read-only" as const,
      ...overrides,
    };
  }

  function paneStreamMutation() {
    return {
      requestId,
      expectedDaemonInstanceId: IDENTITY.instanceId,
      stream: {
        protocolVersion: 1 as const,
        workspaceName: "product",
        panes: [...panes],
        viewerMode: "read-only" as const,
      },
    };
  }

  it.each(["http://127.0.0.1:5173", DESKTOP_PACKAGED_RENDERER_ORIGIN])(
    "issues a bounded pane stream for renderer origin %s against the exact owner-authorized endpoint",
    async (rendererOrigin) => {
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      const descriptor = paneStreamDescriptor();
      const broker = new DaemonResourceBroker({
        daemon: CONNECTED,
        ownerToken: "owner-only-token",
        now: () => now,
        fetch: async (input, init) => {
          requests.push({ url: input.toString(), init });
          return json({ status: "issued", descriptor });
        },
      });

      await expect(broker.issuePaneStream(paneStreamMutation(), rendererOrigin)).resolves.toEqual({
        status: "issued",
        descriptor,
      });
      expect(requests).toHaveLength(1);
      const sent = requests[0]!;
      expect(sent.url).toBe(`${CONNECTED.descriptor.apiBaseUrl}${PANE_STREAM_ISSUE_PATH}`);
      expect(sent.init).toMatchObject({
        method: "POST",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      });
      const headers = new Headers(sent.init?.headers);
      expect(headers.get("authorization")).toBe("Bearer owner-only-token");
      expect(headers.get("origin")).toBe(rendererOrigin);
      expect(headers.get("x-tmux-ide-request-id")).toBe(requestId);
      expect(headers.get("x-tmux-ide-expected-daemon-instance-id")).toBe(IDENTITY.instanceId);
      expect(JSON.parse(String(sent.init?.body))).toEqual(paneStreamMutation());
      expect(JSON.stringify(sent)).not.toContain(descriptor.redemptionTicket);
    },
  );

  it("requires the canonical owner secret before any request leaves the broker", async () => {
    const fetch = vi.fn();
    const broker = new DaemonResourceBroker({ daemon: CONNECTED, fetch });
    await expect(
      broker.issuePaneStream(paneStreamMutation(), "http://127.0.0.1:5173"),
    ).resolves.toMatchObject({ status: "error", error: { code: "daemon-unavailable" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a stale expected daemon generation without a network request", async () => {
    const fetch = vi.fn();
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch,
    });
    await expect(
      broker.issuePaneStream(
        {
          ...paneStreamMutation(),
          expectedDaemonInstanceId: "00000000-0000-4000-8000-00000000dead",
        },
        "http://127.0.0.1:5173",
      ),
    ).resolves.toMatchObject({ status: "error", error: { code: "daemon-identity-mismatch" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["another daemon generation", { daemonInstanceId: "3d1a1f1e-4242-4b3a-9c37-abcabcabcabc" }],
    ["a foreign request id", { requestId: "10000000-0000-4000-8000-00000000ffff" }],
    ["a viewer-mode drift", { effectiveViewerMode: "interactive" }],
    ["a mutated pane set", { panes: [panes[1], panes[0]] }],
    ["an expired descriptor", { expiresAt: now - 1 }],
    ["an over-lifetime descriptor", { expiresAt: now + 61_000 }],
  ])("rejects a descriptor carrying %s", async (_label, overrides) => {
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      now: () => now,
      fetch: async () => json({ status: "issued", descriptor: paneStreamDescriptor(overrides) }),
    });
    await expect(
      broker.issuePaneStream(paneStreamMutation(), "http://127.0.0.1:5173"),
    ).resolves.toMatchObject({ status: "error", error: { code: "daemon-identity-mismatch" } });
  });

  it("passes the daemon's typed pane-stream verdict through with fixed renderer copy", async () => {
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async () =>
        json({
          status: "error",
          error: { code: "pane-not-found", reason: "raw daemon words", retryable: false },
        }),
    });
    const result = await broker.issuePaneStream(paneStreamMutation(), "http://127.0.0.1:5173");
    expect(result).toMatchObject({
      status: "error",
      error: {
        code: "pane-not-found",
        reason: "A requested pane is unavailable.",
        retryable: false,
      },
    });
  });

  it("accepts a pre-merge daemon's legacy pane-stream code", async () => {
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async () =>
        json({
          status: "error",
          error: { code: "stream-unavailable", reason: "old daemon words", retryable: true },
        }),
    });
    await expect(
      broker.issuePaneStream(paneStreamMutation(), "http://127.0.0.1:5173"),
    ).resolves.toMatchObject({
      status: "error",
      error: { code: "attachment-unavailable", reason: "Pane streaming is unavailable." },
    });
  });

  it("forwards a timed-out broker fault instead of flattening it", async () => {
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      requestTimeoutMs: 5,
      fetch: async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    await expect(
      broker.issuePaneStream(paneStreamMutation(), "http://127.0.0.1:5173"),
    ).resolves.toMatchObject({ status: "error", error: { code: "request-timeout" } });
  });

  it("names an unparseable issue response for what it is", async () => {
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch: async () => json({ status: "weird" }),
    });
    await expect(
      broker.issuePaneStream(paneStreamMutation(), "http://127.0.0.1:5173"),
    ).resolves.toMatchObject({ status: "error", error: { code: "invalid-response" } });
  });

  it("applies the narrow response bound to pane-stream issuance", async () => {
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
      broker.issuePaneStream(paneStreamMutation(), "http://127.0.0.1:5173"),
    ).resolves.toMatchObject({ status: "error", error: { code: "response-too-large" } });
  });

  it("rejects an unusable renderer origin before contacting the daemon", async () => {
    const fetch = vi.fn();
    const broker = new DaemonResourceBroker({
      daemon: CONNECTED,
      ownerToken: "owner-only-token",
      fetch,
    });
    await expect(broker.issuePaneStream(paneStreamMutation(), "null")).resolves.toMatchObject({
      status: "error",
      error: { code: "invalid-request" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
