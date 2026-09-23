import { describe, expect, it, vi } from "vitest";
import { parseTmuxServersOperation, runTmuxServersCli } from "./tmux-servers-cli.ts";
const serverId = `tmux-server.${"a".repeat(32)}`;
const generation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const server = { serverId, generation, state: "online", label: "Work" };
function connection(handler: (url: URL, init?: RequestInit) => Response) {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const dispose = vi.fn();
  return {
    requests,
    dispose,
    connect: vi.fn(async () => ({
      dispose,
      client: {
        baseUrl: "http://127.0.0.1:12345",
        ownerToken: "secret",
        hostClientId: "cli",
        origin: "http://127.0.0.1:12345",
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input));
          requests.push({ url, init });
          return handler(url, init);
        }) as typeof fetch,
      },
    })),
  };
}
describe("tmux server CLI", () => {
  it("validates exact selectors before acquiring any connection", async () => {
    const connect = vi.fn();
    for (const options of [
      { command: "add" },
      { command: "add", socketName: "foo", socketPath: "/tmp/socket" },
      { command: "add", socketPath: "relative" },
      { command: "sessions", serverId: "default" },
      { command: "list", socketName: "unused" },
      { command: "unknown" },
    ])
      await expect(runTmuxServersCli(options, connect)).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
  it("preserves remote paths verbatim for the remote daemon to resolve", async () => {
    const path = "/remote/does-not-exist-locally/sock";
    const c = connection((url, init) => {
      expect(url.pathname).toBe("/api/v1/tmux-servers");
      if (init?.method === "POST")
        expect(JSON.parse(String(init.body))).toEqual({
          label: "Remote",
          selector: { kind: "path", path },
        });
      return Response.json(init?.method === "POST" ? server : { version: 1, servers: [] });
    });
    expect(
      await runTmuxServersCli(
        { command: "add", socketPath: path, label: "Remote", ssh: "spark" },
        c.connect,
      ),
    ).toEqual(server);
    expect(c.requests).toHaveLength(2);
    expect(c.requests[1]!.init?.headers).toMatchObject({ Authorization: "Bearer secret" });
    expect(c.dispose).toHaveBeenCalledOnce();
  });
  it("addresses sessions by exact server and live generation", async () => {
    const c = connection((url) =>
      Response.json(
        url.pathname.endsWith("/sessions")
          ? { version: 1, server: { serverId, generation }, sessions: [] }
          : { version: 1, servers: [server] },
      ),
    );
    await runTmuxServersCli({ command: "sessions", serverId }, c.connect);
    expect(c.requests[1]!.url.pathname).toBe(
      `/api/v1/tmux-servers/${serverId}/${generation}/sessions`,
    );
  });
  it("does not fall back for unknown or offline servers", async () => {
    for (const servers of [[], [{ ...server, state: "offline", generation: null }]]) {
      const c = connection(() => Response.json({ version: 1, servers }));
      await expect(runTmuxServersCli({ command: "sessions", serverId }, c.connect)).rejects.toThrow(
        /not registered|offline/,
      );
      expect(c.requests).toHaveLength(1);
      expect(c.dispose).toHaveBeenCalledOnce();
    }
  });
  it("refuses old daemon capability before writes", async () => {
    const c = connection(() => new Response("Not Found", { status: 404 }));
    await expect(
      runTmuxServersCli({ command: "add", socketName: "work" }, c.connect),
    ).rejects.toThrow("does not support tmux server selection");
    expect(c.requests).toHaveLength(1);
    expect(c.dispose).toHaveBeenCalledOnce();
  });
  it("removes only the selected registration including an offline one", async () => {
    const c = connection((_url, init) =>
      Response.json(
        init?.method === "DELETE"
          ? { removed: true }
          : { version: 1, servers: [{ ...server, state: "offline", generation: null }] },
      ),
    );
    expect(await runTmuxServersCli({ command: "remove", serverId }, c.connect)).toEqual({
      removed: true,
      serverId,
    });
    expect(c.requests[1]!.url.pathname).toBe(`/api/v1/tmux-servers/${serverId}`);
    expect(c.requests[1]!.init?.method).toBe("DELETE");
  });
  it("parses named selectors without interpreting them as local paths", () => {
    expect(parseTmuxServersOperation({ command: "add", socketName: "dev" })).toEqual({
      command: "add",
      registration: { label: "dev", selector: { kind: "name", name: "dev" } },
    });
  });
  it("creates on the selected live generation and preserves remote cwd", async () => {
    const c = connection((url, init) => {
      if (url.pathname.endsWith("/sessions/create")) {
        const request = JSON.parse(String(init?.body));
        expect(request.intent).toEqual({ displayName: "Build", cwd: "/remote/build" });
        expect(request.expectedDaemonInstanceId).toBe(generation);
        return Response.json({
          operationId: request.operationId,
          daemonInstanceId: generation,
          outcome: "created",
          fleetSessionId: "session.0123456789abcdef01234567",
          workspaceName: "build",
          displayName: "Build",
        });
      }
      return Response.json({ version: 1, servers: [server] });
    });
    await runTmuxServersCli(
      { command: "create", serverId, sessionName: "Build", cwd: "/remote/build", ssh: "spark" },
      c.connect,
    );
    expect(c.requests[1]!.url.pathname).toBe(
      `/api/v1/tmux-servers/${serverId}/${generation}/sessions/create`,
    );
  });
});
