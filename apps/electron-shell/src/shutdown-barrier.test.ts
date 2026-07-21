import { describe, expect, it, vi } from "vitest";

import { ShutdownBarrier } from "./shutdown-barrier.ts";

describe("ShutdownBarrier", () => {
  it("runs tasks once when quit paths race", async () => {
    const barrier = new ShutdownBarrier();
    const task = vi.fn(async () => undefined);

    const first = barrier.run([task]);
    const second = barrier.run([vi.fn()]);

    expect(first).toBe(second);
    await first;
    expect(task).toHaveBeenCalledOnce();
  });

  it("settles every task and reports all failures", async () => {
    const barrier = new ShutdownBarrier();
    const completed = vi.fn();

    await expect(
      barrier.run([
        () => {
          throw new Error("first");
        },
        completed,
        async () => {
          throw new Error("second");
        },
      ]),
    ).rejects.toMatchObject({ errors: [new Error("first"), new Error("second")] });
    expect(completed).toHaveBeenCalledOnce();
  });
});
