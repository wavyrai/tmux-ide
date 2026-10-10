import { expect, it } from "bun:test";
import { COHESION_FIXTURE_V1 } from "@tmux-ide/contracts";
import { createTmuxServerClient } from "./tmux-server-client.ts";

const scope = {
  serverId: "tmux-server." + "a".repeat(32),
  generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const liveId = "live-session." + "b".repeat(20);
function envelope() {
  return {
    version: 1,
    server: scope,
    resource: {
      project: COHESION_FIXTURE_V1.project,
      workspace: {
        ...COHESION_FIXTURE_V1.workspace,
        sidebar: { ...COHESION_FIXTURE_V1.workspace.sidebar, agents: [] },
      },
      dock: COHESION_FIXTURE_V1.dock,
      focus: { ...COHESION_FIXTURE_V1.focus, overlays: [] },
      connection: COHESION_FIXTURE_V1.connection,
      terminalInventory: { activeResourceId: null, resources: [] },
    },
  };
}
function client(fetcher: (url: URL, init: RequestInit) => Promise<Response>) {
  return createTmuxServerClient(
    {
      baseUrl: "http://127.0.0.1:4000",
      ownerToken: "private-owner",
      hostClientId: "host",
      origin: "http://localhost",
      fetch: fetcher as typeof fetch,
    },
    scope,
  );
}
it("reads only the exact scoped shell with authentication and the live incarnation", async () => {
  const calls: string[] = [];
  const c = client(async (url, init) => {
    calls.push(url.pathname);
    expect(url.pathname).toBe(
      `/api/v1/tmux-servers/${scope.serverId}/${scope.generation}/application-shell/docs%2Fsite`,
    );
    expect(url.searchParams.get("liveSessionId")).toBe(liveId);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: "Bearer private-owner" });
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return Response.json(envelope());
  });
  expect(await c.applicationShell("docs/site", liveId)).toEqual(envelope());
  expect(calls).toHaveLength(1);
});
it("rejects mismatched generation, unknown envelope fields and invalid resource without fallback", async () => {
  for (const response of [
    { ...envelope(), server: { ...scope, generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } },
    { ...envelope(), extra: true },
    { ...envelope(), version: 2 },
    { ...envelope(), resource: {} },
  ]) {
    let calls = 0;
    const c = client(async () => {
      calls++;
      return Response.json(response);
    });
    await expect(c.applicationShell("docs", liveId)).rejects.toThrow();
    expect(calls).toBe(1);
  }
});
it("rejects invalid session identity before fetch and preserves unavailable status", async () => {
  let calls = 0;
  const c = client(async () => {
    calls++;
    return new Response(null, { status: 404 });
  });
  await expect(c.applicationShell("docs", "same-name")).rejects.toThrow();
  await expect(c.applicationShell("bad\nname", liveId)).rejects.toThrow();
  expect(calls).toBe(0);
  await expect(c.applicationShell("docs", liveId)).rejects.toMatchObject({
    code: "request-failed",
    status: 404,
  });
  expect(calls).toBe(1);
});
it("rejects a retired client's late response and future reads", async () => {
  let resolve!: (r: Response) => void;
  const c = client(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = c.applicationShell("docs", liveId);
  c.dispose();
  resolve(Response.json(envelope()));
  await expect(pending).rejects.toMatchObject({ code: "disposed" });
  await expect(c.applicationShell("docs", liveId)).rejects.toMatchObject({ code: "disposed" });
});
it("propagates caller cancellation and refuses late data even if fetch ignores abort", async () => {
  const abort = new AbortController();
  let resolve!: (r: Response) => void;
  let signal: AbortSignal | null | undefined;
  const c = client(async (_url, init) => {
    signal = init.signal;
    return new Promise((r) => {
      resolve = r;
    });
  });
  const pending = c.applicationShell("docs", liveId, abort.signal);
  abort.abort();
  expect(signal?.aborted).toBe(true);
  resolve(Response.json(envelope()));
  await expect(pending).rejects.toThrow();
  let calls = 0;
  const fresh = client(async () => {
    calls++;
    return Response.json(envelope());
  });
  await expect(fresh.applicationShell("docs", liveId, abort.signal)).rejects.toThrow();
  expect(calls).toBe(0);
});
