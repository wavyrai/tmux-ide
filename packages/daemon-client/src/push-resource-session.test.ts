import { describe, expect, it } from "bun:test";

import {
  createPushResourceSession,
  type PushResourceEventHandlers,
  type PushResourceFetchResult,
  type PushResourceSessionAdapter,
} from "./push-resource-session.ts";

type Key = "fleet" | "files" | "changes" | "terminal";
interface Target {
  readonly generation: string;
}
interface Failure {
  readonly reason: string;
  readonly transient: boolean;
}

class FakeClock {
  nowValue = 0;
  next = 1;
  readonly timers = new Map<number, { at: number; run: () => void }>();

  now(): number {
    return this.nowValue;
  }
  setTimeout(run: () => void, delayMs: number): number {
    const id = this.next++;
    this.timers.set(id, { at: this.nowValue + delayMs, run });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  advanceBy(durationMs: number): void {
    const end = this.nowValue + durationMs;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.nowValue = due[1].at;
      due[1].run();
    }
    this.nowValue = end;
  }
}

class Microtasks {
  readonly pending: Array<() => void> = [];
  queue = (run: () => void): void => {
    this.pending.push(run);
  };
  runNext(): void {
    const run = this.pending.shift();
    if (!run) throw new Error("no pending microtask");
    run();
  }
  flush(): void {
    while (this.pending.length > 0) this.runNext();
  }
}

const ok = (resource: string): PushResourceFetchResult<string, Failure> => ({
  status: "ok",
  resource,
});

function target(value: unknown) {
  if (
    typeof value === "object" &&
    value !== null &&
    "generation" in value &&
    typeof value.generation === "string"
  ) {
    return { ok: true as const, target: value as Target, key: value.generation };
  }
  return {
    ok: false as const,
    failure: { reason: "invalid target", transient: false },
  };
}

function adapter(
  overrides: Partial<PushResourceSessionAdapter<Target, Key, string, Failure>> = {},
): PushResourceSessionAdapter<Target, Key, string, Failure> {
  return {
    validateTarget: target,
    fetch: async (current, key) => ok(`${current.generation}:${key}`),
    connect: () => ({ status: "connected", close: () => undefined }),
    rejectionFailure: () => ({ reason: "request rejected", transient: true }),
    retryable: (failure) => failure.transient,
    ...overrides,
  };
}

