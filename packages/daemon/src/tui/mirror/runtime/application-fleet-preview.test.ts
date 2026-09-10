import { afterEach, expect, it, vi } from "vitest";
import { createFleetPreviewOwner } from "./application-fleet-preview.ts";
afterEach(() => vi.useRealTimers());
it("debounces rapid navigation to one capture and rejects late replies after selection or disposal", async () => {
  vi.useFakeTimers();
  const publish = vi.fn();
  const owner = createFleetPreviewOwner(publish);
  let finish!: (value: string) => void;
  const first = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  for (let i = 0; i < 300; i++) owner.select(first);
  await vi.advanceTimersByTimeAsync(180);
  expect(first).toHaveBeenCalledOnce();
  const second = vi.fn(async () => "second host");
  owner.select(second);
  finish("stale first host");
  await vi.advanceTimersByTimeAsync(180);
  expect(publish).not.toHaveBeenCalledWith("stale first host");
  expect(publish).toHaveBeenLastCalledWith("second host");
  owner.select(first);
  owner.dispose();
  await vi.advanceTimersByTimeAsync(1000);
  expect(first).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not repeat a capture when metadata refreshes keep the same selected identity", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => "snapshot"),
    publish = vi.fn();
  const owner = createFleetPreviewOwner(publish);
  owner.select(read, "session@generation-1");
  await vi.advanceTimersByTimeAsync(200);
  for (let i = 0; i < 100; i++) {
    owner.select(read, "session@generation-1");
    await vi.advanceTimersByTimeAsync(200);
  }
  expect(read).toHaveBeenCalledOnce();
  owner.select(read, "session@generation-2");
  await vi.advanceTimersByTimeAsync(200);
  expect(read).toHaveBeenCalledTimes(2);
  owner.dispose();
});
