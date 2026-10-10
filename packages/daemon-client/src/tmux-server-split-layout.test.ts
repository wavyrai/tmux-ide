import { expect, it } from "bun:test";
import { createTmuxServerClient } from "./tmux-server-client.ts";

const scope = {
  serverId: `tmux-server.${"a".repeat(32)}`,
  generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const target = {
  liveSessionId: `live-session.${"b".repeat(20)}`,
  linkId: `window-link.${"c".repeat(32)}`,
  expectedSemanticWindowId: "window.same",
  linkRevision: 0,
};
const envelope = () => ({
  version: 1,
  server: { ...scope },
  resource: {
    version: 1,
    window: { ...target },
    layoutId: crypto.randomUUID(),
    cols: 80,
    rows: 24,
    panes: [{ semanticPaneId: "pane.same", left: 0, top: 0, width: 80, height: 24 }],
    splits: [],
  },
});
const client = (fetcher: (url: URL, init: RequestInit) => Promise<Response>) =>
  createTmuxServerClient(
    {
      baseUrl: "http://127.0.0.1:4000",
      ownerToken: "private-owner",
      hostClientId: "test",
      origin: "tmux-ide://app",
      fetch: fetcher as typeof fetch,
    },
    scope,
  );

it("reads exact scoped split handles with authentication and no caching", async () => {
  const response = envelope();
  const c = client(async (url, init) => {
    expect(url.pathname).toBe(
      `/api/v1/tmux-servers/${scope.serverId}/${scope.generation}/split-layout/docs%2Fsite`,
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(target);
    expect(init.headers).toEqual({
      Authorization: "Bearer private-owner",
      "Content-Type": "application/json",
    });
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("error");
    return Response.json(response);
  });
  expect(await c.windowSplitLayout("docs/site", target)).toEqual(response);
});
it("rejects every mismatched window identity and server generation", async () => {
  for (const patch of [
    { liveSessionId: `live-session.${"d".repeat(20)}` },
    { linkId: `window-link.${"d".repeat(32)}` },
    { expectedSemanticWindowId: "window.other" },
    { linkRevision: 1 },
  ]) {
    const r = envelope();
    Object.assign(r.resource.window, patch);
    await expect(
      client(async () => Response.json(r)).windowSplitLayout("docs", target),
    ).rejects.toMatchObject({ code: "scope-mismatch" });
  }
  const r = envelope();
  r.server.generation = crypto.randomUUID();
  await expect(
    client(async () => Response.json(r)).windowSplitLayout("docs", target),
  ).rejects.toMatchObject({ code: "scope-mismatch" });
});
it("validates targets before fetch and does not retry stale responses", async () => {
  let calls = 0;
  const c = client(async () => {
    calls++;
    return new Response(null, { status: 409 });
  });
  await expect(c.windowSplitLayout("bad\nname", target)).rejects.toThrow();
  await expect(c.windowSplitLayout("docs", { ...target, linkRevision: -1 })).rejects.toThrow();
  expect(calls).toBe(0);
  await expect(c.windowSplitLayout("docs", target)).rejects.toMatchObject({
    code: "request-failed",
    status: 409,
  });
  expect(calls).toBe(1);
});
it("rejects unknown envelope/resource fields", async () => {
  for (const r of [
    { ...envelope(), extra: true },
    { ...envelope(), resource: { ...envelope().resource, nativeWindowId: "@1" } },
  ])
    await expect(
      client(async () => Response.json(r)).windowSplitLayout("docs", target),
    ).rejects.toThrow();
});
it("snapshots target before awaiting and rejects disposed or aborted late responses", async () => {
  for (const action of ["mutate", "dispose", "abort"]) {
    let finish!: (r: Response) => void;
    const c = client(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const controller = new AbortController();
    const input = { ...target };
    const response = envelope();
    const pending = c.windowSplitLayout("docs", input, controller.signal);
    if (action === "mutate") input.linkRevision = 99;
    if (action === "dispose") c.dispose();
    if (action === "abort") controller.abort();
    finish(Response.json(response));
    if (action === "mutate") expect(await pending).toEqual(response);
    else await expect(pending).rejects.toThrow();
  }
});
it("does not fetch when already aborted", async () => {
  let calls = 0;
  const c = client(async () => {
    calls++;
    return Response.json(envelope());
  });
  await expect(c.windowSplitLayout("docs", target, AbortSignal.abort())).rejects.toThrow();
  expect(calls).toBe(0);
});
