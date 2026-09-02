import { describe, expect, it, vi } from "vitest";
import { ViewportFitCoordinator } from "./viewport-fit-coordinator.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe("ViewportFitCoordinator", () => {
  it("submits the first and latest resize while dropping intermediate sizes", async () => {
    const coordinator = new ViewportFitCoordinator();
    const first = deferred();
    const latest = deferred();
    const submitted: string[] = [];
    const succeeded: string[] = [];
    const request = (key: string, promise: Promise<void>) =>
      coordinator.request({
        key,
        execute: () => {
          submitted.push(key);
          return promise;
        },
        onSuccess: () => succeeded.push(key),
        onFailure: () => undefined,
      });

    request("lane:100x30", first.promise);
    request("lane:110x32", Promise.resolve());
    request("lane:120x34", Promise.resolve());
    request("lane:132x38", latest.promise);
    expect(submitted).toEqual(["lane:100x30"]);
    expect(coordinator.snapshot()).toEqual({
      activeKey: "lane:100x30",
      pendingKey: "lane:132x38",
    });

    first.resolve();
    await vi.waitFor(() => expect(submitted).toEqual(["lane:100x30", "lane:132x38"]));
    latest.resolve();
    await vi.waitFor(() => expect(succeeded).toEqual(["lane:100x30", "lane:132x38"]));
    expect(coordinator.snapshot()).toEqual({ activeKey: null, pendingKey: null });
  });

  it("does not publish a retired generation completion or its queued size", async () => {
    const coordinator = new ViewportFitCoordinator();
    const stale = deferred();
    const success = vi.fn();
    const failure = vi.fn();
    const executeQueued = vi.fn(async () => undefined);
    coordinator.request({
      key: "old:100x30",
      execute: () => stale.promise,
      onSuccess: success,
      onFailure: failure,
    });
    coordinator.request({
      key: "old:120x34",
      execute: executeQueued,
      onSuccess: success,
      onFailure: failure,
    });

    coordinator.retire();
    stale.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(success).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(executeQueued).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toEqual({ activeKey: null, pendingKey: null });
  });

  it("clears an obsolete queued size when the final target returns to the active size", async () => {
    const coordinator = new ViewportFitCoordinator();
    const first = deferred();
    const intermediate = vi.fn(async () => undefined);
    coordinator.request({
      key: "lane:132x38",
      execute: () => first.promise,
      onSuccess: () => undefined,
      onFailure: () => undefined,
    });
    coordinator.request({
      key: "lane:148x42",
      execute: intermediate,
      onSuccess: () => undefined,
      onFailure: () => undefined,
    });
    coordinator.request({
      key: "lane:132x38",
      execute: () => first.promise,
      onSuccess: () => undefined,
      onFailure: () => undefined,
    });
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(intermediate).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toEqual({ activeKey: null, pendingKey: null });
  });

  it("drains the final target when the first submission throws synchronously", async () => {
    const coordinator = new ViewportFitCoordinator();
    const failed = vi.fn();
    const submitted: string[] = [];
    coordinator.request({
      key: "lane:100x30",
      execute: () => {
        coordinator.request({
          key: "lane:132x38",
          execute: async () => {
            submitted.push("lane:132x38");
          },
          onSuccess: () => undefined,
          onFailure: () => undefined,
        });
        throw new Error("authority retired");
      },
      onSuccess: () => undefined,
      onFailure: failed,
    });

    await vi.waitFor(() => expect(submitted).toEqual(["lane:132x38"]));
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: "authority retired" }));
  });
});
