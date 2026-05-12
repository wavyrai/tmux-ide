import { describe, expect, it } from "bun:test";
import {
  bindReactor,
  makeReactor,
  type ReactorEventSource,
  type ReactorFailureEvent,
} from "./reactor.ts";

interface ToyEvent {
  type: "toy.event";
  n: number;
}

describe("makeReactor", () => {
  it("processes 100 events in order and resolves drain when idle", async () => {
    const processed: number[] = [];
    const reactor = makeReactor<ToyEvent>({
      name: "toy",
      process: async (event) => {
        // Small async hop forces interleaving and proves single-worker ordering.
        await Promise.resolve();
        processed.push(event.n);
      },
    });

    const dispose = await reactor.start();
    for (let n = 0; n < 100; n += 1) {
      reactor.enqueue({ type: "toy.event", n });
    }

    await reactor.drain();

    expect(processed.length).toBe(100);
    expect(processed).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(reactor.queueDepth).toBe(0);

    await dispose();
  });

  it("keeps consuming after a single process() failure and reports it via onFailure", async () => {
    const processed: number[] = [];
    const failures: ReactorFailureEvent<ToyEvent>[] = [];

    const reactor = makeReactor<ToyEvent>({
      name: "toy",
      process: (event) => {
        if (event.n === 50) throw new Error("boom at 50");
        processed.push(event.n);
      },
      onFailure: (failure) => {
        failures.push(failure);
      },
      now: () => "2026-05-12T00:00:00.000Z",
    });

    const dispose = await reactor.start();
    for (let n = 0; n < 100; n += 1) {
      reactor.enqueue({ type: "toy.event", n });
    }

    await reactor.drain();

    // 99 successful + 1 failed = 100 total events seen
    expect(processed.length).toBe(99);
    expect(processed.includes(50)).toBe(false);
    // Events before and after the failure both succeed
    expect(processed[0]).toBe(0);
    expect(processed[processed.length - 1]).toBe(99);

    expect(failures.length).toBe(1);
    const failure = failures[0]!;
    expect(failure.type).toBe("chat.reactor.failure");
    expect(failure.reactor).toBe("toy");
    expect(failure.cause.message).toBe("boom at 50");
    expect(failure.causationEvent).toEqual({ type: "toy.event", n: 50 });
    expect(failure.occurredAt).toBe("2026-05-12T00:00:00.000Z");

    await dispose();
  });

  it("isolates a throwing onFailure handler — the loop keeps draining", async () => {
    const processed: number[] = [];
    const reactor = makeReactor<ToyEvent>({
      name: "toy",
      process: (event) => {
        if (event.n === 2) throw new Error("first boom");
        if (event.n === 5) throw new Error("second boom");
        processed.push(event.n);
      },
      onFailure: () => {
        throw new Error("onFailure exploded too");
      },
    });

    const dispose = await reactor.start();
    for (let n = 0; n < 10; n += 1) reactor.enqueue({ type: "toy.event", n });

    await reactor.drain();

    // 10 total - 2 failures = 8 successful
    expect(processed).toEqual([0, 1, 3, 4, 6, 7, 8, 9]);
    await dispose();
  });

  it("drain() resolves immediately when the queue is empty and idle", async () => {
    const reactor = makeReactor<ToyEvent>({ name: "toy", process: () => {} });
    await reactor.start();
    await reactor.drain(); // no events enqueued — must resolve, not hang
    expect(reactor.queueDepth).toBe(0);
  });

  it("buffers events enqueued before start() and drains them after", async () => {
    const processed: number[] = [];
    const reactor = makeReactor<ToyEvent>({
      name: "toy",
      process: (event) => {
        processed.push(event.n);
      },
    });

    reactor.enqueue({ type: "toy.event", n: 1 });
    reactor.enqueue({ type: "toy.event", n: 2 });

    await reactor.start();
    await reactor.drain();

    expect(processed).toEqual([1, 2]);
  });

  it("dispose() drains then halts further processing", async () => {
    const processed: number[] = [];
    const reactor = makeReactor<ToyEvent>({
      name: "toy",
      process: async (event) => {
        await Promise.resolve();
        processed.push(event.n);
      },
    });

    const dispose = await reactor.start();
    for (let n = 0; n < 5; n += 1) reactor.enqueue({ type: "toy.event", n });

    await dispose();

    expect(processed.length).toBe(5);

    // After dispose, new events are dropped (warned, not thrown).
    reactor.enqueue({ type: "toy.event", n: 99 });
    await reactor.drain();
    expect(processed.includes(99)).toBe(false);
  });

  it("start() is idempotent — same disposer returned on repeated calls", async () => {
    const reactor = makeReactor<ToyEvent>({ name: "toy", process: () => {} });
    const a = await reactor.start();
    const b = await reactor.start();
    expect(a).toBe(b);
    await a();
  });
});

describe("bindReactor", () => {
  it("forwards events from a subscribe source into the reactor queue", async () => {
    const processed: number[] = [];
    const reactor = makeReactor<ToyEvent>({
      name: "toy",
      process: (event) => {
        processed.push(event.n);
      },
    });

    // Minimal EventEmitter-shaped source — what T090's ChatEventStore will expose.
    const listeners = new Set<(e: ToyEvent) => void>();
    const source: ReactorEventSource<ToyEvent> = {
      subscribe(handler) {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
    };

    await reactor.start();
    const unsub = bindReactor(reactor, source);

    for (const listener of listeners) {
      listener({ type: "toy.event", n: 7 });
      listener({ type: "toy.event", n: 8 });
    }

    await reactor.drain();
    expect(processed).toEqual([7, 8]);

    unsub();
    expect(listeners.size).toBe(0);
  });
});
