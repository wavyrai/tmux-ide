import { describe, expect, it } from "bun:test";

import { FirstLatestCoordinator } from "./first-latest-coordinator.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("FirstLatestCoordinator", () => {
  it("runs the first and latest request while superseding intermediate work", async () => {
    const coordinator = new FirstLatestCoordinator();
    const first = deferred();
    const latest = deferred();
    const events: string[] = [];
    const request = (key: string, execution: Promise<void>) => ({
      key,
      execute: () => execution,
      onSuccess: () => events.push(`${key}:ok`),
      onFailure: () => events.push(`${key}:failed`),
      onSuperseded: () => events.push(`${key}:superseded`),
    });

    expect(coordinator.request(request("80x24", first.promise))).toBe("started");
    expect(coordinator.request(request("90x30", Promise.resolve()))).toBe("queued");
    expect(coordinator.request(request("100x40", latest.promise))).toBe("queued");
    expect(events).toEqual(["90x30:superseded"]);
    expect(coordinator.snapshot()).toEqual({ activeKey: "80x24", pendingKey: "100x40" });

    first.resolve();
    await settle();
    expect(events).toEqual(["90x30:superseded", "80x24:ok"]);
    latest.resolve();
    await settle();
    expect(events).toEqual(["90x30:superseded", "80x24:ok", "100x40:ok"]);
  });

  it("coalesces equal active/pending keys and fences late retirement", async () => {
    const coordinator = new FirstLatestCoordinator();
    const active = deferred();
    const events: string[] = [];
    const request = (key: string) => ({
      key,
      execute: () => active.promise,
      onSuccess: () => events.push(`${key}:ok`),
      onFailure: () => events.push(`${key}:failed`),
      onSuperseded: () => events.push(`${key}:superseded`),
    });

    expect(coordinator.request(request("a"))).toBe("started");
    expect(coordinator.request(request("b"))).toBe("queued");
    expect(coordinator.request(request("b"))).toBe("coalesced-pending");
    expect(coordinator.request(request("a"))).toBe("coalesced-active");
    expect(events).toEqual(["b:superseded"]);
    coordinator.retire();
    active.resolve();
    await settle();
    expect(events).toEqual(["b:superseded"]);
    expect(coordinator.snapshot()).toEqual({ activeKey: null, pendingKey: null });
  });

  it("settles synchronous throws through the failure callback", () => {
    const coordinator = new FirstLatestCoordinator();
    const error = new Error("boom");
    let observed: unknown = null;
    coordinator.request({
      key: "bad",
      execute: () => {
        throw error;
      },
      onSuccess: () => undefined,
      onFailure: (failure) => (observed = failure),
    });
    expect(observed).toBe(error);
    expect(coordinator.snapshot()).toEqual({ activeKey: null, pendingKey: null });
  });

  it("drains retained work when success and failure observers throw", async () => {
    const coordinator = new FirstLatestCoordinator();
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const executions: string[] = [];

    coordinator.request({
      key: "first",
      execute: () => {
        executions.push("first");
        return first.promise;
      },
      onSuccess: () => {
        throw new Error("success observer");
      },
      onFailure: () => undefined,
    });
    coordinator.request({
      key: "second",
      execute: () => {
        executions.push("second");
        return second.promise;
      },
      onSuccess: () => undefined,
      onFailure: () => {
        throw new Error("failure observer");
      },
    });

    first.resolve();
    await settle();
    expect(executions).toEqual(["first", "second"]);
    expect(coordinator.snapshot()).toEqual({ activeKey: "second", pendingKey: null });

    coordinator.request({
      key: "third",
      execute: () => {
        executions.push("third");
        return third.promise;
      },
      onSuccess: () => undefined,
      onFailure: () => undefined,
    });
    second.reject(new Error("execution failed"));
    await settle();
    expect(executions).toEqual(["first", "second", "third"]);
    expect(coordinator.snapshot()).toEqual({ activeKey: "third", pendingKey: null });

    third.resolve();
    await settle();
    expect(coordinator.snapshot()).toEqual({ activeKey: null, pendingKey: null });
  });

  it("retains the latest request when superseded observers throw and retires cleanly", async () => {
    const coordinator = new FirstLatestCoordinator();
    const active = deferred();
    const latest = deferred();
    const executions: string[] = [];
    const request = (key: string, execution: Promise<void>, onSuperseded?: () => void) => ({
      key,
      execute: () => {
        executions.push(key);
        return execution;
      },
      onSuccess: () => undefined,
      onFailure: () => undefined,
      onSuperseded,
    });

    coordinator.request(request("active", active.promise));
    coordinator.request(
      request("intermediate", Promise.resolve(), () => {
        throw new Error("superseded observer");
      }),
    );
    expect(() => coordinator.request(request("latest", latest.promise))).not.toThrow();
    expect(coordinator.snapshot()).toEqual({ activeKey: "active", pendingKey: "latest" });

    active.resolve();
    await settle();
    expect(executions).toEqual(["active", "latest"]);
    coordinator.retire();
    latest.resolve();
    await settle();
    expect(coordinator.snapshot()).toEqual({ activeKey: null, pendingKey: null });
  });
});
