import { describe, expect, it, vi } from "vitest";

import { runDaemonPreflight, type DaemonPreflight } from "./daemon-preflight.ts";

describe("runDaemonPreflight", () => {
  it("returns an injected probe result", async () => {
    const probe = vi.fn(async () => ({ status: "absent" as const }));

    await expect(runDaemonPreflight({ probe })).resolves.toEqual({ status: "absent" });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("converts probe failures into an unavailable result", async () => {
    const preflight: DaemonPreflight = {
      probe: async () => {
        throw new Error("socket rejected");
      },
    };

    await expect(runDaemonPreflight(preflight)).resolves.toEqual({
      status: "unavailable",
      reason: "socket rejected",
    });
  });

  it("bounds a probe and aborts its signal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const preflight: DaemonPreflight = {
      probe: (nextSignal) => {
        signal = nextSignal;
        return new Promise(() => undefined);
      },
    };

    const result = runDaemonPreflight(preflight, 25);
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toEqual({
      status: "unavailable",
      reason: "Daemon preflight timed out after 25ms.",
    });
    expect(signal?.aborted).toBe(true);
    vi.useRealTimers();
  });
});
