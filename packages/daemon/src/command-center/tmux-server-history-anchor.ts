import type { Hono } from "hono";
import {
  HistoryAnchorRequestSchemaZ,
  HistoryAnchorResponseSchemaZ,
  TmuxServerScopeSchemaZ,
} from "@tmux-ide/contracts";
import { TmuxServerScopeError, type TmuxServerOwners } from "../lib/tmux-server-owners.ts";
import type { NativeTmuxServerOwner } from "../lib/tmux-server-owner.ts";
/** Mounted below owner-authenticated no-store middleware. Never opens a runtime. */
export function mountTmuxServerHistoryAnchorRoute(
  app: Hono,
  options: {
    scopedPath: string;
    owners: TmuxServerOwners<NativeTmuxServerOwner>;
    readBody: (request: Request) => Promise<unknown>;
  },
) {
  app.post(`${options.scopedPath}/history-anchor`, async (c) => {
    const scope = TmuxServerScopeSchemaZ.safeParse({
      serverId: c.req.param("serverId"),
      generation: c.req.param("generation"),
    });
    if (!scope.success) return c.json({ error: { code: "invalid-request" } }, 400);
    let body;
    try {
      body = HistoryAnchorRequestSchemaZ.parse(await options.readBody(c.req.raw));
    } catch {
      return c.json({ error: { code: "invalid-request" } }, 400);
    }
    if (body.proof.generation !== scope.data.generation)
      return c.json({ error: { code: "stale-generation" } }, 409);
    try {
      c.req.raw.signal.throwIfAborted();
      const result = await options.owners.withOwner(scope.data, async (owner) => {
        const sessions = await owner.catalog();
        c.req.raw.signal.throwIfAborted();
        const workspace = owner.workspaceRegistry.get(body.proof.workspaceName);
        if (
          !workspace ||
          !sessions.some(
            (row) =>
              row.sessionName === workspace.sessionName && row.liveSessionId === body.liveSessionId,
          )
        )
          return { status: "stale" as const };
        const result = owner.sessionRuntimeRegistry.historyAnchor(
          workspace.sessionName,
          HistoryAnchorRequestSchemaZ.parse({
            ...body,
            proof: { ...body.proof, workspaceName: workspace.sessionName },
          }),
        );
        // Delivery aliases are transport addresses, not canonical session names.
        return result.status === "resolved"
          ? { ...result, proof: { ...result.proof, workspaceName: body.proof.workspaceName } }
          : result;
      });
      c.req.raw.signal.throwIfAborted();
      return c.json(HistoryAnchorResponseSchemaZ.parse({ version: 1, server: scope.data, result }));
    } catch (error) {
      if (error instanceof TmuxServerScopeError)
        return c.json(
          { error: { code: "scope-unavailable" } },
          error.code === "not-found" ? 404 : 409,
        );
      return c.json({ error: { code: "history-unavailable" } }, 503);
    }
  });
}
