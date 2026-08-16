import { describe, expect, it } from "bun:test";
import {
  createGenerationBoundStore,
  type GenerationBoundClock,
  type GenerationBoundEventHandlers,
} from "./generation-bound-store.ts";
import { runtimeResourceSnapshot } from "./runtime-resource-ledger.ts";

class Clock implements GenerationBoundClock {
  next = 0;
  readonly timers = new Map<number, () => void>();
  now(): number {
    return 0;
  }
  setTimeout(callback: () => void): unknown {
    const id = ++this.next;
    this.timers.set(id, callback);
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  runOne(): void {
    const entry = this.timers.entries().next().value as [number, () => void] | undefined;
    if (!entry) throw new Error("no timer");
    this.timers.delete(entry[0]);
    entry[1]();
  }
}

describe("generation-bound timer ownership", () => {
  it("retires generation-bound retry timers on disposal", async () => {
    const baseline = runtimeResourceSnapshot()["runtime-timer"].active;
    const clock = new Clock();
    let connects = 0;
    const store = createGenerationBoundStore(
      {
        validateTarget: (value: unknown) => ({
          ok: true as const,
          target: String(value),
          key: String(value),
        }),
        fetch: async () => ({ status: "failed" as const, failure: "retry" }),
        connect: (_target: string, next: GenerationBoundEventHandlers<string>) => {
          void next;
          connects += 1;
          return connects === 1
            ? { status: "failed" as const, failure: "retry" }
            : { status: "connected" as const, close: () => undefined };
        },
        disposition: () => "retry" as const,
        rejectionFailure: () => "retry",
        transportFailure: () => "retry",
        eventExhaustedFailure: () => "exhausted",
        project: (view) => view.phase.kind,
      },
      "alpha",
      {
        clock,
        retry: {
          initialDelayMs: 10,
          maximumDelayMs: 10,
          maximumAttempts: 3,
          stabilityWindowMs: 10,
        },
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(runtimeResourceSnapshot()["runtime-timer"].active).toBeGreaterThan(baseline);
    store.dispose();
    expect(runtimeResourceSnapshot()["runtime-timer"].active).toBe(baseline);
  });
});
