import { describe, expect, it, vi } from "vitest";
import { AsyncDisposableSlot, type AsyncDisposer } from "./async-disposable-slot.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AsyncDisposableSlot", () => {
  it("retires a resource that resolves after its owner is disposed", async () => {
    const pending = deferred<AsyncDisposer>();
    const stop = vi.fn();
    const slot = new AsyncDisposableSlot<string>();

    slot.ensure("/workspace", () => pending.promise);
    expect(slot.key).toBe("/workspace");
    slot.dispose();
    expect(slot.key).toBeNull();

    pending.resolve(stop);
    await settle();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("never lets an older generation replace the current resource", async () => {
    const first = deferred<AsyncDisposer>();
    const second = deferred<AsyncDisposer>();
    const stopFirst = vi.fn();
    const stopSecond = vi.fn();
    const slot = new AsyncDisposableSlot<string>();

    slot.ensure("one", () => first.promise);
    slot.ensure("two", () => second.promise);
    second.resolve(stopSecond);
    await settle();
    first.resolve(stopFirst);
    await settle();

    expect(stopFirst).toHaveBeenCalledOnce();
    expect(stopSecond).not.toHaveBeenCalled();
    expect(slot.key).toBe("two");

    slot.dispose();
    expect(stopSecond).toHaveBeenCalledOnce();
  });

  it("clears a failed generation so the same key can retry", async () => {
    const slot = new AsyncDisposableSlot<string>();
    const stop = vi.fn();

    slot.ensure("workspace", () => Promise.reject(new Error("unavailable")));
    await settle();
    expect(slot.key).toBeNull();

    slot.ensure("workspace", async () => stop);
    await settle();
    expect(slot.key).toBe("workspace");
    slot.dispose();
    expect(stop).toHaveBeenCalledOnce();
  });
});
