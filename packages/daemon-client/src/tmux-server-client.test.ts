import { describe, expect, it, mock } from "bun:test";
import {
  PANE_STREAM_PROTOCOL_VERSION,
  PANE_STREAM_REDEEM_PATH,
  PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
  tmuxServerPaneStreamPath,
} from "@tmux-ide/contracts";
import {
  createTmuxServerClient,
  listTmuxServers,
  registerTmuxServer,
  removeTmuxServer,
} from "./tmux-server-client.ts";
const scope = {
  serverId: `tmux-server.${"a".repeat(32)}`,
  generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const other = { ...scope, serverId: `tmux-server.${"b".repeat(32)}` };
const requestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const base = {
  baseUrl: "http://127.0.0.1:4000",
  ownerToken: "owner",
  hostClientId: "client",
  origin: "http://localhost:3000",
};
const sessions = (server = scope) => ({
  version: 1,
  server,
  sessions: [
    {
      liveSessionId: `live-session.${"a".repeat(20)}`,
      sessionName: "main",
      workspaceName: "alias",
      paneCount: 1,
    },
  ],
});
const stream = {
  protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
  workspaceName: "main",
  panes: ["pane.one"],
  viewerMode: "interactive" as const,
};
const issued = () => ({
  status: "issued",
  descriptor: {
    protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
    webSocketUrl: `ws://127.0.0.1:4000${tmuxServerPaneStreamPath(scope)}`,
    subprotocol: PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
    redemptionTicket: `ps2_${"a".repeat(43)}`,
    daemonInstanceId: scope.generation,
    requestId,
    expiresAt: Date.now() + 10000,
    panes: ["pane.one"],
    effectiveViewerMode: "interactive",
  },
});

describe("explicit tmux server SDK client", () => {
  it("validates versioned server listing without fallback", async () => {
    const fetcher = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`${base.baseUrl}/api/v1/tmux-servers`);
      expect(init?.headers).toMatchObject({ Authorization: "Bearer owner" });
      return Response.json({
        version: 1,
        servers: [{ ...scope, state: "online", label: "default" }],
      });
    });
    expect(
      (await listTmuxServers({ ...base, fetch: fetcher as typeof fetch })).servers,
    ).toHaveLength(1);
    await expect(
      listTmuxServers({
        ...base,
        fetch: mock(async () => Response.json({ version: 2, servers: [] })) as typeof fetch,
      }),
    ).rejects.toThrow();
  });

  it("binds copied inputs and cache keys to an immutable exact scope", async () => {
    const input = { ...scope };
    const fetcher = mock(async (url: string | URL | Request) => {
      expect(String(url)).toContain(`/${scope.serverId}/${scope.generation}/sessions`);
      return Response.json(sessions());
    });
    const client = createTmuxServerClient({ ...base, fetch: fetcher as typeof fetch }, input);
    input.serverId = other.serverId;
    expect((await client.sessions()).server).toEqual(scope);
    expect(Object.isFrozen(client.scope)).toBe(true);
    expect(client.cacheKey("pane", "%0")).not.toBe(
      createTmuxServerClient(base, other).cacheKey("pane", "%0"),
    );
  });

  it("rejects scope mismatches and stale HTTP refusal without retries", async () => {
    const fetcher = mock(async () => Response.json(sessions(other)));
    await expect(
      createTmuxServerClient({ ...base, fetch: fetcher as typeof fetch }, scope).sessions(),
    ).rejects.toMatchObject({ code: "scope-mismatch" });
    const refused = mock(async () =>
      Response.json({ error: { code: "stale-generation" } }, { status: 409 }),
    );
    await expect(
      createTmuxServerClient({ ...base, fetch: refused as typeof fetch }, scope).sessions(),
    ).rejects.toMatchObject({ status: 409 });
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("drops an old selection's late response after disposal", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const fetcher = mock(async () => pending);
    const client = createTmuxServerClient({ ...base, fetch: fetcher as typeof fetch }, scope);
    const result = client.sessions();
    client.dispose();
    resolve(Response.json(sessions()));
    await expect(result).rejects.toMatchObject({ code: "disposed" });
    await expect(client.sessions()).rejects.toMatchObject({ code: "disposed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses explicit owner authority for passive fleet close without a controller principal", async () => {
    const fetcher = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("X-Tmux-Ide-Host-Client-Id")).toBe(false);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer owner");
      return Response.json({
        operationId: requestId,
        daemonInstanceId: scope.generation,
        workspaceName: "same",
        verb: "workspace.session.kill",
        outcome: "applied",
      });
    });
    await createTmuxServerClient({ ...base, fetch: fetcher as typeof fetch }, scope).mutate(
      requestId,
      {
        verb: "workspace.session.kill",
        workspaceName: "same",
        fleetTarget: {
          daemonInstanceId: scope.generation,
          liveSessionId: `live-session.${"a".repeat(20)}`,
          sessionName: "same",
        },
      },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("sends owner-scoped mutations and verifies generation and operation echoes", async () => {
    const fetcher = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.expectedDaemonInstanceId).toBe(scope.generation);
      return Response.json({
        operationId: body.operationId,
        daemonInstanceId: scope.generation,
        outcome: "applied",
        workspaceName: "main",
        verb: "workspace.pane.select",
        semanticPaneId: "pane.one",
      });
    });
    const client = createTmuxServerClient({ ...base, fetch: fetcher as typeof fetch }, scope);
    const result = await client.mutate(requestId, {
      verb: "workspace.pane.select",
      workspaceName: "main",
      semanticPaneId: "pane.one",
    });
    expect(result.daemonInstanceId).toBe(scope.generation);
  });

  it("sends exact issue headers and validates scoped redemption", async () => {
    const fetcher = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toEndWith(`/${scope.serverId}/${scope.generation}/pane-streams/issue`);
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer owner",
        Origin: base.origin,
        "X-Tmux-Ide-Request-Id": requestId,
        "X-Tmux-Ide-Expected-Daemon-Instance-Id": scope.generation,
        "X-Tmux-Ide-Host-Client-Id": "client",
      });
      return Response.json(issued());
    });
    expect(
      (
        await createTmuxServerClient(
          { ...base, fetch: fetcher as typeof fetch },
          scope,
        ).issuePaneStream(requestId, stream)
      ).status,
    ).toBe("issued");
    const wrong = issued();
    wrong.descriptor.webSocketUrl = `ws://127.0.0.1:4000${tmuxServerPaneStreamPath(other)}`;
    await expect(
      createTmuxServerClient(
        { ...base, fetch: mock(async () => Response.json(wrong)) as typeof fetch },
        scope,
      ).issuePaneStream(requestId, stream),
    ).rejects.toMatchObject({ code: "scope-mismatch" });
  });

  it("rejects inventories from the wrong workspace", async () => {
    const fetcher = mock(async () =>
      Response.json({
        version: 1,
        server: scope,
        resource: {
          workspaceName: "other",
          workspaceId: "workspace.0123456789abcdefabcd",
          sessionId: "session.0123456789abcdefabcd",
          resourceRevision: 0,
          semanticPaneIds: ["pane.one"],
        },
      }),
    );
    await expect(
      createTmuxServerClient({ ...base, fetch: fetcher as typeof fetch }, scope).inventory("main"),
    ).rejects.toMatchObject({ code: "scope-mismatch" });
  });
});

