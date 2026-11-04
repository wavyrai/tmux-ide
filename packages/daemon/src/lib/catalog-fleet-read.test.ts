import { describe, expect, it, vi } from "vitest";
import { readCatalogFleet } from "./catalog-fleet-read.ts";
import { createTmuxSessionMutationFence } from "./tmux-session-mutation-fence.ts";
import { liveSessionIdForNativeIdentity } from "../terminal/protocol/live-session-identity.ts";

// #709 round 2: which runner the catalog fleet read uses is part of the tmux
// server-generation contract, so both branches are pinned here.
const registry = { list: () => [] };
const answer = (args: readonly string[]) => (args[0] === "list-sessions" ? "alpha\t1\n" : "");

function runners() {
  const fence = createTmuxSessionMutationFence();
  const sync = vi.fn((args: string[]) => answer(args));
  const generationFencedAsync = vi.fn(async (args: string[]) => answer(args));
  return { fence, sync, generationFencedAsync, fencedSync: fence.wrap(sync) };
}

describe("catalog fleet read runner (#709)", () => {
  it("outside a session mutation, reads through the generation-fenced async runner", async () => {
    const r = runners();
    const fleet = await readCatalogFleet(registry, r);
    expect(fleet?.map((session) => session.name)).toEqual(["alpha"]);
    expect(r.generationFencedAsync).toHaveBeenCalledWith(expect.arrayContaining(["list-sessions"]));
    expect(r.sync).not.toHaveBeenCalled();
  });

  it("inside a session mutation, reads through the fence's synchronous runner", async () => {
    const r = runners();
    const [pid, id, created] = ["4242", "$7", "1700000000"];
    const fleet = await r.fence.execute({
      liveSessionId: liveSessionIdForNativeIdentity(pid, id, created),
      sessionName: "alpha",
      run: async () => `${pid}\t${id}\t${created}\talpha\n`,
      mutate: () => readCatalogFleet(registry, r),
    });
    expect(fleet).not.toBeNull();
    expect(r.generationFencedAsync).not.toHaveBeenCalled();
    // The fence wrapped every read in its live-session check.
    expect(r.sync).toHaveBeenCalled();
    for (const [args] of r.sync.mock.calls) expect(args[0]).toBe("if-shell");
  });
});
