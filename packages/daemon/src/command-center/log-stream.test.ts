import { afterEach, expect, it, vi } from "vitest";
import type { LogEntry } from "../lib/log.ts";
import { streamBoundedLogs } from "./log-stream.ts";
const entry = (msg = "line"): LogEntry => ({
  ts: "2026-01-01T00:00:00Z",
  level: "info",
  component: "test",
  msg,
});
function fixture(blocked = false) {
  const listeners = new Set<(entry: LogEntry) => void>();
  const aborters: Array<() => void> = [];
  const frames: Array<{ event: string; data: string }> = [];
  const stream = {
    onAbort: (listener: () => void) => aborters.push(listener),
    abort: vi.fn(() => {
      for (const listener of aborters) listener();
    }),
    writeSSE: vi.fn(async (frame: { event: string; data: string }) => {
      frames.push(frame);
      if (blocked) await new Promise(() => {});
    }),
  };
  const options = {
    backfill: () => [] as LogEntry[],
    subscribe: (listener: (entry: LogEntry) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    match: () => true,
    entries: 4,
    bytes: 1024,
    writeTimeoutMs: 100,
  };
  return {
    stream,
    options,
    listeners,
    frames,
    emit: (value = entry()) => {
      for (const listener of listeners) listener(value);
    },
  };
}
afterEach(() => vi.useRealTimers());
it("closes an overflowing slow reader and unsubscribes even when its write never settles", async () => {
  vi.useFakeTimers();
  const slow = fixture(true);
  const good = fixture();
  const slowDone = streamBoundedLogs(slow.stream, slow.options);
  const goodDone = streamBoundedLogs(good.stream, good.options);
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 10; i++) {
    slow.emit();
    good.emit();
    await vi.advanceTimersByTimeAsync(0);
  }
  await slowDone;
  expect(slow.stream.abort).toHaveBeenCalledOnce();
  expect(slow.listeners.size).toBe(0);
  expect(good.frames.filter((frame) => frame.event === "entry")).toHaveLength(10);
  good.stream.abort();
  await goodDone;
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds newest backfill and emits an explicit gap before bounded delivery", async () => {
  const test = fixture();
  const done = streamBoundedLogs(test.stream, {
    ...test.options,
    backfill: () => Array.from({ length: 1000 }, (_, index) => entry(String(index))),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(test.frames.map((frame) => frame.event)).toEqual(["gap", "entry", "entry", "bookmark"]);
  expect(test.frames[1]!.data).toContain('"998"');
  test.stream.abort();
  await done;
});
it("cleans up cancellation/deadline, already aborted streams, and synchronous subscription overflow", async () => {
  vi.useFakeTimers();
  const slow = fixture(true);
  const done = streamBoundedLogs(slow.stream, slow.options);
  await vi.advanceTimersByTimeAsync(101);
  await done;
  expect(slow.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  const cancelled = fixture(true);
  const cancellation = streamBoundedLogs(cancelled.stream, cancelled.options);
  await vi.advanceTimersByTimeAsync(0);
  cancelled.stream.abort();
  await cancellation;
  expect(cancelled.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  const subscribe = vi.fn();
  await streamBoundedLogs({ ...slow.stream, aborted: true }, { ...slow.options, subscribe });
  expect(subscribe).not.toHaveBeenCalled();
  const unsub = vi.fn();
  await streamBoundedLogs(fixture().stream, {
    ...slow.options,
    subscribe: (listener) => {
      listener(entry("x".repeat(2000)));
      return unsub;
    },
  });
  expect(unsub).toHaveBeenCalledOnce();
});
