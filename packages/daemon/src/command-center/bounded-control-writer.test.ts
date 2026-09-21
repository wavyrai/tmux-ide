import { afterEach, expect, it, vi } from "vitest";
import { createBoundedControlWriter } from "./bounded-control-writer.ts";
afterEach(() => vi.useRealTimers());
it("accounts for UTF8 in-flight frames and physical socket pressure independently per peer", () => {
  vi.useFakeTimers();
  const close = vi.fn();
  const slow = createBoundedControlWriter({ bufferedAmount: 0, send: vi.fn() }, close, {
    entries: 2,
    bytes: 8,
    timeoutMs: 100,
  });
  const received: string[] = [];
  const good = createBoundedControlWriter(
    {
      send: (data, callback) => {
        received.push(data);
        callback();
      },
    },
    vi.fn(),
    { entries: 2, bytes: 8, timeoutMs: 100 },
  );
  for (const data of ["é", "é", "é"]) {
    slow.send(data);
    good.send(data);
  }
  expect(close).toHaveBeenCalledOnce();
  expect(slow.snapshot()).toEqual({ entries: 0, bytes: 0, disposed: true });
  expect(received).toHaveLength(3);
  expect(good.snapshot().bytes).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  const pressured = createBoundedControlWriter({ bufferedAmount: 8, send: vi.fn() }, close, {
    entries: 2,
    bytes: 8,
    timeoutMs: 100,
  });
  pressured.send("a");
  expect(close).toHaveBeenCalledTimes(2);
});
it("retires blocked/error sends and ignores late callbacks after disposal", async () => {
  vi.useFakeTimers();
  let callback!: (error?: Error) => void;
  const close = vi.fn();
  const writer = createBoundedControlWriter(
    {
      send: (_data, done) => {
        callback = done;
      },
    },
    close,
    { entries: 2, bytes: 8, timeoutMs: 100 },
  );
  writer.send("a");
  await vi.advanceTimersByTimeAsync(101);
  expect(close).toHaveBeenCalledOnce();
  callback();
  expect(writer.snapshot().bytes).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  const broken = createBoundedControlWriter(
    { send: (_data, done) => done(new Error("socket")) },
    close,
  );
  broken.send("a");
  expect(close).toHaveBeenCalledTimes(2);
});