describe("server registration and adopted default", () => {
  it("passes remote selector intent unchanged and removes by opaque registration", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(
        init?.method === "DELETE"
          ? { removed: true }
          : { ...scope, label: "remote", state: "online" },
      );
    });
    const options = { ...base, fetch: fetcher as typeof fetch };
    await registerTmuxServer(options, {
      label: "remote",
      selector: { kind: "path", path: "/remote/socket" },
    });
    expect(JSON.parse(String(calls[0]?.init?.body)).selector).toEqual({
      kind: "path",
      path: "/remote/socket",
    });
    await removeTmuxServer(options, scope.serverId);
    expect(calls[1]?.init?.method).toBe("DELETE");
    expect(calls[1]?.url).toEndWith(`/${scope.serverId}`);
    await expect(removeTmuxServer(options, "../default")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("accepts default redemption only with an exact generation and request echo", async () => {
    const response = issued();
    response.descriptor.webSocketUrl = `ws://127.0.0.1:4000${PANE_STREAM_REDEEM_PATH}`;
    const fetcher = mock(async () => Response.json(response));
    const client = createTmuxServerClient({ ...base, fetch: fetcher as typeof fetch }, scope);
    expect((await client.issuePaneStream(requestId, stream)).status).toBe("issued");
    response.descriptor.daemonInstanceId = requestId;
    await expect(client.issuePaneStream(requestId, stream)).rejects.toMatchObject({
      code: "scope-mismatch",
    });
  });

  it("preserves authoritative workspace aliases and unavailable collisions", async () => {
    const response = sessions();
    const client = createTmuxServerClient(
      { ...base, fetch: mock(async () => Response.json(response)) as typeof fetch },
      scope,
    );
    expect((await client.sessions()).sessions[0]?.workspaceName).toBe("alias");
    const unavailable = {
      ...response,
      sessions: response.sessions.map((session) => ({ ...session, workspaceName: null })),
    };
    const otherClient = createTmuxServerClient(
      { ...base, fetch: mock(async () => Response.json(unavailable)) as typeof fetch },
      scope,
    );
    expect((await otherClient.sessions()).sessions[0]?.workspaceName).toBeNull();
  });
});
