import type { Hono } from "hono";
import { TmuxServerScopeSchemaZ, TmuxServerDiagnosticsSchemaZ } from "@tmux-ide/contracts";
import { TmuxServerScopeError, type TmuxServerOwners } from "../lib/tmux-server-owners.ts";
import type { NativeTmuxServerOwner } from "../lib/tmux-server-owner.ts";

/** Mount beneath the existing owner-authenticated, no-store server router. */
export function mountTmuxServerDiagnosticsRoute(
  app: Hono,
  options: {
    scopedPath: string;
    owners: TmuxServerOwners<NativeTmuxServerOwner>;
  },
) {
  app.get(`${options.scopedPath}/diagnostics`, async (c) => {
    const scope = TmuxServerScopeSchemaZ.safeParse({
      serverId: c.req.param("serverId"),
      generation: c.req.param("generation"),
    });
    if (!scope.success) return c.json({ error: { code: "invalid-request" } }, 400);
    try {
      c.req.raw.signal.throwIfAborted();
      const tmuxVersion = await options.owners.withOwner(scope.data, (owner) =>
        owner.readServerVersion(c.req.raw.signal),
      );
      c.req.raw.signal.throwIfAborted();
      return c.json(
        TmuxServerDiagnosticsSchemaZ.parse({ version: 1, server: scope.data, tmuxVersion }),
      );
    } catch (error) {
      if (error instanceof TmuxServerScopeError)
        return c.json(
          { error: { code: "scope-unavailable" } },
          error.code === "not-found" ? 404 : 409,
        );
      return c.json({ error: { code: "diagnostics-unavailable" } }, 503);
    }
  });
}
