import { describe, expect, it } from "vitest";
import { FrameCoalescer, type FrameCoalescerClock } from "./frame-coalescer.ts";

class ManualClock implements FrameCoalescerClock {
  time = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; run: () => void }>();

  now(): number {
    return this.time;
  }

  schedule(run: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.time + delayMs, run });
    return id;
  }

  cancel(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  advance(ms: number): void {
    this.time += ms;
    for (;;) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= this.time)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) return;
      this.tasks.delete(due[0]);
      due[1].run();
    }
  }

  get size(): number {
    return this.tasks.size;
  }
}

describe("FrameCoalescer", () => {
  it("publishes the first system-clock request in a microtask", async () => {
    let flushes = 0;
    const coalescer = new FrameCoalescer(() => flushes++);

    coalescer.request();
    coalescer.request();
    expect(flushes).toBe(0);
    await Promise.resolve();
    expect(flushes).toBe(1);
    coalescer.dispose();
  });

  it("cancels a pending system-clock microtask on dispose", async () => {
    let flushes = 0;
    const coalescer = new FrameCoalescer(() => flushes++);

    coalescer.request();
    coalescer.dispose();
    await Promise.resolve();
    expect(flushes).toBe(0);
  });

  it("flushes the first idle request immediately and coalesces a burst", () => {
    const clock = new ManualClock();
    let flushes = 0;
    const coalescer = new FrameCoalescer(() => flushes++, 16, clock);

    coalescer.request();
    coalescer.request();
    coalescer.request();
    expect(clock.size).toBe(1);
    clock.advance(0);
    expect(flushes).toBe(1);
  });

  it("caps sustained publications to one per frame interval", () => {
    const clock = new ManualClock();
    let flushes = 0;
    const coalescer = new FrameCoalescer(() => flushes++, 16, clock);

    coalescer.request();
    clock.advance(0);
    coalescer.request();
    coalescer.request();
    clock.advance(15);
    expect(flushes).toBe(1);
    clock.advance(1);
    expect(flushes).toBe(2);
  });

  it("cancels pending work on dispose", () => {
    const clock = new ManualClock();
    let flushes = 0;
    const coalescer = new FrameCoalescer(() => flushes++, 16, clock);
    coalescer.request();
    coalescer.dispose();
    clock.advance(100);
    expect(flushes).toBe(0);
  });
});
