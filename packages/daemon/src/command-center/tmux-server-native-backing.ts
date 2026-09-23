import { Hono } from "hono";
import { TmuxServerScopeSchemaZ } from "@tmux-ide/contracts";
import { TmuxServerScopeError, type TmuxServerOwners } from "../lib/tmux-server-owners.ts";
import type { NativeTmuxServerOwner } from "../lib/tmux-server-owner.ts";
import { mountTerminalNativeBackingRoute } from "./resources/terminal-native-backing-route.ts";

/** Retain admission/coalescing limits for the lifetime of each independent owner. */
export function mountTmuxServerNativeBackingRoute(
  app: Hono,
  options: {
    scopedPath: string;
    ownerToken: string | null;
    owners: TmuxServerOwners<NativeTmuxServerOwner>;
  },
): void {
  const routers = new WeakMap<NativeTmuxServerOwner, Hono>();
  app.get(`${options.scopedPath}/native-backing/:workspaceName/:pane`, async (c) => {
    const scope = TmuxServerScopeSchemaZ.safeParse({
      serverId: c.req.param("serverId"),
      generation: c.req.param("generation"),
    });
    if (!scope.success) return c.json({ status: "invalid" }, 400);
    try {
      return await options.owners.withOwner(scope.data, async (owner) => {
        let router = routers.get(owner);
        if (!router) {
          router = new Hono();
          mountTerminalNativeBackingRoute(router, {
            ownerToken: options.ownerToken,
            generation: owner.generation,
            resolveSession: (workspace) =>
              owner.workspaceRegistry.get(workspace)?.sessionName ?? null,
            capture: (session, pane, expected) =>
              owner.sessionRuntimeRegistry.captureNativeBacking(session, pane, expected),
          });
          routers.set(owner, router);
        }
        const url = new URL(c.req.url);
        url.pathname = `/api/project/${encodeURIComponent(c.req.param("workspaceName"))}/terminal-native-backing/${encodeURIComponent(c.req.param("pane"))}`;
        return await router.request(new Request(url, c.req.raw));
      });
    } catch (error) {
      return c.json(
        { status: error instanceof TmuxServerScopeError ? "retired" : "unavailable" },
        error instanceof TmuxServerScopeError ? 409 : 503,
      );
    }
  });
}
