import { describe, expect, it, vi } from "vitest";
import { ROSTER_SETTLE_MS, waitForRosterTarget } from "./roster-target-wait.ts";

function roster(initial: { current: boolean; refreshing: boolean }) {
  const state = { ...initial };
  const listeners = new Set<() => void>();
  const stopped = vi.fn();
  return {
    state,
    stopped,
    publish: () => {
      for (const listener of [...listeners]) listener();
    },
    options: (signal = new AbortController().signal) => ({
      isCurrent: () => state.current,
      refreshing: () => state.refreshing,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          stopped();
        };
      },
      signal,
    }),
  };
}

/** The value a promise has settled to after a few microtasks, or "pending". */
async function soon<T>(promise: Promise<T>): Promise<T | "pending"> {
  let value: T | "pending" = "pending";
  void promise.then((settled) => (value = settled));
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  return value;
}

// PR #383's journey: a click during the roster's re-read was refused as stale.
describe("waiting for a roster that is re-reading", () => {
  it("answers at once when there is nothing to wait for", async () => {
    await expect(
      waitForRosterTarget(roster({ current: true, refreshing: true }).options()),
    ).resolves.toBe(true);
    // Not current and nothing being read: the row is gone, say so now, not at the bound.
    expect(
      await soon(waitForRosterTarget(roster({ current: false, refreshing: false }).options())),
    ).toBe(false);
  });

  it("resolves true when the re-read brings the row back", async () => {
    const r = roster({ current: false, refreshing: true });
    const waiting = waitForRosterTarget(r.options());
    r.publish();
    r.state.current = true;
    r.state.refreshing = false;
    r.publish();
    await expect(waiting).resolves.toBe(true);
    expect(r.stopped).toHaveBeenCalledTimes(1);
  });

  it("resolves false when the re-read ends without the row", async () => {
    const r = roster({ current: false, refreshing: true });
    const waiting = waitForRosterTarget(r.options());
    expect(await soon(waiting)).toBe("pending");
    r.state.refreshing = false;
    r.publish();
    expect(await soon(waiting)).toBe(false);
    expect(r.stopped).toHaveBeenCalledTimes(1);
  });

  it("stops at the bound with whatever holds then, and on abort with false", async () => {
    vi.useFakeTimers();
    try {
      const stuck = roster({ current: false, refreshing: true });
      const bounded = waitForRosterTarget(stuck.options());
      await vi.advanceTimersByTimeAsync(ROSTER_SETTLE_MS - 1);
      let done = false;
      void bounded.then(() => (done = true));
      await Promise.resolve();
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(bounded).resolves.toBe(false);
      expect(stuck.stopped).toHaveBeenCalledTimes(1);

      const aborting = roster({ current: false, refreshing: true });
      const controller = new AbortController();
      const aborted = waitForRosterTarget(aborting.options(controller.signal));
      controller.abort();
      await expect(aborted).resolves.toBe(false);
      expect(aborting.stopped).toHaveBeenCalledTimes(1);
      const already = new AbortController();
      already.abort();
      await expect(
        waitForRosterTarget(roster({ current: true, refreshing: true }).options(already.signal)),
      ).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes a publication delivered during subscribe", async () => {
    const r = roster({ current: false, refreshing: true });
    const options = r.options();
    const waiting = waitForRosterTarget({
      ...options,
      subscribe: (listener) => {
        r.state.current = true;
        listener();
        return options.subscribe(listener);
      },
    });
    await expect(waiting).resolves.toBe(true);
    expect(r.stopped).toHaveBeenCalledTimes(1);
  });
});
