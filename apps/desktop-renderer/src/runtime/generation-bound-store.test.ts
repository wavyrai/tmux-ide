import { describe, expect, it, vi } from "vitest";
import type { DesktopDaemonTransportState } from "@tmux-ide/contracts";

import {
  boundedRetryDelay,
  createGenerationBoundStore,
  normalizedGenerationBoundRetry,
  type GenerationBoundAdapter,
  type GenerationBoundClock,
  type GenerationBoundEventHandlers,
  type GenerationBoundView,
} from "./generation-bound-store.ts";

/**
 * The engine's own contract, exercised through a minimal adapter rather than
 * through any of the three stores that instantiate it. Every policy the three
 * used to express separately is proven here once.
 */

interface Failure {
  readonly code: "transient" | "hard" | "poison";
  readonly reason: string;
}

type Target = { readonly name: string };
type View = GenerationBoundView<Target, string, Failure>;

class FakeClock implements GenerationBoundClock {
  #now = 1_000;
  #next = 1;
  readonly pending = new Map<number, { run: () => void; at: number }>();
  readonly delays: number[] = [];

  now(): number {
    return this.#now;
  }
  setTimeout(run: () => void, delayMs: number): unknown {
    const handle = this.#next++;
    this.delays.push(delayMs);
    this.pending.set(handle, { run, at: this.#now + delayMs });
    return handle;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** Fire the earliest pending timer. */
  runNext(): void {
    const entry = [...this.pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (entry === undefined) throw new Error("no pending timer");
    this.pending.delete(entry[0]);
    this.#now = entry[1].at;
    entry[1].run();
  }
  advance(ms: number): void {
    this.#now += ms;
  }
}

interface Harness {
  readonly adapter: GenerationBoundAdapter<Target, string, Failure, View>;
  readonly fetch: ReturnType<typeof vi.fn>;
  readonly connect: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  handlers(): GenerationBoundEventHandlers<Failure>;
  readonly signals: AbortSignal[];
}

function harness(
  overrides: Partial<GenerationBoundAdapter<Target, string, Failure, View>> = {},
  options: { readonly asyncConnect?: boolean; readonly connectFails?: boolean } = {},
): Harness {
  let handlers: GenerationBoundEventHandlers<Failure> | null = null;
  const signals: AbortSignal[] = [];
  const close = vi.fn();
  let reads = 0;
  const fetch = vi.fn(async (_target: Target, signal: AbortSignal) => {
    signals.push(signal);
    reads += 1;
    return { status: "ok", resource: `read-${reads}` } as const;
  });
  const connect = vi.fn((_target: Target, next: GenerationBoundEventHandlers<Failure>) => {
    handlers = next;
    const result = options.connectFails
      ? ({ status: "failed", failure: { code: "transient", reason: "no socket" } } as const)
      : ({ status: "connected", close } as const);
    return options.asyncConnect === true ? Promise.resolve(result) : result;
  });
  const adapter: GenerationBoundAdapter<Target, string, Failure, View> = {
    validateTarget: (value) =>
      typeof value === "string" && value !== ""
        ? { ok: true, target: { name: value }, key: value }
        : { ok: false, failure: { code: "hard", reason: "target invalid" } },
    fetch: fetch as GenerationBoundAdapter<Target, string, Failure, View>["fetch"],
    connect: connect as GenerationBoundAdapter<Target, string, Failure, View>["connect"],
    disposition: (failure) =>
      failure.code === "transient" ? "retry" : failure.code === "poison" ? "fatal" : "degrade",
    rejectionFailure: (source) => ({ code: "transient", reason: `${source} rejected` }),
    transportFailure: (state) => ({ code: "transient", reason: `transport ${state.phase}` }),
    eventExhaustedFailure: () => ({ code: "transient", reason: "event ladder exhausted" }),
    project: (view) => view,
    ...overrides,
  };
  return {
    adapter,
    fetch,
    connect,
    close,
    signals,
    handlers: () => {
      if (handlers === null) throw new Error("connect was never called");
      return handlers;
    },
  };
}

const RECONNECTING: DesktopDaemonTransportState = {
  phase: "reconnecting",
  attempt: 1,
  maximumAttempts: 4,
  nextRetryAt: 1_753_000_000_000,
  error: { code: "event-unavailable", reason: "socket dropped" },
};

describe("generation-bound store engine", () => {
  it("publishes loading, then a stale read, then live once the stream verifies", async () => {
    const fake = harness();
    const clock = new FakeClock();
    const seen: View[] = [];
    const store = createGenerationBoundStore(fake.adapter, "alpha", { clock });
    store.subscribe((state) => seen.push(state));
    expect(store.getState().phase.kind).toBe("loading");

    await vi.waitFor(() => expect(store.getState().phase.kind).toBe("stale"));
    expect(store.getState().snapshot).toEqual({ resource: "read-1", updatedAt: 1_000 });

    fake.handlers().live();
    expect(store.getState().phase.kind).toBe("live");
    expect(seen.at(-1)?.phase.kind).toBe("live");
  });

  it("drops a read that resolves against a superseded generation", async () => {
    let release: ((value: { status: "ok"; resource: string }) => void) | null = null;
    const fake = harness({
      fetch: (target) =>
        target.name === "alpha"
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve({ status: "ok", resource: "beta-read" }),
    });
    const store = createGenerationBoundStore(fake.adapter, "alpha", { clock: new FakeClock() });
    store.setTarget("beta");
    await vi.waitFor(() => expect(store.getState().snapshot?.resource).toBe("beta-read"));
    release!({ status: "ok", resource: "alpha-read" });
    await Promise.resolve();
    expect(store.getState().snapshot?.resource).toBe("beta-read");
    expect(store.getState().target).toEqual({ name: "beta" });
  });

  it("aborts the signal of a read still in flight when the generation moves on", async () => {
    const signals: AbortSignal[] = [];
    const fake = harness({
      fetch: (_target, signal) => {
        signals.push(signal);
        return new Promise(() => undefined);
      },
    });
    const store = createGenerationBoundStore(fake.adapter, "alpha", { clock: new FakeClock() });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    store.setTarget("beta");
    expect(signals[0]?.aborted).toBe(true);
    store.dispose();
  });

  it("runs a bounded, deterministic request ladder and reports exhaustion", async () => {
    const read = vi.fn(async () => ({
      status: "failed" as const,
      failure: { code: "transient" as const, reason: "down" },
    }));
    const fake = harness({ fetch: read });
    const clock = new FakeClock();
    const store = createGenerationBoundStore(fake.adapter, "alpha", {
      clock,
      retry: { initialDelayMs: 10, maximumDelayMs: 40, maximumAttempts: 2 },
    });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(clock.delays).toEqual([10]));
    clock.runNext();
    await vi.waitFor(() => expect(clock.delays).toEqual([10, 20]));
    clock.runNext();
    await vi.waitFor(() => {
      const phase = store.getState().phase;
      expect(phase.kind === "failed" && phase.exhausted).toBe(true);
    });
    expect(read).toHaveBeenCalledTimes(3);
    expect(clock.pending.size).toBe(0);
  });

  it("retains the last good read across a transient failure", async () => {
    let fail = false;
    const fake = harness({
      fetch: async () =>
        fail
          ? { status: "failed", failure: { code: "transient", reason: "down" } }
          : { status: "ok", resource: "good" },
    });
    const store = createGenerationBoundStore(fake.adapter, "alpha", {
      clock: new FakeClock(),
      retry: { maximumAttempts: 0 },
    });
    await vi.waitFor(() => expect(store.getState().snapshot?.resource).toBe("good"));
    fail = true;
    store.refresh();
    await vi.waitFor(() => expect(store.getState().phase.kind).toBe("failed"));
    expect(store.getState().snapshot?.resource).toBe("good");
  });

  it("retires the stream on a fatal read and recovers only on an explicit refresh", async () => {
    let poison = true;
    const read = vi.fn(async () =>
      poison
        ? ({ status: "failed", failure: { code: "poison", reason: "wrong generation" } } as const)
        : ({ status: "ok", resource: "healed" } as const),
    );
    const fake = harness({ fetch: read });
    const clock = new FakeClock();
    const store = createGenerationBoundStore(fake.adapter, "alpha", { clock });
    await vi.waitFor(() => {
      const phase = store.getState().phase;
      expect(phase.kind === "failed" && phase.fatal).toBe(true);
    });
    expect(fake.close).toHaveBeenCalledOnce();
    expect(clock.pending.size).toBe(0);
    expect(read).toHaveBeenCalledTimes(1);

    poison = false;
    store.refresh();
    await vi.waitFor(() => expect(store.getState().phase.kind).not.toBe("failed"));
    expect(fake.connect).toHaveBeenCalledTimes(2);
  });

  it("recovers the stream on the ladder and refetches once it verifies", async () => {
    const fake = harness();
    const clock = new FakeClock();
    const store = createGenerationBoundStore(fake.adapter, "alpha", {
      clock,
      retry: { initialDelayMs: 10, maximumDelayMs: 10, maximumAttempts: 2 },
    });
    await vi.waitFor(() => expect(store.getState().snapshot?.resource).toBe("read-1"));
    fake.handlers().live();
    expect(store.getState().phase.kind).toBe("live");

    fake.handlers().failed({ code: "transient", reason: "socket dropped" });
    expect(fake.close).toHaveBeenCalledOnce();
    expect(store.getState().phase.kind).toBe("failed");
    clock.runNext();
    expect(fake.connect).toHaveBeenCalledTimes(2);

    fake.handlers().live();
    // The retained read goes live at once, and the resync refreshes it.
    expect(store.getState().phase.kind).toBe("live");
    await vi.waitFor(() => expect(store.getState().snapshot?.resource).toBe("read-2"));
  });

  it("stops the event ladder at its bound and marks the failure exhausted", async () => {
    const fake = harness();
    const clock = new FakeClock();
    const store = createGenerationBoundStore(fake.adapter, "alpha", {
      clock,
      retry: { initialDelayMs: 10, maximumDelayMs: 10, maximumAttempts: 1 },
    });
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalledTimes(1));
    fake.handlers().failed({ code: "transient", reason: "drop 1" });
    clock.runNext();
    expect(fake.connect).toHaveBeenCalledTimes(2);
    fake.handlers().failed({ code: "transient", reason: "drop 2" });
    const phase = store.getState().phase;
    expect(phase.kind === "failed" && phase.exhausted).toBe(true);
    expect(phase.kind === "failed" && phase.failure.reason).toBe("event ladder exhausted");
    expect(clock.pending.size).toBe(0);
  });

  it("defers every socket decision to the supervisor once a transport state is pushed", async () => {
    const fake = harness();
    const clock = new FakeClock();
    const store = createGenerationBoundStore(fake.adapter, "alpha", {
      clock,
      retry: { initialDelayMs: 10, maximumDelayMs: 10, maximumAttempts: 4 },
    });
    await vi.waitFor(() => expect(store.getState().snapshot?.resource).toBe("read-1"));
    fake.handlers().transportChanged({ phase: "connected" });
    fake.handlers().live();
    expect(store.getState().phase.kind).toBe("live");

    fake.handlers().transportChanged(RECONNECTING);
    // No teardown, no resubscribe, no timer: the supervisor owns recovery.
    expect(fake.close).not.toHaveBeenCalled();
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(clock.pending.size).toBe(0);
    expect(store.getState().transport).toEqual(RECONNECTING);

    // Even an explicit refresh reads the resource and leaves the stream alone.
    store.refresh();
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(fake.close).not.toHaveBeenCalled();

    fake.handlers().transportChanged({ phase: "connected" });
    fake.handlers().live();
    await vi.waitFor(() => expect(store.getState().phase.kind).toBe("live"));
    expect(fake.connect).toHaveBeenCalledTimes(1);
  });

  it("retires a read in flight when the stream fails", async () => {
    let release: ((value: { status: "ok"; resource: string }) => void) | null = null;
    const signals: AbortSignal[] = [];
    const fake = harness({
      fetch: (_target, signal) => {
        signals.push(signal);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const store = createGenerationBoundStore(fake.adapter, "alpha", {
      clock: new FakeClock(),
      retry: { maximumAttempts: 0 },
    });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    fake.handlers().failed({ code: "hard", reason: "socket gone" });
    expect(signals[0]?.aborted).toBe(true);
    release!({ status: "ok", resource: "too-late" });
    await Promise.resolve();
    expect(store.getState().snapshot).toBeNull();
  });

  it("refetches on invalidation", async () => {
    const fake = harness();
    const store = createGenerationBoundStore(fake.adapter, "alpha", { clock: new FakeClock() });
    await vi.waitFor(() => expect(store.getState().snapshot?.resource).toBe("read-1"));
    fake.handlers().invalidate();
    await vi.waitFor(() => expect(store.getState().snapshot?.resource).toBe("read-2"));
  });

  it("honours the reassert policy for a re-pushed target", async () => {
    const ignoring = harness();
    const ignore = createGenerationBoundStore(ignoring.adapter, "alpha", {
      clock: new FakeClock(),
    });
    await vi.waitFor(() => expect(ignoring.fetch).toHaveBeenCalledTimes(1));
    ignore.setTarget("alpha");
    expect(ignoring.fetch).toHaveBeenCalledTimes(1);

    const refreshing = harness({ reassert: "refresh" });
    const refresh = createGenerationBoundStore(refreshing.adapter, "alpha", {
      clock: new FakeClock(),
    });
    await vi.waitFor(() => expect(refreshing.fetch).toHaveBeenCalledTimes(1));
    refresh.setTarget("alpha");
    expect(refreshing.fetch).toHaveBeenCalledTimes(2);
    // The stream had not verified, so the refresh re-opens it too.
    expect(refreshing.connect).toHaveBeenCalledTimes(2);
  });

  it("publishes an invalid target as a fatal target failure and reads nothing", () => {
    const fake = harness();
    const store = createGenerationBoundStore(fake.adapter, "", { clock: new FakeClock() });
    const phase = store.getState().phase;
    expect(phase.kind === "failed" && phase.source).toBe("target");
    expect(phase.kind === "failed" && phase.fatal).toBe(true);
    expect(store.getState().target).toBeNull();
    expect(fake.fetch).not.toHaveBeenCalled();
    expect(fake.connect).not.toHaveBeenCalled();
  });

  it("settles a synchronous connect before any callback it raises", () => {
    const fake = harness({}, { connectFails: true });
    const clock = new FakeClock();
    createGenerationBoundStore(fake.adapter, "alpha", {
      clock,
      retry: { initialDelayMs: 10, maximumDelayMs: 10, maximumAttempts: 1 },
    });
    // A synchronous refusal is seen at once, so its ladder is armed at once.
    expect(clock.delays).toEqual([10]);
  });

  it("settles an asynchronous connect and tears down one retired late", async () => {
    const fake = harness({}, { asyncConnect: true });
    const store = createGenerationBoundStore(fake.adapter, "alpha", { clock: new FakeClock() });
    store.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("isolates observer faults and notifies the observers disposal retires", async () => {
    const fake = harness();
    const store = createGenerationBoundStore(fake.adapter, "alpha", { clock: new FakeClock() });
    const seen: string[] = [];
    expect(() =>
      store.subscribe(() => {
        throw new Error("private observer failure");
      }),
    ).not.toThrow();
    store.subscribe((state) => {
      seen.push(state.disposed ? "disposed" : state.phase.kind);
      if (state.disposed) {
        store.refresh();
        store.setTarget("beta");
        throw new Error("observer attempted re-entry");
      }
    });
    await vi.waitFor(() => expect(store.getState().snapshot).not.toBeNull());
    const reads = fake.fetch.mock.calls.length;
    expect(() => store.dispose()).not.toThrow();
    expect(seen.at(-1)).toBe("disposed");
    expect(store.getState().disposed).toBe(true);
    expect(fake.fetch).toHaveBeenCalledTimes(reads);
    expect(fake.close).toHaveBeenCalledOnce();

    // Disposal is irrevocable and silent from then on.
    const after = seen.length;
    store.dispose();
    store.setTarget("gamma");
    expect(seen).toHaveLength(after);
  });

  it("survives a host clock that throws while clearing a timer", async () => {
    const fake = harness({
      fetch: async () => ({ status: "failed", failure: { code: "transient", reason: "down" } }),
    });
    const clock = new FakeClock();
    const hostile: GenerationBoundClock = {
      now: () => clock.now(),
      setTimeout: (run, delay) => clock.setTimeout(run, delay),
      clearTimeout: () => {
        throw new Error("private clock failure");
      },
    };
    const store = createGenerationBoundStore(fake.adapter, "alpha", {
      clock: hostile,
      retry: { initialDelayMs: 10, maximumAttempts: 4 },
    });
    await vi.waitFor(() => expect(clock.delays).toEqual([10]));
    expect(() => store.dispose()).not.toThrow();
    expect(store.getState().disposed).toBe(true);
  });
});

describe("generation-bound retry arithmetic", () => {
  it("clamps hostile overrides into finite bounded work", () => {
    const policy = normalizedGenerationBoundRetry({
      initialDelayMs: -1_000,
      maximumDelayMs: Number.POSITIVE_INFINITY,
      maximumAttempts: 1_000_000,
      jitterRatio: 9,
      stabilityWindowMs: Number.NaN,
    });
    expect(policy.initialDelayMs).toBe(10);
    // A non-finite override is not clamped to the ceiling; it is not a number,
    // so the default stands.
    expect(policy.maximumDelayMs).toBe(4_000);
    expect(policy.maximumAttempts).toBe(20);
    expect(policy.jitterRatio).toBe(1);
    expect(policy.stabilityWindowMs).toBe(0);
  });

  it("keeps a zero-jitter ladder deterministic and never calls for entropy", () => {
    const random = vi.fn(() => 0.9);
    const policy = normalizedGenerationBoundRetry({ initialDelayMs: 10, maximumDelayMs: 1_000 });
    expect(boundedRetryDelay(0, policy, random)).toBe(10);
    expect(boundedRetryDelay(3, policy, random)).toBe(80);
    expect(random).not.toHaveBeenCalled();
  });

  it("bounds a jittered delay by the ratio and tolerates a hostile entropy source", () => {
    const policy = normalizedGenerationBoundRetry({
      initialDelayMs: 100,
      maximumDelayMs: 1_000,
      jitterRatio: 0.2,
    });
    expect(boundedRetryDelay(0, policy, () => 0)).toBe(80);
    expect(boundedRetryDelay(0, policy, () => 1)).toBe(120);
    expect(boundedRetryDelay(0, policy, () => 0.5)).toBe(100);
    expect(
      boundedRetryDelay(0, policy, () => {
        throw new Error("private entropy failure");
      }),
    ).toBe(100);
    expect(boundedRetryDelay(0, policy, () => Number.NaN)).toBe(100);
  });

  it("resets the budget only after a verified connection survives the stability window", async () => {
    const fake = harness();
    const clock = new FakeClock();
    createGenerationBoundStore(fake.adapter, "alpha", {
      clock,
      retry: {
        initialDelayMs: 10,
        maximumDelayMs: 10,
        maximumAttempts: 4,
        stabilityWindowMs: 1_000,
      },
    });
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalledTimes(1));
    fake.handlers().failed({ code: "transient", reason: "drop" });
    clock.runNext();
    fake.handlers().live();
    // The budget is still spent until the stability timer fires.
    fake.handlers().failed({ code: "transient", reason: "drop again" });
    clock.runNext();
    expect(fake.connect).toHaveBeenCalledTimes(3);
    fake.handlers().live();
    clock.runNext();
    fake.handlers().failed({ code: "transient", reason: "after stability" });
    clock.runNext();
    expect(fake.connect).toHaveBeenCalledTimes(4);
  });
});
