import { describe, expect, it } from "vitest";
import { BOUNDED_TMUX_KILL_GRACE_MS, boundedTmuxRead } from "./bounded-tmux-read.ts";

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

describe("bounded tmux read", () => {
  it("returns the output of a client that finishes in time", async () => {
    await expect(
      boundedTmuxRead("/bin/sh", ["-c", "printf ready"], { env, timeoutMs: 5_000 }),
    ).resolves.toBe("ready");
  });

  it("rejects a failing client", async () => {
    await expect(
      boundedTmuxRead("/bin/sh", ["-c", "exit 3"], { env, timeoutMs: 5_000 }),
    ).rejects.toThrow();
  });

  // #839: every daemon teardown stage that talks to tmux relies on this bound.
  it("keeps its deadline when a grandchild still holds the pipes after the child is killed", async () => {
    const started = performance.now();
    await expect(
      // The shell ignores TERM and leaves a sleeper holding stdout and stderr.
      boundedTmuxRead("/bin/sh", ["-c", "trap '' TERM; sleep 30 & wait"], {
        env,
        timeoutMs: 100,
      }),
    ).rejects.toThrow("deadline exceeded");
    expect(performance.now() - started).toBeLessThan(100 + BOUNDED_TMUX_KILL_GRACE_MS * 2 + 2_000);
  }, 10_000);

  it("is bounded the same way when cancelled by its signal", async () => {
    const abort = new AbortController();
    const reading = boundedTmuxRead("/bin/sh", ["-c", "trap '' TERM; sleep 30 & wait"], {
      env,
      timeoutMs: 60_000,
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 50);
    const started = performance.now();
    await expect(reading).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(3_000);
  }, 10_000);
});
