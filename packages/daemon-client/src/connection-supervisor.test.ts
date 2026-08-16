import { describe, expect, it } from "bun:test";
import {
  createRuntimeConnectionSupervisor,
  exponentialReconnectBackoff,
  type RuntimeConnection,
} from "./connection-supervisor.ts";
import { runtimeResourceSnapshot } from "./runtime-resource-ledger.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("runtime connection supervisor", () => {
  it("deduplicates start and retains the last value while reconnecting", async () => {
    const baseline = runtimeResourceSnapshot();
    const firstClosed = deferred<unknown>();
    const secondClosed = deferred<unknown>();
    let connects = 0;
    const disposed: number[] = [];
    const states: string[] = [];
    const supervisor = createRuntimeConnectionSupervisor<number>({
      backoffMs: () => 0,
      async connect(): Promise<RuntimeConnection<number>> {
        connects += 1;
        const id = connects;
        return {
          value: id,
          closed: id === 1 ? firstClosed.promise : secondClosed.promise,
          dispose: () => disposed.push(id),
        };
      },
    });
    const unsubscribe = supervisor.subscribe((state) =>
      states.push(`${state.phase}:${state.value ?? "-"}`),
    );

    supervisor.start();
    supervisor.start();
    await tick();
    expect(connects).toBe(1);
    expect(supervisor.state).toMatchObject({ phase: "live", value: 1 });

    firstClosed.reject(new Error("dropped"));
    await tick();
    expect(states).toContain("reconnecting:1");
    expect(connects).toBe(2);
    expect(supervisor.state).toMatchObject({ phase: "live", value: 2 });

    await supervisor.stop();
    expect(disposed).toEqual([1, 2]);
    expect(supervisor.state).toMatchObject({ phase: "stopped", value: 2 });
    unsubscribe();
    const settled = runtimeResourceSnapshot();
    expect(settled["runtime-supervisor"].active).toBe(baseline["runtime-supervisor"].active);
    expect(settled["runtime-subscription"].active).toBe(baseline["runtime-subscription"].active);
    expect(settled["runtime-timer"].active).toBe(baseline["runtime-timer"].active);
  });

  it("stops retrying a terminal failure", async () => {
    const failure = new Error("fatal");
    const supervisor = createRuntimeConnectionSupervisor({
      connect: async () => Promise.reject(failure),
      retryable: () => false,
    });
    supervisor.start();
    await tick();
    expect(supervisor.state).toMatchObject({ phase: "failed", error: failure });
  });

  it("stops without waiting for a connect adapter that ignores abort and disposes its late result", async () => {
    const opening = deferred<RuntimeConnection<number>>();
    let disposeCount = 0;
    const supervisor = createRuntimeConnectionSupervisor<number>({
      connect: () => opening.promise,
    });
    supervisor.start();
    await tick();

    await supervisor.stop();
    expect(supervisor.state.phase).toBe("stopped");
    expect(disposeCount).toBe(0);

    opening.resolve({
      value: 1,
      closed: new Promise<never>(() => undefined),
      dispose: () => {
        disposeCount += 1;
      },
    });
    await tick();
    expect(disposeCount).toBe(1);
  });
});

describe("exponentialReconnectBackoff", () => {
  it("starts at one second and caps at thirty seconds", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(exponentialReconnectBackoff)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });
});
