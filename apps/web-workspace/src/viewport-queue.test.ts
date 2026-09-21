import { expect, it, vi } from "vitest";
import { createViewportQueue } from "./viewport-queue";

it("serializes and sends only the final queued size after an in-flight resize", async () => {
  let finish!: (ok: boolean) => void;
  const send = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((r) => {
          finish = r;
        }),
    )
    .mockResolvedValue(true);
  const queue = createViewportQueue(send, vi.fn());
  queue.request({ cols: 80, rows: 24 });
  queue.request({ cols: 90, rows: 30 });
  queue.request({ cols: 100, rows: 40 });
  expect(send).toHaveBeenCalledTimes(1);
  finish(true);
  await new Promise((r) => setTimeout(r, 0));
  expect(send.mock.calls.map((c) => c[0])).toEqual([
    { cols: 80, rows: 24 },
    { cols: 100, rows: 40 },
  ]);
  queue.request({ cols: 100, rows: 40 });
  expect(send).toHaveBeenCalledTimes(2);
});

it("drops pending sizes on authority failure and permits explicit retry", async () => {
  const error = vi.fn();
  const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  const queue = createViewportQueue(send, error);
  queue.request({ cols: 80, rows: 24 });
  queue.request({ cols: 90, rows: 30 });
  await new Promise((r) => setTimeout(r, 0));
  expect(send).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledTimes(1);
  queue.request({ cols: 90, rows: 30 });
  await new Promise((r) => setTimeout(r, 0));
  expect(send).toHaveBeenCalledTimes(2);
});

it("does not continue resizing after disposal", async () => {
  let finish!: (ok: boolean) => void;
  const send = vi.fn(
    () =>
      new Promise<boolean>((r) => {
        finish = r;
      }),
  );
  const error = vi.fn();
  const queue = createViewportQueue(send, error);
  queue.request({ cols: 80, rows: 24 });
  queue.request({ cols: 90, rows: 30 });
  queue.dispose();
  finish(false);
  await new Promise((r) => setTimeout(r, 0));
  expect(send).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
});
