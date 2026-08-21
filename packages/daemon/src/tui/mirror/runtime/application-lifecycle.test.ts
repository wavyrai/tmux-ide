import { describe, expect, it, vi } from "vitest";

import { TuiCleanupRegistry } from "../input-lifecycle.ts";
import { runtimeResourceSnapshot } from "@tmux-ide/daemon-client/runtime-resource-ledger";
import {
  TuiApplicationLifecycle,
  createApplicationLifecycleInputExecutor,
} from "./application-lifecycle.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("OpenTUI application lifecycle", () => {
  it("returns one shutdown Promise and destroys the renderer after every owned resource settles", async () => {
    const timerBaseline = runtimeResourceSnapshot()["host-shutdown-timer"].active;
    const calls: string[] = [];
    const child = deferred();
    const socket = deferred();
    const lifecycle = new TuiApplicationLifecycle({
      destroyRenderer: () => calls.push("renderer"),
      shutdownTimeoutMs: 1_000,
    });
    lifecycle.trackPending("fleet-child", {
      cancel: () => calls.push("kill-child"),
      settled: child.promise.then(() => calls.push("child-settled")),
    });
    lifecycle.registerCloser("event-socket", () => {
      calls.push("close-socket");
      return socket.promise.then(() => calls.push("socket-settled"));
    });

    const first = lifecycle.shutdown("keyboard");
    const duplicate = lifecycle.shutdown("palette");
    expect(runtimeResourceSnapshot()["host-shutdown-timer"].active).toBe(timerBaseline + 1);

    expect(first).toBe(duplicate);
    expect(lifecycle.accepting).toBe(false);
    expect(lifecycle.signal.aborted).toBe(true);
    expect(calls).toEqual(["kill-child", "close-socket"]);

    child.resolve();
    await Promise.resolve();
    expect(calls).not.toContain("renderer");
    socket.resolve();
    await expect(first).resolves.toEqual({ reason: "keyboard", failures: [], timedOut: [] });
    expect(runtimeResourceSnapshot()["host-shutdown-timer"].active).toBe(timerBaseline);
    expect(calls).toEqual([
      "kill-child",
      "close-socket",
      "child-settled",
      "socket-settled",
      "renderer",
    ]);
  });

  it("continues through cleanup failures, pending rejection, and a stuck child deadline", async () => {
    const calls: string[] = [];
    const stuck = deferred();
    let releaseDeadline!: () => void;
    const cleanup = new TuiCleanupRegistry();
    cleanup.set("watcher", () => {
      calls.push("watcher");
      throw new Error("watcher close failed");
    });
    const lifecycle = new TuiApplicationLifecycle({
      cleanupRegistry: cleanup,
      destroyRenderer: () => calls.push("renderer"),
      shutdownTimeoutMs: 20,
      setTimer: (callback) => {
        releaseDeadline = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: vi.fn(),
    });
    lifecycle.trackPending("stuck-child", {
      cancel: () => calls.push("kill-stuck"),
      settled: stuck.promise,
    });
    lifecycle.registerCloser("bad-subscription", () => Promise.reject(new Error("close failed")));

    const shutdown = lifecycle.shutdown("host");
    await Promise.resolve();
    releaseDeadline();
    const report = await shutdown;

    expect(calls).toEqual(["kill-stuck", "watcher", "renderer"]);
    expect(report.timedOut).toEqual(["stuck-child"]);
    expect(report.failures.map(({ name, phase }) => [name, phase])).toEqual([
      ["watcher", "cleanup"],
      ["bad-subscription", "close"],
    ]);
    const frozenFailures = [...report.failures];
    stuck.reject(new Error("late child failure"));
    await Promise.resolve();
    expect(report.failures).toEqual(frozenFailures);
  });

  it("blocks late watcher callbacks and immediately retires late resources and work", async () => {
    const delivered: string[] = [];
    const lateTask = deferred();
    const cancel = vi.fn();
    const close = vi.fn();
    const lifecycle = new TuiApplicationLifecycle({ destroyRenderer: vi.fn() });
    const watcherCallback = lifecycle.guard((value: string) => delivered.push(value));
    watcherCallback("before");

    await lifecycle.shutdown("host");
    watcherCallback("after");
    lifecycle.registerCloser("late-watcher", close);
    lifecycle.trackPending("late-child", { cancel, settled: lateTask.promise });

    expect(delivered).toEqual(["before"]);
    expect(close).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    lateTask.resolve();
    await Promise.resolve();
  });

  it("publishes the shared shutdown Promise before reentrant cleanup and retires replaced closers", async () => {
    const calls: string[] = [];
    const firstCloser = vi.fn(() => calls.push("first-closer"));
    const secondCloser = vi.fn(() => calls.push("second-closer"));
    const lifecycle = new TuiApplicationLifecycle({
      destroyRenderer: () => calls.push("renderer"),
    });
    let reentrant: Promise<unknown> | null = null;
    lifecycle.registerCleanup("reentrant", () => {
      calls.push("cleanup");
      reentrant = lifecycle.shutdown("host");
    });
    lifecycle.registerCloser("socket", firstCloser);
    lifecycle.registerCloser("socket", secondCloser);

    const shutdown = lifecycle.shutdown("keyboard");
    expect(reentrant).toBe(shutdown);
    await shutdown;

    expect(firstCloser).toHaveBeenCalledOnce();
    expect(secondCloser).toHaveBeenCalledOnce();
    expect(calls).toEqual(["first-closer", "cleanup", "second-closer", "renderer"]);
  });

  it("awaits a replaced async closer before destroying the renderer", async () => {
    const calls: string[] = [];
    const replaced = deferred();
    const lifecycle = new TuiApplicationLifecycle({
      destroyRenderer: () => calls.push("renderer"),
    });
    lifecycle.registerCloser("watcher", () => {
      calls.push("close-replaced");
      return replaced.promise;
    });
    lifecycle.registerCloser("watcher", () => calls.push("close-current"));

    const shutdown = lifecycle.shutdown("host");
    await Promise.resolve();
    expect(calls).toEqual(["close-replaced", "close-current"]);
    replaced.resolve();
    await shutdown;

    expect(calls).toEqual(["close-replaced", "close-current", "renderer"]);
  });

  it("drains a closer registered while pending work settles", async () => {
    const calls: string[] = [];
    const pending = deferred();
    const lateClose = deferred();
    const lifecycle = new TuiApplicationLifecycle({
      destroyRenderer: () => calls.push("renderer"),
    });
    lifecycle.trackPending("watcher-open", {
      cancel: () => calls.push("cancel-open"),
      settled: pending.promise.then(() => {
        lifecycle.registerCloser("late-watcher", () => {
          calls.push("close-late-watcher");
          return lateClose.promise;
        });
      }),
    });

    const shutdown = lifecycle.shutdown("host");
    pending.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["cancel-open", "close-late-watcher"]);
    lateClose.resolve();
    await shutdown;

    expect(calls).toEqual(["cancel-open", "close-late-watcher", "renderer"]);
  });

  it("waits for pending work registered reentrantly during shutdown", async () => {
    const order: string[] = [];
    const late = deferred<void>();
    const lifecycle = new TuiApplicationLifecycle({
      destroyRenderer: () => order.push("renderer"),
      shutdownTimeoutMs: 1_000,
    });
    lifecycle.registerCleanup("reentrant", () => {
      lifecycle.trackPending("late-pending", {
        cancel: () => order.push("late-cancel"),
        settled: late.promise.then(() => order.push("late-settled")),
      });
    });

    const shutdown = lifecycle.shutdown("host");
    await Promise.resolve();
    expect(order).toEqual(["late-cancel"]);
    late.resolve();
    await expect(shutdown).resolves.toMatchObject({ timedOut: [] });
    expect(order).toEqual(["late-cancel", "late-settled", "renderer"]);
  });

  it("routes the existing input lifecycle into async shutdown without process exit", async () => {
    const destroy = vi.fn();
    const lifecycle = new TuiApplicationLifecycle({ destroyRenderer: destroy });
    const executor = createApplicationLifecycleInputExecutor(lifecycle, {
      putAway: vi.fn(),
    });

    executor.run({ kind: "destroy-renderer", source: "palette" });
    executor.run({ kind: "destroy-renderer", source: "palette" });
    const report = await lifecycle.shutdown("host");

    expect(destroy).toHaveBeenCalledOnce();
    expect(report.reason).toBe("palette");
  });

  it("awaits replaced in-flight work before destroying the renderer", async () => {
    const calls: string[] = [];
    const replaced = deferred();
    const current = deferred();
    const lifecycle = new TuiApplicationLifecycle({
      destroyRenderer: () => calls.push("renderer"),
    });
    lifecycle.trackPending("fleet", {
      cancel: () => calls.push("cancel-replaced"),
      settled: replaced.promise,
    });
    lifecycle.trackPending("fleet", {
      cancel: () => calls.push("cancel-current"),
      settled: current.promise,
    });

    const shutdown = lifecycle.shutdown("host");
    current.resolve();
    await Promise.resolve();
    expect(calls).not.toContain("renderer");
    replaced.resolve();
    await shutdown;

    expect(calls).toEqual(["cancel-replaced", "cancel-current", "renderer"]);
  });
});
