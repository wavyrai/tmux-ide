import { describe, expect, it, vi } from "vitest";
import { SYSTEM_SESSION_RUNTIME_SCHEDULER } from "./runtime-scheduler.ts";

describe("cooperative runtime task scheduling", () => {
  it("gives already queued I/O work a turn after microtasks", async () => {
    const events: string[] = [];
    setImmediate(() => events.push("sibling"));
    SYSTEM_SESSION_RUNTIME_SCHEDULER.yieldTask!(() => events.push("resume"));
    events.push("synchronous");
    await Promise.resolve();
    events.push("microtask");
    expect(events).toEqual(["synchronous", "microtask"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["synchronous", "microtask", "sibling", "resume"]);
  });

  it("cancels a retired owner's pending continuation", async () => {
    const continuation = vi.fn();
    SYSTEM_SESSION_RUNTIME_SCHEDULER.yieldTask!(continuation).cancel();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(continuation).not.toHaveBeenCalled();
  });
});
