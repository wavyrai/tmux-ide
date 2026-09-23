import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountTmuxServerNativeBackingRoute } from "./tmux-server-native-backing.ts";
import { TmuxServerScopeError, type TmuxServerOwners } from "../lib/tmux-server-owners.ts";
import type { NativeTmuxServerOwner } from "../lib/tmux-server-owner.ts";
const generation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const a = `tmux-server.${"a".repeat(32)}`;
const b = `tmux-server.${"b".repeat(32)}`;
describe("scoped native backing", () => {
  it("routes identical workspace/pane IDs only to their selected owner and retains auth", async () => {
    const captureA = vi.fn(async () => ({ status: "unavailable" }));
    const captureB = vi.fn(async () => ({ status: "unavailable" }));
    const owner = (capture: typeof captureA) =>
      ({
        generation,
        workspaceRegistry: { get: () => ({ sessionName: "same" }) },
        sessionRuntimeRegistry: { captureNativeBacking: capture },
      }) as unknown as NativeTmuxServerOwner;
    const ownersById = new Map([
      [a, owner(captureA)],
      [b, owner(captureB)],
    ]);
    const owners = {
      withOwner: async (
        scope: { serverId: string; generation: string },
        work: (owner: NativeTmuxServerOwner) => Promise<Response>,
      ) => {
        if (scope.generation !== generation) throw new TmuxServerScopeError("stale-generation");
        return work(ownersById.get(scope.serverId)!);
      },
    } as unknown as TmuxServerOwners<NativeTmuxServerOwner>;
    const app = new Hono();
    mountTmuxServerNativeBackingRoute(app, {
      scopedPath: "/servers/:serverId/:generation",
      ownerToken: "owner",
      owners,
    });
    const path = (id: string, g = generation) =>
      `/servers/${id}/${g}/native-backing/same/pane.same?generation=${g}&incarnation=current&revision=0&stateHash=hash`;
    expect((await app.request(path(a))).status).toBe(401);
    expect(captureA).not.toHaveBeenCalled();
    expect(
      (await app.request(path(b), { headers: { Authorization: "Bearer owner" } })).status,
    ).toBe(409);
    expect(captureA).not.toHaveBeenCalled();
    expect(captureB).toHaveBeenCalledWith("same", "pane.same", {
      generation,
      incarnation: "current",
      revision: 0,
      stateHash: "hash",
    });
    expect(
      (
        await app.request(path(a, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), {
          headers: { Authorization: "Bearer owner" },
        })
      ).status,
    ).toBe(409);
    expect(captureA).not.toHaveBeenCalled();
  });
});
