import { describe, expect, it, vi } from "vitest";

import { createApplicationPendingTerminalInputOwner } from "./application-pending-terminal-input.ts";

describe("application pending terminal input", () => {
  it("replays first key and paste once only into the exact focused generation", () => {
    const owner = createApplicationPendingTerminalInputOwner();
    const delivered: string[] = [];
    const opening = owner.begin("alpha");
    expect(owner.enqueue(() => delivered.push("key"))).toBe("queued");
    expect(owner.enqueue(() => delivered.push("paste"), 128)).toBe("queued");
    expect(owner.settle(opening, { opened: true, generationKey: "daemon:1:1" })).toEqual({
      status: "ready",
      queued: 2,
    });

    expect(
      owner.flush({
        sessionName: "alpha",
        generationKey: "daemon:1:1",
        focusedPane: null,
      }),
    ).toEqual({ status: "waiting", queued: 2 });
    expect(delivered).toEqual([]);
    expect(
      owner.flush({
        sessionName: "alpha",
        generationKey: "daemon:1:1",
        focusedPane: "pane.one",
      }),
    ).toEqual({ status: "flushed", delivered: 2 });
    expect(delivered).toEqual(["key", "paste"]);
    expect(
      owner.flush({
        sessionName: "alpha",
        generationKey: "daemon:1:1",
        focusedPane: "pane.one",
      }),
    ).toEqual({ status: "idle" });
  });

  it("fences queued input when another generation wins", () => {
    const owner = createApplicationPendingTerminalInputOwner();
    const deliver = vi.fn();
    const opening = owner.begin("alpha");
    owner.enqueue(deliver);
    owner.settle(opening, { opened: true, generationKey: "daemon-a:1:1" });

    expect(
      owner.flush({
        sessionName: "beta",
        generationKey: "daemon-b:1:1",
        focusedPane: "pane.beta",
      }),
    ).toEqual({ status: "superseded", discarded: 1 });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("makes authoritative-empty or failed attachment a typed unavailable outcome", () => {
    const owner = createApplicationPendingTerminalInputOwner();
    const empty = owner.begin("alpha");
    owner.enqueue(vi.fn());
    expect(owner.settle(empty, { opened: true, generationKey: null })).toEqual({
      status: "unavailable",
      discarded: 1,
    });

    const failed = owner.begin("beta");
    owner.enqueue(vi.fn());
    expect(owner.settle(failed, { opened: false, generationKey: null })).toEqual({
      status: "unavailable",
      discarded: 1,
    });
  });

  it("bounds pending input without disturbing an already admitted FIFO", () => {
    const owner = createApplicationPendingTerminalInputOwner({
      maximumInputs: 2,
      maximumWeight: 4,
    });
    owner.begin("alpha");
    expect(owner.enqueue(vi.fn(), 2)).toBe("queued");
    expect(owner.enqueue(vi.fn(), 2)).toBe("queued");
    expect(owner.enqueue(vi.fn(), 1)).toBe("overflow");
    expect(owner.snapshot()).toEqual({ sessionName: "alpha", queued: 2, settled: false });
  });
});
