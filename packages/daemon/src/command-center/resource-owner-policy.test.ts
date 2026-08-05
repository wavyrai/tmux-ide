import { describe, expect, it } from "vitest";

import { createApp } from "./server.ts";

/**
 * Every `/api/resources/*` route must declare an owner policy, and the policy
 * it declares must be the one it actually enforces.
 *
 * The guard itself is one helper now (`owner-authority.ts`), so the risk this
 * test covers is not a mis-implemented check — it is a NEW resource route
 * mounted with no policy at all, which is exactly how the workspace catalog
 * came to be ungated without anyone deciding it should be. Adding a route under
 * `/api/resources/` without adding it here fails collection-side, and the
 * behavior below is asserted against a real app, not a comment.
 */
const OWNER = "resource-policy-owner";

type DeclaredPolicy =
  /** Owner-only: 401 without the bearer, 503 when the daemon holds no token. */
  | "owner-only"
  /** Owner-only when a token is held; ownerless serves the resource. */
  | "owner-only-when-held"
  /** Deliberately not owner-gated — see the comment at the route. */
  | "open";

const DECLARED: Readonly<Record<string, DeclaredPolicy>> = {
  "/api/resources/fleet-catalog": "owner-only",
  "/api/resources/startup-readiness": "owner-only-when-held",
  "/api/resources/workspace-catalog": "open",
};

function resourcePaths(): readonly string[] {
  const app = createApp({ remoteAccess: { ownerToken: OWNER } });
  const paths = app.routes
    .filter((route) => route.path.startsWith("/api/resources/"))
    .map((route) => route.path);
  return [...new Set(paths)].sort();
}

async function get(
  path: string,
  options: { readonly ownerToken: string | null; readonly bearer?: string },
): Promise<Response> {
  const app = createApp(
    options.ownerToken === null ? {} : { remoteAccess: { ownerToken: options.ownerToken } },
  );
  return app.request(`http://localhost${path}`, {
    headers: options.bearer === undefined ? {} : { Authorization: `Bearer ${options.bearer}` },
  });
}

describe("/api/resources/* owner policy", () => {
  it("declares a policy for every registered resource route", () => {
    expect(resourcePaths()).toEqual(Object.keys(DECLARED).sort());
  });

  it("enforces the policy each route declares", async () => {
    for (const [path, policy] of Object.entries(DECLARED)) {
      const withOwner = await get(path, { ownerToken: OWNER, bearer: OWNER });
      expect([path, withOwner.status]).toEqual([path, 200]);

      const wrongBearer = await get(path, { ownerToken: OWNER, bearer: "wrong" });
      const noBearer = await get(path, { ownerToken: OWNER });
      const ownerless = await get(path, { ownerToken: null });

      if (policy === "open") {
        expect([path, wrongBearer.status]).toEqual([path, 200]);
        expect([path, noBearer.status]).toEqual([path, 200]);
        expect([path, ownerless.status]).toEqual([path, 200]);
        continue;
      }

      expect([path, wrongBearer.status]).toEqual([path, 401]);
      expect([path, noBearer.status]).toEqual([path, 401]);
      expect([path, ownerless.status]).toEqual([
        path,
        policy === "owner-only-when-held" ? 200 : 503,
      ]);
    }
  });
});
