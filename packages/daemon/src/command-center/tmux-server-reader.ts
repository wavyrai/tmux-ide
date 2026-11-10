import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  PaneReaderAssetRequestSchemaZ,
  PaneReaderRequestSchemaZ,
  TmuxServerScopeSchemaZ,
} from "@tmux-ide/contracts";
import { TmuxServerScopeError, type TmuxServerOwners } from "../lib/tmux-server-owners.ts";
import type { NativeTmuxServerOwner } from "../lib/tmux-server-owner.ts";

/**
 * The native Markdown reader's routes (card #756). Mount only below the
 * owner-authenticated, no-store scoped router. Responses never carry a path,
 * a file-system error or validation detail.
 */
export function mountTmuxServerReaderRoutes(
  app: Hono,
  options: {
    readonly scopedPath: string;
    readonly owners: TmuxServerOwners<NativeTmuxServerOwner>;
    readonly readBody: (request: Request) => Promise<unknown>;
  },
): void {
  const handle =
    (schema: z.ZodType<{ target: { generation: string } }>, kind: "read" | "asset") =>
    async (c: Context) => {
      const scope = TmuxServerScopeSchemaZ.safeParse({
        serverId: c.req.param("serverId"),
        generation: c.req.param("generation"),
      });
      if (!scope.success) return c.json({ error: { code: "invalid-request" } }, 400);
      let request: { target: { generation: string } };
      try {
        request = schema.parse(await options.readBody(c.req.raw));
      } catch {
        return c.json({ error: { code: "invalid-request" } }, 400);
      }
      if (request.target.generation !== scope.data.generation)
        return c.json({ error: { code: "stale-generation" } }, 409);
      try {
        c.req.raw.signal.throwIfAborted();
        const response: unknown = await options.owners.withOwner(
          scope.data,
          (owner): Promise<unknown> =>
            kind === "read"
              ? owner.paneReader.read(request, c.req.raw.signal)
              : owner.paneReader.asset(request, c.req.raw.signal),
        );
        c.req.raw.signal.throwIfAborted();
        return c.json(response);
      } catch (error) {
        if (error instanceof TmuxServerScopeError)
          return c.json(
            { error: { code: "scope-unavailable" } },
            error.code === "not-found" ? 404 : 409,
          );
        return c.json({ error: { code: "reader-unavailable" } }, 503);
      }
    };
  app.post(`${options.scopedPath}/reader`, handle(PaneReaderRequestSchemaZ, "read"));
  app.post(`${options.scopedPath}/reader/asset`, handle(PaneReaderAssetRequestSchemaZ, "asset"));
}
