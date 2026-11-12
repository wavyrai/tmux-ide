import { describe, expect, it, vi } from "vitest";
import { createNativeOwnerTeardown } from "./tmux-server-owner-teardown.ts";

function parts() {
  const order: string[] = [];
  const paneStreams = {
    dispose: vi.fn(async (_close?: { code: number; reason: string }) => {
      order.push("streams");
    }),
  };
  const markRetired = vi.fn(() => void order.push("retired"));
  const begin = vi.fn((streamsClosed: Promise<void>) => {
    order.push("prelude");
    return [
      ["observer", async () => void order.push("observer")],
      ["pane-streams", () => streamsClosed],
      ["inventory", async () => void order.push("inventory")],
    ] as const;
  });
  return { order, paneStreams, markRetired, begin };
}

// Review B2 (R33): the owner must pass on WHY it is disposed, or its streams hear "daemon-shutdown".
describe("native tmux server owner teardown", () => {
  it.each([
    ["server-gone", { code: 1012, reason: "tmux-server-retired" }],
    ["server-replaced", { code: 1012, reason: "tmux-server-retired" }],
    ["removed", { code: 1012, reason: "tmux-server-retired" }],
    ["generation-restart", { code: 1012, reason: "daemon-restarting" }],
    ["shutdown", { code: 1001, reason: "daemon-shutdown" }],
    [undefined, { code: 1001, reason: "daemon-shutdown" }],
  ] as const)("tells the pane streams the right close for %s", async (retirement, close) => {
    const p = parts();
    await createNativeOwnerTeardown({ serverId: "tmux-server.a", ...p })(retirement);
    expect(p.paneStreams.dispose).toHaveBeenCalledExactlyOnceWith(close);
  });

  it("refuses new work, closes the streams, then runs every step in order", async () => {
    const p = parts();
    await createNativeOwnerTeardown({ serverId: "tmux-server.a", ...p })("server-gone");
    expect(p.order).toEqual(["retired", "streams", "prelude", "observer", "inventory"]);
  });

  it("is idempotent and keeps the first reason", async () => {
    const p = parts();
    const dispose = createNativeOwnerTeardown({ serverId: "tmux-server.a", ...p });
    const first = dispose("server-gone");
    expect(dispose("shutdown")).toBe(first);
    await first;
    expect(p.paneStreams.dispose).toHaveBeenCalledExactlyOnceWith({
      code: 1012,
      reason: "tmux-server-retired",
    });
    expect(p.begin).toHaveBeenCalledTimes(1);
  });

  it("runs the remaining steps after a failure and reports all failures together", async () => {
    const p = parts();
    const ran: string[] = [];
    const dispose = createNativeOwnerTeardown({
      serverId: "tmux-server.a",
      ...p,
      begin: () => [
        ["a", () => Promise.reject(new Error("a failed"))],
        ["b", () => void ran.push("b")],
        [
          "c",
          () => {
            throw new Error("c failed");
          },
        ],
        ["d", () => void ran.push("d")],
      ],
    });
    const failure = await dispose("removed").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual([
      "a failed",
      "c failed",
    ]);
    expect(ran).toEqual(["b", "d"]);
  });

  it("reports each step under the owner's name to the stop diagnostics", async () => {
    const p = parts();
    const tracked: string[] = [];
    await createNativeOwnerTeardown({
      serverId: "tmux-server.a",
      ...p,
      track: async (step, work) => {
        tracked.push(step);
        return await work();
      },
    })("server-gone");
    expect(tracked).toEqual([
      "owner:tmux-server.a:observer",
      "owner:tmux-server.a:pane-streams",
      "owner:tmux-server.a:inventory",
    ]);
  });

  it("a failing stream shutdown fails the teardown without an unhandled rejection", async () => {
    const p = parts();
    p.paneStreams.dispose.mockRejectedValue(new Error("coordinator refused"));
    await expect(
      createNativeOwnerTeardown({ serverId: "tmux-server.a", ...p })("server-gone"),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(p.order).toContain("inventory");
  });
});
