/**
 * The command catalog and plugin action invocation, owner-only and never for
 * browsers (the same gate as the plugin routes):
 *   GET  /api/resources/command-catalog   built-in and plugin commands
 *   POST /api/v2/commands/invoke          run a plugin action
 *   POST /api/v2/commands/param-options   one parameter's choices and default
 *
 * Built-in actions keep their own typed route, `/api/v2/action/:name`; the
 * catalog lists them so the CLI and palettes see one list.
 */
import {
  COMMAND_CATALOG_VERSION,
  CommandInvokeRequestSchemaZ,
  CommandParamOptionsRequestSchemaZ,
  type CommandCatalogEntry,
  type CommandCatalogResource,
  type CommandDescriptor,
  type CommandInvocationContext,
  type CommandInvokeResult,
  type CommandParamOptionsResult,
} from "@tmux-ide/contracts";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ownerOnlyNonBrowserGuard } from "./plugin-routes.ts";

export interface CommandCatalogBackend {
  actionCatalog(): { revision: number; entries: CommandCatalogEntry[] };
  invokeAction(
    id: string,
    args: Record<string, string | number | boolean>,
    context: CommandInvocationContext,
    options: { confirmed?: boolean },
  ): Promise<CommandInvokeResult>;
  actionParamOptions(
    id: string,
    param: string,
    context: CommandInvocationContext,
  ): Promise<CommandParamOptionsResult>;
}

export function buildCommandCatalog(
  builtins: readonly CommandDescriptor[],
  plugins: CommandCatalogBackend | null,
): CommandCatalogResource {
  const pluginCatalog = plugins?.actionCatalog() ?? { revision: 0, entries: [] };
  return {
    version: COMMAND_CATALOG_VERSION,
    revision: pluginCatalog.revision,
    entries: [
      ...builtins.map((descriptor) => ({ descriptor, params: [] })),
      ...pluginCatalog.entries,
    ],
  };
}

export function mountCommandCatalogRoutes(
  app: Hono,
  options: {
    ownerToken: string | null;
    builtins: () => readonly CommandDescriptor[];
    backend: CommandCatalogBackend | null;
  },
): void {
  const guard = ownerOnlyNonBrowserGuard(options.ownerToken);

  app.get("/api/resources/command-catalog", (c) => {
    const gate = guard(c);
    if (gate) return gate;
    c.header("Cache-Control", "no-store");
    return c.json(buildCommandCatalog(options.builtins(), options.backend));
  });

  app.post("/api/v2/commands/invoke", bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    const gate = guard(c);
    if (gate) return gate;
    c.header("Cache-Control", "no-store");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid invoke request" }, 400);
    }
    const parsed = CommandInvokeRequestSchemaZ.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid invoke request" }, 400);
    if (!parsed.data.id.startsWith("plugin."))
      return c.json({ error: "Built-in commands use /api/v2/action/:name" }, 404);
    if (!options.backend) return c.json({ error: "Plugins are not enabled in this daemon" }, 503);
    const { id, args, context, confirmed } = parsed.data;
    const result = await options.backend.invokeAction(id, args, context, {
      confirmed: confirmed === true,
    });
    return c.json(result);
  });

  app.post("/api/v2/commands/param-options", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const gate = guard(c);
    if (gate) return gate;
    c.header("Cache-Control", "no-store");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid options request" }, 400);
    }
    const parsed = CommandParamOptionsRequestSchemaZ.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid options request" }, 400);
    if (!options.backend) return c.json({ error: "Plugins are not enabled in this daemon" }, 503);
    return c.json(
      await options.backend.actionParamOptions(
        parsed.data.id,
        parsed.data.param,
        parsed.data.context,
      ),
    );
  });
}
