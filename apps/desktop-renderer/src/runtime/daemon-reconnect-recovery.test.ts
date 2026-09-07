import { afterEach, expect, it, vi } from "vitest";
import { createDaemonReconnectRecovery } from "./daemon-reconnect-recovery.ts";

afterEach(() => vi.useRealTimers());

it("does no work for initial loading or a healthy workspace", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(async () => {});
  const recovery = createDaemonReconnectRecovery(refresh);
  recovery.observe("a", "loading");
  recovery.observe("a", "stale");
  recovery.observe("a", "live");
  await vi.runAllTimersAsync();
  expect(refresh).not.toHaveBeenCalled();
  recovery.dispose();
});

it("coalesces stale observations and stops when the new generation is adopted", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(async () => {});
  const recovery = createDaemonReconnectRecovery(refresh);
  recovery.observe("a", "live");
  for (let index = 0; index < 50; index++) recovery.observe("a", "stale");
  await vi.advanceTimersByTimeAsync(250);
  expect(refresh).toHaveBeenCalledTimes(1);
  recovery.observe("b", "loading");
  await vi.runAllTimersAsync();
  expect(refresh).toHaveBeenCalledTimes(1);
  recovery.dispose();
});

it("retries a temporarily absent daemon and bounds persistent failure", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(async () => {
    throw new Error("unavailable");
  });
  const recovery = createDaemonReconnectRecovery(refresh);
  recovery.observe("a", "live");
  recovery.observe("a", "stale");
  await vi.runAllTimersAsync();
  expect(refresh).toHaveBeenCalledTimes(8);
  recovery.observe("a", "stale");
  await vi.runAllTimersAsync();
  expect(refresh).toHaveBeenCalledTimes(8);
  recovery.observe("a", "live");
  recovery.observe("a", "stale");
  await vi.advanceTimersByTimeAsync(250);
  expect(refresh).toHaveBeenCalledTimes(9);
  recovery.dispose();
});

it("never overlaps probes and retires late completion on disposal", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const refresh = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const recovery = createDaemonReconnectRecovery(refresh);
  recovery.observe("a", "live");
  recovery.observe("a", "stale");
  await vi.advanceTimersByTimeAsync(250);
  recovery.stop();
  recovery.observe("b", "live");
  recovery.observe("b", "stale");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  recovery.dispose();
  finish();
  await vi.runAllTimersAsync();
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["live", "stop"])("cancels a pending probe on %s", async (action) => {
  vi.useFakeTimers();
  const refresh = vi.fn(async () => {});
  const recovery = createDaemonReconnectRecovery(refresh);
  recovery.observe("a", "live");
  recovery.observe("a", "stale");
  if (action === "stop") recovery.stop();
  else recovery.observe("a", "live");
  await vi.runAllTimersAsync();
  expect(refresh).not.toHaveBeenCalled();
  recovery.dispose();
});
