import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonEventServerFrame, DaemonInstanceIdentity } from "@tmux-ide/contracts";

import {
  createDevWebHostCapabilities,
  projectDaemonServerFrame,
  sameIdentity,
  type DevWorkspaceCatalogEntry,
} from "./dev-web-host.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CATALOG: readonly DevWorkspaceCatalogEntry[] = [
  { workspaceName: "alpha", sessionName: "alpha-session" },
  { workspaceName: "beta", sessionName: "beta-session" },
];

const IDENTITY: DaemonInstanceIdentity = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "11111111-1111-4111-8111-111111111111",
  startedAt: "2026-08-04T00:00:00.000Z",
};

function frame(value: unknown): DaemonEventServerFrame {
  return value as DaemonEventServerFrame;
}

describe("sameIdentity", () => {
  it("matches only on the whole generation tuple", () => {
    expect(sameIdentity(IDENTITY, { ...IDENTITY })).toBe(true);
    expect(sameIdentity(IDENTITY, { ...IDENTITY, startedAt: "2026-08-05T00:00:00.000Z" })).toBe(
      false,
    );
    expect(sameIdentity(IDENTITY, { ...IDENTITY, instanceId: "other" })).toBe(false);
    expect(sameIdentity(IDENTITY, { ...IDENTITY, productVersion: "2.9.0" })).toBe(false);
    expect(sameIdentity(IDENTITY, { ...IDENTITY, protocolVersion: 2 })).toBe(false);
  });

  it("never matches a missing peer", () => {
    expect(sameIdentity(null, IDENTITY)).toBe(false);
    expect(sameIdentity(IDENTITY, null)).toBe(false);
  });
});

describe("projectDaemonServerFrame", () => {
  it("maps a session-scoped frame onto only that session's workspaces", () => {
    expect(
      projectDaemonServerFrame(
        frame({ type: "terminals.changed", sessionName: "beta-session" }),
        CATALOG,
      ),
    ).toEqual([{ type: "application-shell.changed", workspaceName: "beta" }]);
  });

  it("drops a session-scoped frame for a session no workspace owns", () => {
    expect(
      projectDaemonServerFrame(
        frame({ type: "config.changed", sessionName: "unadopted" }),
        CATALOG,
      ),
    ).toEqual([]);
  });

  it("invalidates the fleet as well as the shell on ground-truth agent status", () => {
    expect(
      projectDaemonServerFrame(
        frame({ type: "agent-status.changed", sessionName: "alpha-session" }),
        CATALOG,
      ),
    ).toEqual([
      { type: "application-shell.changed", workspaceName: "alpha" },
      { type: "fleet.changed" },
    ]);
  });

  it("maps a fleet composition change onto the workspace-free invalidation", () => {
    expect(projectDaemonServerFrame(frame({ type: "fleet.changed" }), CATALOG)).toEqual([
      { type: "fleet.changed" },
    ]);
  });

  it("projects a scoped resource revision onto only its workspace", () => {
    expect(
      projectDaemonServerFrame(
        frame({
          type: "resource.changed",
          sequence: 12,
          workspaceName: "beta",
          resource: "application-shell",
          revision: 4,
          causeOperationId: null,
        }),
        CATALOG,
      ),
    ).toEqual([{ type: "application-shell.changed", workspaceName: "beta" }]);
  });

  it("projects typed workspace resources only with a verified daemon identity", () => {
    const changed = frame({
      type: "resource.changed",
      sequence: 13,
      workspaceName: "alpha",
      resource: "workspace-files",
      revision: 7,
      causeOperationId: null,
    });
    expect(projectDaemonServerFrame(changed, CATALOG, IDENTITY.instanceId)).toEqual([
      {
        type: "workspace-files.changed",
        workspaceName: "alpha",
        daemonInstanceId: IDENTITY.instanceId,
        sequence: 13,
        revision: 7,
        causeOperationId: null,
      },
    ]);
    expect(projectDaemonServerFrame(changed, CATALOG)).toEqual([{ type: "workspaces.changed" }]);
    expect(
      projectDaemonServerFrame(
        frame({ type: "resource.observed", sequence: 14, revision: 7 }),
        CATALOG,
        IDENTITY.instanceId,
      ),
    ).toEqual([]);
  });

  it("falls back to a full refresh when the replay journal reports a gap", () => {
    expect(
      projectDaemonServerFrame(
        frame({
          type: "snapshot-required",
          afterSequence: 1,
          oldestAvailableSequence: 10,
          currentSequence: 20,
          reason: "journal-gap",
        }),
        CATALOG,
      ),
    ).toEqual([
      { type: "workspaces.changed" },
      { type: "application-shell.changed", workspaceName: "alpha" },
      { type: "application-shell.changed", workspaceName: "beta" },
    ]);
  });

  it("invalidates the catalog and every shell on a fleet-wide change", () => {
    expect(projectDaemonServerFrame(frame({ type: "sessions.changed" }), CATALOG)).toEqual([
      { type: "workspaces.changed" },
      { type: "application-shell.changed", workspaceName: "alpha" },
      { type: "application-shell.changed", workspaceName: "beta" },
    ]);
  });

  it("reports a daemon protocol error as a degraded connection", () => {
    expect(
      projectDaemonServerFrame(
        frame({ type: "protocol.error", code: "invalid-frame", message: "bad" }),
        CATALOG,
      ),
    ).toEqual([
      {
        type: "connection.changed",
        state: "degraded",
        error: { code: "protocol-error", reason: "The daemon reported a protocol error." },
      },
    ]);
  });

  it("projects frames the renderer has no resource for onto nothing", () => {
    expect(
      projectDaemonServerFrame(frame({ type: "pong", sentAt: 1, receivedAt: 2 }), CATALOG),
    ).toEqual([]);
    expect(projectDaemonServerFrame(frame({ type: "hello", daemon: IDENTITY }), CATALOG)).toEqual(
      [],
    );
  });
});