async function turn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("push resource session", () => {
  it("has one initial fetch and zero idle work for ten simulated minutes", async () => {
    const clock = new FakeClock();
    let fetches = 0;
    const session = createPushResourceSession(
      adapter({
        fetch: async () => {
          fetches += 1;
          return ok(`files-${fetches}`);
        },
      }),
      { generation: "one" },
      { clock },
    );
    session.activate("files");
    await turn();
    expect(fetches).toBe(1);
    expect(clock.timers.size).toBe(0);

    clock.advanceBy(10 * 60 * 1_000);
    await turn();
    expect(fetches).toBe(1);
    expect(clock.timers.size).toBe(0);
    expect(session.getMetrics().idleWakeups).toBe(0);
  });

  it("coalesces an invalidation burst into one refetch and ignores terminal traffic", async () => {
    const microtasks = new Microtasks();
    let events: PushResourceEventHandlers<Key> | null = null;
    let fetches = 0;
    const session = createPushResourceSession(
      adapter({
        fetch: async () => ok(`files-${++fetches}`),
        connect: (_target, _keys, handlers) => {
          events = handlers;
          return { status: "connected", close: () => undefined };
        },
      }),
      { generation: "one" },
      { queueMicrotask: microtasks.queue },
    );
    session.activate("files");
    await turn();
    expect(fetches).toBe(1);

    events!.invalidate();
    events!.invalidate();
    events!.invalidate();
    expect(fetches).toBe(1);
    expect(microtasks.pending).toHaveLength(1);
    microtasks.flush();
    await turn();
    expect(fetches).toBe(2);

    events!.invalidate(["terminal"]);
    microtasks.flush();
    await turn();
    expect(fetches).toBe(2);
    expect(session.getMetrics()).toMatchObject({
      invalidationsObserved: 4,
      invalidationsCoalesced: 2,
      fetchesStarted: 2,
    });
  });

  it("updates logical interests and releases each watcher without physical socket churn", async () => {
    const connectedWith: Key[][] = [];
    const updatedTo: string[][] = [];
    let closes = 0;
    const session = createPushResourceSession(
      adapter({
        connect: (_target, keys) => {
          connectedWith.push([...keys]);
          return {
            status: "connected",
            close: () => {
              closes += 1;
            },
            updateInterests: (next) => {
              updatedTo.push([...next]);
            },
          };
        },
      }),
      { generation: "one" },
    );
    const releaseFiles = session.activate("files");
    await turn();
    const releaseChanges = session.activate("changes");
    await turn();
    releaseFiles();
    await turn();
    expect(connectedWith).toEqual([["files"]]);
    expect(updatedTo).toEqual([["files", "changes"], ["changes"]]);
    expect(closes).toBe(0);
    expect(session.getMetrics().activeInterests).toBe(1);

    releaseChanges();
    expect(closes).toBe(1);
    expect(session.getMetrics()).toMatchObject({
      activeInterests: 0,
      subscriptionsOpened: 1,
      subscriptionsClosed: 1,
    });
  });

  it("establishes subscription interest before the initial read", async () => {
    let events: PushResourceEventHandlers<Key> | null = null;
    let finishConnect: (() => void) | null = null;
    let revision = 1;
    const reads: number[] = [];
    const session = createPushResourceSession(
      adapter({
        fetch: async () => {
          reads.push(revision);
          return ok(`revision-${revision}`);
        },
        connect: (_target, _keys, handlers) => {
          events = handlers;
          return new Promise((resolve) => {
            finishConnect = () => resolve({ status: "connected", close: () => undefined } as const);
          });
        },
      }),
      { generation: "one" },
    );
    session.activate("files");
    expect(reads).toEqual([]);
    revision = 2;
    events!.invalidate(["files"]);
    await turn();
    expect(reads).toEqual([]);

    finishConnect!();
    await turn();
    expect(reads).toEqual([2]);
    expect(session.getState().slots.get("files")).toMatchObject({
      status: "loaded",
      resource: "revision-2",
    });
  });

  it("falls back to a demand read when event subscription throws or rejects", async () => {
    for (const connect of [
      () => {
        throw new Error("sync refusal");
      },
      () => Promise.reject(new Error("async refusal")),
    ]) {
      let fetches = 0;
      const session = createPushResourceSession(
        adapter({
          connect,
          fetch: async () => ok(`fallback-${++fetches}`),
        }),
        { generation: "one" },
      );
      session.activate("files");
      await turn();
      expect(fetches).toBe(1);
      expect(session.getState().slots.get("files")).toMatchObject({
        status: "loaded",
        resource: "fallback-1",
      });
      session.dispose();
    }
  });

  it("reports degraded event authority, retries once, and resynchronizes after installation", async () => {
    const clock = new FakeClock();
    let connects = 0;
    let fetches = 0;
    let events: PushResourceEventHandlers<Key> | null = null;
    const session = createPushResourceSession(
      adapter({
        connect: (_target, _keys, handlers) => {
          events = handlers;
          connects += 1;
          return connects === 1
            ? { status: "unavailable" as const }
            : { status: "connected" as const, close: () => undefined };
        },
        fetch: async () => ok(`snapshot-${++fetches}`),
      }),
      { generation: "one" },
      { clock, retry: { initialDelayMs: 10, maximumDelayMs: 10, maximumAttempts: 2 } },
    );
    session.activate("files");
    await turn();
    expect(session.getState().eventPhase).toBe("degraded");
    expect(fetches).toBe(1);
    expect(clock.timers.size).toBe(1);

    clock.advanceBy(10);
    await turn();
    expect(session.getState().eventPhase).toBe("live");
    expect(fetches).toBe(2);
    expect(clock.timers.size).toBe(0);

    events!.invalidate(["files"]);
    await turn();
    expect(fetches).toBe(3);
    clock.advanceBy(10 * 60 * 1_000);
    expect(clock.timers.size).toBe(0);
  });

  it("retires an installed event source, reads through degradation, and reconnects", async () => {
    const clock = new FakeClock();
    const handlers: PushResourceEventHandlers<Key>[] = [];
    let connects = 0;
    let closes = 0;
    let fetches = 0;
    const session = createPushResourceSession(
      adapter({
        connect: (_target, _keys, next) => {
          handlers.push(next);
          connects += 1;
          return { status: "connected", close: () => closes++ };
        },
        fetch: async () => ok(`snapshot-${++fetches}`),
      }),
      { generation: "one" },
      { clock, retry: { initialDelayMs: 10, maximumDelayMs: 10, maximumAttempts: 2 } },
    );
    session.activate("files");
    await turn();
    expect(session.getState().eventPhase).toBe("live");
    expect(fetches).toBe(1);

    handlers[0]!.unavailable();
    await turn();
    expect(closes).toBe(1);
    expect(session.getState().eventPhase).toBe("degraded");
    expect(fetches).toBe(2);
    expect(clock.timers.size).toBe(1);

    clock.advanceBy(10);
    await turn();
    expect(connects).toBe(2);
    expect(session.getState().eventPhase).toBe("live");
    expect(fetches).toBe(3);
  });

  it("does not let a stale-generation invalidation microtask erase the new generation", async () => {
    const microtasks = new Microtasks();
    const handlers: PushResourceEventHandlers<Key>[] = [];
    const reads: string[] = [];
    const session = createPushResourceSession(
      adapter({
        fetch: async (current) => {
          reads.push(current.generation);
          return ok(current.generation);
        },
        connect: (_target, _keys, next) => {
          handlers.push(next);
          return { status: "connected", close: () => undefined };
        },
      }),
      { generation: "one" },
      { queueMicrotask: microtasks.queue },
    );
    session.activate("files");
    await turn();
    handlers[0]!.invalidate(["files"]);
    session.setTarget({ generation: "two" });
    await turn();
    handlers[1]!.invalidate(["files"]);
    expect(microtasks.pending).toHaveLength(2);
    microtasks.runNext();
    microtasks.runNext();
    await turn();
    expect(reads).toEqual(["one", "two", "two"]);
    expect(session.getState().slots.get("files")).toMatchObject({ resource: "two" });
  });

  it("aborts requests and ignores their late completion after release or disposal", async () => {
    let signal: AbortSignal | null = null;
    let finish: ((result: PushResourceFetchResult<string, Failure>) => void) | null = null;
    const session = createPushResourceSession(
      adapter({
        fetch: (_target, _key, nextSignal) => {
          signal = nextSignal;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      }),
      { generation: "one" },
    );
    session.activate("files");
    await turn();
    session.dispose();
    expect(signal!.aborted).toBe(true);
    finish!(ok("late"));
    await turn();
    expect(session.getState().disposed).toBe(true);
    expect(session.getState().slots.size).toBe(0);
    expect(session.getMetrics()).toMatchObject({ fetchesAborted: 1, lateResultsIgnored: 1 });
  });

  it("aborts a pending event connection on last release and closes a late result", async () => {
    let connectSignal: AbortSignal | null = null;
    let finishConnect: ((result: { status: "connected"; close: () => void }) => void) | null = null;
    let closes = 0;
    const session = createPushResourceSession(
      adapter({
        connect: (_target, _keys, _handlers, signal) => {
          connectSignal = signal;
          return new Promise((resolve) => {
            finishConnect = resolve;
          });
        },
      }),
      { generation: "one" },
    );
    const release = session.activate("files");
    expect(connectSignal!.aborted).toBe(false);
    release();
    expect(connectSignal!.aborted).toBe(true);
    finishConnect!({ status: "connected", close: () => closes++ });
    await turn();
    expect(closes).toBe(1);
    expect(session.getMetrics()).toMatchObject({ activeInterests: 0, subscriptionsOpened: 0 });
  });
});
