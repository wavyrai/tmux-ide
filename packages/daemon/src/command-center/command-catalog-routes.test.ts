import { COMMAND_PROTOCOL_VERSION, type CommandDescriptor } from "@tmux-ide/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountCommandCatalogRoutes, type CommandCatalogBackend } from "./command-catalog-routes.ts";

const builtin: CommandDescriptor = {
  version: COMMAND_PROTOCOL_VERSION,
  id: "project.launch",
  owner: "daemon",
  label: "Launch project",
  category: "project",
  schemas: { input: "project.launch" },
  dangerous: false,
  confirmation: "none",
};

const pluginEntry = {
  descriptor: {
    ...builtin,
    id: "plugin.tasks.new",
    owner: "plugin" as const,
    label: "New task",
    category: "Tasks",
    schemas: { input: "plugin:tasks" },
  },
  plugin: "tasks",
  params: [],
};

function backend() {
  return {
    actionCatalog: vi.fn(() => ({ revision: 7, entries: [pluginEntry] })),
    invokeAction: vi.fn(async () => ({ ok: true as const, value: "done" })),
    actionParamOptions: vi.fn(async () => ({ ok: true as const, choices: [] })),
  } satisfies CommandCatalogBackend;
}

function setup(b: CommandCatalogBackend | null) {
  const app = new Hono();
  mountCommandCatalogRoutes(app, { ownerToken: "owner", builtins: () => [builtin], backend: b });
  return (path: string, init: RequestInit & { token?: string | null } = {}) => {
    const { token = "owner", ...rest } = init;
    return app.request(path, {
      ...rest,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...(rest.headers as Record<string, string> | undefined),
      },
    });
  };
}

const invokeBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "plugin.tasks.new",
    args: { name: "x" },
    context: { source: "cli" },
    ...extra,
  });

describe("command catalog routes", () => {
  it("lists built-in and plugin commands with the plugin catalog's revision", async () => {
    const request = setup(backend());
    const response = await request("/api/resources/command-catalog");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      version: 1,
      revision: 7,
      entries: [{ descriptor: builtin, params: [] }, pluginEntry],
    });
  });

  it("lists only built-ins when the daemon runs without plugins", async () => {
    const request = setup(null);
    expect(await (await request("/api/resources/command-catalog")).json()).toEqual({
      version: 1,
      revision: 0,
      entries: [{ descriptor: builtin, params: [] }],
    });
    expect(
      (await request("/api/v2/commands/invoke", { method: "POST", body: invokeBody() })).status,
    ).toBe(503);
  });

  it("refuses no credential, a wrong one, and browsers, on every route", async () => {
    const b = backend();
    const request = setup(b);
    const routes = [
      ["/api/resources/command-catalog", {}],
      ["/api/v2/commands/invoke", { method: "POST", body: invokeBody() }],
      [
        "/api/v2/commands/param-options",
        {
          method: "POST",
          body: JSON.stringify({
            id: "plugin.tasks.new",
            param: "task",
            context: { source: "palette" },
          }),
        },
      ],
    ] as const;
    for (const [path, init] of routes) {
      expect((await request(path, { ...init, token: null })).status).toBe(401);
      expect((await request(path, { ...init, token: "wrong" })).status).toBe(401);
      expect(
        (await request(path, { ...init, headers: { Origin: "https://evil.example" } })).status,
      ).toBe(403);
    }
    expect(b.actionCatalog).not.toHaveBeenCalled();
    expect(b.invokeAction).not.toHaveBeenCalled();
    expect(b.actionParamOptions).not.toHaveBeenCalled();
  });

  it("invokes plugin commands, unconfirmed unless the caller says so", async () => {
    const b = backend();
    const request = setup(b);
    const ok = await request("/api/v2/commands/invoke", { method: "POST", body: invokeBody() });
    expect(await ok.json()).toEqual({ ok: true, value: "done" });
    expect(b.invokeAction).toHaveBeenLastCalledWith(
      "plugin.tasks.new",
      { name: "x" },
      { source: "cli" },
      { confirmed: false },
    );
    await request("/api/v2/commands/invoke", {
      method: "POST",
      body: invokeBody({ confirmed: true }),
    });
    expect(b.invokeAction).toHaveBeenLastCalledWith(
      "plugin.tasks.new",
      { name: "x" },
      { source: "cli" },
      { confirmed: true },
    );
  });

  it("sends built-in commands to their own route and refuses malformed requests", async () => {
    const b = backend();
    const request = setup(b);
    const post = (body: string) => request("/api/v2/commands/invoke", { method: "POST", body });
    expect((await post(invokeBody({ id: "project.launch" }))).status).toBe(404);
    expect((await post("{")).status).toBe(400);
    expect((await post(invokeBody({ args: { "Bad-Name": 1 } }))).status).toBe(400);
    expect((await post(invokeBody({ args: { name: { nested: true } } }))).status).toBe(400);
    expect((await post(invokeBody({ context: { source: "elsewhere" } }))).status).toBe(400);
    expect((await post(invokeBody({ extra: 1 }))).status).toBe(400);
    expect(b.invokeAction).not.toHaveBeenCalled();
  });

  it("asks for parameter options", async () => {
    const b = backend();
    const request = setup(b);
    const response = await request("/api/v2/commands/param-options", {
      method: "POST",
      body: JSON.stringify({
        id: "plugin.tasks.new",
        param: "task",
        context: { source: "palette", session: "demo" },
      }),
    });
    expect(await response.json()).toEqual({ ok: true, choices: [] });
    expect(b.actionParamOptions).toHaveBeenCalledWith("plugin.tasks.new", "task", {
      source: "palette",
      session: "demo",
    });
  });
});
