/**
 * Owner-only routes for plugins:
 *   GET  /api/v2/plugins          status of the host and every plugin
 *   POST /api/v2/plugins/reload   { name? }: discover again and reload
 *   POST /api/v2/lua/run          { code, chunkName?, budgetMs? }: run once
 *
 * `lua/run` executes code with the owner's authority, so every route needs
 * the owner capability, never the shared remote-access token. The check is
 * `ownerAuthorityGate`, the same one behind `/api/v2/capabilities` and the
 * owner-only actions such as `project.launch`, which also run user code.
 *
 * None of these routes serve browsers: a request that carries `Origin` or
 * any `Sec-Fetch-*` header is refused before the credential is looked at,
 * so the daemon's permissive CORS policy cannot expose them to a web page.
 */
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ownerAuthorityGate } from "./owner-authority.ts";
import type { LuaRunResult, PluginSupervisorStatus } from "../plugins/supervisor.ts";

export interface PluginRouteBackend {
  status(): PluginSupervisorStatus;
  reload(name?: string): Promise<PluginSupervisorStatus>;
  run(code: string, options: { chunkName?: string; budgetMs?: number }): Promise<LuaRunResult>;
}

const ReloadRequestZ = z.strictObject({ name: z.string().min(1).max(64).optional() });
const RunRequestZ = z.strictObject({
  code: z.string().max(1024 * 1024),
  chunkName: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[=@][^\0\n]*$/u)
    .optional(),
  budgetMs: z.number().int().min(10).max(600_000).optional(),
});

/**
 * The gate every plugin and command-catalog route uses: refuse anything a
 * browser sent, then require the owner capability.
 */
export function ownerOnlyNonBrowserGuard(
  ownerToken: string | null,
): (c: Context) => Response | null {
  const authorize = ownerAuthorityGate(ownerToken, {
    whenOwnerless: "unavailable",
    unavailableMessage: "Plugins are unavailable",
    mismatchMessage: "Plugins require owner authority",
  });
  const refuseBrowser = (c: Context): Response | null => {
    const headers = c.req.header();
    const fromBrowser = Object.keys(headers).some(
      (name) => name === "origin" || name.startsWith("sec-fetch-"),
    );
    return fromBrowser ? c.json({ error: "Plugins cannot be used from a browser" }, 403) : null;
  };
  return (c) => refuseBrowser(c) ?? authorize(c);
}

export function mountPluginRoutes(
  app: Hono,
  options: { ownerToken: string | null; backend: PluginRouteBackend | null },
): void {
  const guard = ownerOnlyNonBrowserGuard(options.ownerToken);
  const unavailable = { error: "Plugins are not enabled in this daemon" };

  app.get("/api/v2/plugins", (c) => {
    const gate = guard(c);
    if (gate) return gate;
    c.header("Cache-Control", "no-store");
    if (!options.backend) return c.json(unavailable, 503);
    return c.json({ ok: true, ...options.backend.status() });
  });

  app.post("/api/v2/plugins/reload", bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
    const gate = guard(c);
    if (gate) return gate;
    c.header("Cache-Control", "no-store");
    if (!options.backend) return c.json(unavailable, 503);
    let body: unknown;
    try {
      const text = await c.req.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return c.json({ error: "Invalid reload request" }, 400);
    }
    const parsed = ReloadRequestZ.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid reload request" }, 400);
    return c.json({ ok: true, ...(await options.backend.reload(parsed.data.name)) });
  });

  app.post("/api/v2/lua/run", bodyLimit({ maxSize: 1024 * 1024 + 4096 }), async (c) => {
    const gate = guard(c);
    if (gate) return gate;
    c.header("Cache-Control", "no-store");
    if (!options.backend) return c.json(unavailable, 503);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid run request" }, 400);
    }
    const parsed = RunRequestZ.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid run request" }, 400);
    const { code, ...runOptions } = parsed.data;
    return c.json({ result: await options.backend.run(code, runOptions) });
  });
}
