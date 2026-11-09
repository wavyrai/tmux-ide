import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountPluginRoutes, type PluginRouteBackend } from "./plugin-routes.ts";

const status = { host: { running: true, pid: 42, restarts: 0 }, plugins: [] };

function setup(backend: PluginRouteBackend | null = null, ownerToken: string | null = "owner") {
  const app = new Hono();
  mountPluginRoutes(app, { ownerToken, backend });
  const request = (path: string, init: RequestInit = {}, token: string | null = "owner") =>
    app.request(path, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  return { request };
}

function backend(): PluginRouteBackend & {
  [K in keyof PluginRouteBackend]: ReturnType<typeof vi.fn>;
} {
  return {
    status: vi.fn(() => status),
    reload: vi.fn(async () => status),
    run: vi.fn(async () => ({ ok: true, values: [2], logs: [] })),
  };
}

describe("plugin routes", () => {
  it("require the owner capability on every route", async () => {
    const b = backend();
    const { request } = setup(b);
    for (const [path, init] of [
      ["/api/v2/plugins", {}],
      ["/api/v2/plugins/reload", { method: "POST", body: "{}" }],
      ["/api/v2/lua/run", { method: "POST", body: JSON.stringify({ code: "return 1" }) }],
    ] as const) {
      expect((await request(path, init, null)).status).not.toBe(200);
      expect((await request(path, init, "someone-else")).status).not.toBe(200);
    }
    expect(b.status).not.toHaveBeenCalled();
    expect(b.reload).not.toHaveBeenCalled();
    expect(b.run).not.toHaveBeenCalled();
  });

  it("are unavailable when the daemon has no owner token", async () => {
    const { request } = setup(backend(), null);
    expect((await request("/api/v2/plugins")).status).toBe(503);
  });

  it("answer 503 when the daemon runs without plugins", async () => {
    const { request } = setup(null);
    const response = await request("/api/v2/plugins");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Plugins are not enabled in this daemon" });
  });

  it("return status, reload one plugin and run code", async () => {
    const b = backend();
    const { request } = setup(b);
    const list = await request("/api/v2/plugins");
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(await list.json()).toEqual({ ok: true, ...status });
    expect(
      (
        await request("/api/v2/plugins/reload", {
          method: "POST",
          body: JSON.stringify({ name: "tasks" }),
        })
      ).status,
    ).toBe(200);
    expect(b.reload).toHaveBeenCalledWith("tasks");
    expect((await request("/api/v2/plugins/reload", { method: "POST" })).status).toBe(200);
    expect(b.reload).toHaveBeenLastCalledWith(undefined);
    const run = await request("/api/v2/lua/run", {
      method: "POST",
      body: JSON.stringify({ code: "return 1 + 1", chunkName: "=cli", budgetMs: 500 }),
    });
    expect(await run.json()).toEqual({ result: { ok: true, values: [2], logs: [] } });
    expect(b.run).toHaveBeenCalledWith("return 1 + 1", { chunkName: "=cli", budgetMs: 500 });
  });

  it("reject malformed and oversized requests before reaching the backend", async () => {
    const b = backend();
    const { request } = setup(b);
    const post = (path: string, body: string) => request(path, { method: "POST", body });
    expect((await post("/api/v2/plugins/reload", "{")).status).toBe(400);
    expect((await post("/api/v2/plugins/reload", JSON.stringify({ name: 1 }))).status).toBe(400);
    expect((await post("/api/v2/lua/run", JSON.stringify({}))).status).toBe(400);
    expect((await post("/api/v2/lua/run", JSON.stringify({ code: "x", extra: 1 }))).status).toBe(
      400,
    );
    expect(
      (await post("/api/v2/lua/run", JSON.stringify({ code: "x", chunkName: "plain" }))).status,
    ).toBe(400);
    expect((await post("/api/v2/lua/run", JSON.stringify({ code: "x", budgetMs: 5 }))).status).toBe(
      400,
    );
    expect(
      (await post("/api/v2/lua/run", JSON.stringify({ code: "x".repeat(1024 * 1024 + 8192) })))
        .status,
    ).toBe(413);
    expect(b.reload).not.toHaveBeenCalled();
    expect(b.run).not.toHaveBeenCalled();
  });
});