describe("development web host route keying", () => {
  const CONFIG = {
    daemonOrigin: "http://127.0.0.1:6060",
    daemonWebSocketOrigin: "ws://127.0.0.1:6060",
    ownerToken: "owner-token",
    transport: "direct" as const,
  };

  /**
   * Records every path the host asks for, answering the identity and catalog
   * reads it needs to get there. The resource read itself answers a shape the
   * envelope schema rejects, which is fine: the assertion is the URL, and a
   * wrong route key is a silent 404 rather than a typed refusal — exactly the
   * failure this proves cannot be chosen per call site any more.
   */
  function recordingHost() {
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      paths.push(`${url.pathname}${url.search}`);
      const body =
        url.pathname === "/api/v2/capabilities"
          ? {
              status: "ok",
              daemon: IDENTITY,
              capabilities: { appWindowMutation: { available: true } },
            }
          : url.pathname === "/api/resources/workspace-catalog"
            ? { version: 1, daemon: IDENTITY, workspaces: [...CATALOG] }
            : { unreadable: true };
      return {
        ok: true,
        status: 200,
        json: async () => body,
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchImpl);
    return { paths, host: createDevWebHostCapabilities(CONFIG) };
  }

  it("keys the application shell on the tmux session name", async () => {
    const { paths, host } = recordingHost();
    await host.daemon.fetchApplicationShell({ workspaceName: "alpha" });
    expect(
      paths.some((path) => path.startsWith("/api/project/alpha-session/application-shell")),
    ).toBe(true);
    expect(paths.some((path) => path.startsWith("/api/project/alpha/application-shell"))).toBe(
      false,
    );
    host.dispose();
  });

  it("keys files, previews, changes and diffs on the workspace name", async () => {
    const { paths, host } = recordingHost();
    await host.daemon.fetchWorkspaceFiles({ workspaceName: "alpha" });
    await host.daemon.fetchWorkspaceChanges({ workspaceName: "alpha" });
    for (const suffix of ["/files", "/changes"]) {
      expect(paths).toContain(`/api/project/alpha${suffix}`);
    }
    expect(paths.some((path) => path.includes("alpha-session"))).toBe(false);
    host.dispose();
  });

  it("keeps the owner bearer out of gateway requests and rewrites redemption sockets", async () => {
    const gatewayConfig = {
      daemonOrigin: "http://127.0.0.1:5173",
      daemonWebSocketOrigin: "ws://127.0.0.1:5173",
      ownerToken: null,
      transport: "same-origin-gateway" as const,
    };
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const requestId = "22222222-2222-4222-8222-222222222222";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input), gatewayConfig.daemonOrigin);
        requests.push({
          url: url.toString(),
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        const body =
          url.pathname === "/__tmux_ide_host_session"
            ? { token: "33333333-3333-4333-8333-333333333333" }
            : url.pathname === "/api/v2/capabilities"
              ? {
                  status: "ok",
                  daemon: IDENTITY,
                  capabilities: { appWindowMutation: { available: true } },
                }
              : {
                  status: "issued",
                  descriptor: {
                    protocolVersion: 1,
                    webSocketUrl: "ws://127.0.0.1:6060/v1/terminal/attachments/redeem",
                    subprotocol: "tmux-ide-terminal.v1",
                    redemptionTicket: `ta1_${"A".repeat(43)}`,
                    daemonInstanceId: IDENTITY.instanceId,
                    requestId,
                    expiresAt: Date.now() + 60_000,
                    effectiveViewerMode: "interactive",
                    effectiveGeometryOwnership: "owner",
                  },
                };
        return {
          ok: true,
          status: 200,
          json: async () => body,
        } as unknown as Response;
      }),
    );

    const host = createDevWebHostCapabilities(gatewayConfig);
    const issued = await host.daemon.issueTerminalAttachment({
      protocolVersion: 1,
      target: { workspaceName: "alpha", semanticPaneId: "pane.alpha" },
      viewerMode: "interactive",
      geometryOwnership: "owner",
      viewport: { cols: 80, rows: 24 },
    });

    expect(issued.status).toBe("issued");
    if (issued.status === "issued") {
      expect(issued.descriptor.webSocketUrl).toBe(
        "ws://127.0.0.1:5173/v1/terminal/attachments/redeem",
      );
    }
    expect(requests.every(({ url }) => url.startsWith(gatewayConfig.daemonOrigin))).toBe(true);
    expect(requests.every(({ headers }) => !("Authorization" in headers))).toBe(true);
    host.dispose();
  });

  it("uses one stable per-document host identity in legacy direct mode", async () => {
    const hostIds: Array<string | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const headers = init?.headers as Record<string, string>;
        hostIds.push(headers["X-Tmux-Ide-Host-Client-Id"]);
        if (url.pathname === "/api/v2/capabilities") {
          return new Response(
            JSON.stringify({
              status: "ok",
              daemon: IDENTITY,
              capabilities: { appWindowMutation: { available: true } },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ unreadable: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const first = createDevWebHostCapabilities(CONFIG);
    const second = createDevWebHostCapabilities(CONFIG);
    await first.daemon.capabilities();
    await first.daemon.startupReadiness();
    await second.daemon.capabilities();
    expect(hostIds[0]).toMatch(/^dev-web-direct:/u);
    expect(hostIds[1]).toBe(hostIds[0]);
    expect(hostIds[2]).not.toBe(hostIds[0]);
    first.dispose();
    second.dispose();
  });
});

describe("development gateway host sessions", () => {
  const CONFIG = {
    daemonOrigin: "http://127.0.0.1:5173",
    daemonWebSocketOrigin: "ws://127.0.0.1:5173",
    ownerToken: null,
    transport: "same-origin-gateway" as const,
  };

  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const capabilities = {
    status: "ok",
    daemon: IDENTITY,
    capabilities: { appWindowMutation: { available: true } },
  };

  it("keeps a host session in one document generation and never revives sessionStorage", async () => {
    const readRetainedSession = vi.fn(() => "99999999-9999-4999-8999-999999999999");
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: readRetainedSession,
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    });
    const bootstrapTokens = [
      "11111111-1111-4111-8111-111111111112",
      "11111111-1111-4111-8111-111111111113",
    ];
    const apiSessions: Array<string | undefined> = [];
    let bootstrapCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const pathname = new URL(String(input), CONFIG.daemonOrigin).pathname;
        if (pathname === "/__tmux_ide_host_session") {
          return jsonResponse(200, { token: bootstrapTokens[bootstrapCount++] });
        }
        const headers = init?.headers as Record<string, string>;
        apiSessions.push(headers["X-Tmux-Ide-Dev-Host-Session"]);
        return jsonResponse(200, capabilities);
      }),
    );

    const first = createDevWebHostCapabilities(CONFIG);
    const second = createDevWebHostCapabilities(CONFIG);
    await first.daemon.capabilities();
    await first.daemon.capabilities();
    await second.daemon.capabilities();

    expect(bootstrapCount).toBe(2);
    expect(apiSessions).toEqual([bootstrapTokens[0], bootstrapTokens[0], bootstrapTokens[1]]);
    expect(apiSessions).not.toContain("99999999-9999-4999-8999-999999999999");
    expect(readRetainedSession).not.toHaveBeenCalled();
    first.dispose();
    second.dispose();
  });

  it("clears a rejected bootstrap promise so the same document can retry", async () => {
    let bootstrapCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const pathname = new URL(String(input), CONFIG.daemonOrigin).pathname;
        if (pathname === "/__tmux_ide_host_session") {
          bootstrapCount += 1;
          return bootstrapCount === 1
            ? jsonResponse(503, { unavailable: true })
            : jsonResponse(200, { token: "22222222-2222-4222-8222-222222222222" });
        }
        return jsonResponse(200, capabilities);
      }),
    );

    const host = createDevWebHostCapabilities(CONFIG);
    await expect(host.daemon.capabilities()).resolves.toMatchObject({ status: "error" });
    await expect(host.daemon.capabilities()).resolves.toMatchObject({ status: "ok" });
    expect(bootstrapCount).toBe(2);
    host.dispose();
  });

  it("tunnels gateway reads through an origin-bearing POST for exact-origin enforcement", async () => {
    const apiRequests: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const pathname = new URL(String(input), CONFIG.daemonOrigin).pathname;
        if (pathname === "/__tmux_ide_host_session") {
          return jsonResponse(200, { token: "77777777-7777-4777-8777-777777777777" });
        }
        apiRequests.push(init ?? {});
        return jsonResponse(200, { unreadable: true });
      }),
    );

    const host = createDevWebHostCapabilities(CONFIG);
    await host.daemon.startupReadiness();

    expect(apiRequests).toHaveLength(1);
    expect(apiRequests[0]?.method).toBe("POST");
    expect(
      (apiRequests[0]?.headers as Record<string, string>)["X-Tmux-Ide-Dev-Original-Method"],
    ).toBe("GET");
    host.dispose();
  });

  it("rebootstraps once on the exact stale-session code and preserves the operation id", async () => {
    const operationId = "33333333-3333-4333-8333-333333333333";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(operationId);
    let bootstrapCount = 0;
    const actionRequests: Array<{
      operationId: string | undefined;
      body: string | undefined;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const pathname = new URL(String(input), CONFIG.daemonOrigin).pathname;
        if (pathname === "/__tmux_ide_host_session") {
          bootstrapCount += 1;
          return jsonResponse(200, {
            token:
              bootstrapCount === 1
                ? "44444444-4444-4444-8444-444444444444"
                : "55555555-5555-4555-8555-555555555555",
          });
        }
        const headers = init?.headers as Record<string, string>;
        actionRequests.push({
          operationId: headers["X-Tmux-Ide-Operation-Id"],
          body: init?.body as string | undefined,
        });
        if (actionRequests.length === 1) {
          return jsonResponse(401, { code: "dev_host_session_invalid" });
        }
        return jsonResponse(200, {
          ok: true,
          result: {
            verb: "workspace.pane.select",
            operationId,
            daemonInstanceId: IDENTITY.instanceId,
            outcome: "applied",
            workspaceName: "alpha",
            semanticPaneId: "pane.alpha",
          },
        });
      }),
    );

    const host = createDevWebHostCapabilities(CONFIG);
    await expect(
      host.daemon.invokeVerb({
        verbId: "pane.select",
        intent: {
          verb: "workspace.pane.select",
          workspaceName: "alpha",
          semanticPaneId: "pane.alpha",
        },
      }),
    ).resolves.toMatchObject({ status: "ok" });
    expect(bootstrapCount).toBe(2);
    expect(actionRequests).toHaveLength(2);
    expect(actionRequests[0]?.operationId).toBe(operationId);
    expect(actionRequests[1]?.operationId).toBe(operationId);
    expect(actionRequests[1]?.body).toBe(actionRequests[0]?.body);
    host.dispose();
  });

  it("does not retry or mint a new host session for a business 409", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let bootstrapCount = 0;
    let actionCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const pathname = new URL(String(input), CONFIG.daemonOrigin).pathname;
        if (pathname === "/__tmux_ide_host_session") {
          bootstrapCount += 1;
          return jsonResponse(200, { token: "66666666-6666-4666-8666-666666666666" });
        }
        actionCount += 1;
        return jsonResponse(409, { code: "controller_busy" });
      }),
    );

    const host = createDevWebHostCapabilities(CONFIG);
    await expect(
      host.daemon.invokeVerb({
        verbId: "pane.select",
        intent: {
          verb: "workspace.pane.select",
          workspaceName: "alpha",
          semanticPaneId: "pane.alpha",
        },
      }),
    ).resolves.toMatchObject({ status: "error" });
    expect(bootstrapCount).toBe(1);
    expect(actionCount).toBe(1);
    warned.mockRestore();
    host.dispose();
  });
});
