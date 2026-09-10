import { describe, expect, it } from "bun:test";
import { createFleetDialScheduler, fleetReconnectBackoff } from "./fleet-dial-scheduler.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((done) => setTimeout(done, 0));

describe("fleet dial scheduling", () => {
  it("bounds 64 handshakes and prioritizes the selected queued route", async () => {
    const scheduler = createFleetDialScheduler();
    const gates = Array.from({ length: 64 }, () => deferred<number>());
    const started: number[] = [];
    const requests = gates.map((gate, index) =>
      scheduler.run(
        String(index),
        new AbortController().signal,
        () => {
          started.push(index);
          return gate.promise;
        },
        () => {},
      ),
    );
    expect(started).toEqual([0, 1, 2, 3]);
    expect(scheduler.snapshot()).toEqual({ active: 4, queued: 60, limit: 4 });
    scheduler.prioritize("63");
    gates[0]!.resolve(0);
    await tick();
    expect(started).toEqual([0, 1, 2, 3, 63]);
    for (let i = 0; i < gates.length; i++) gates[i]!.resolve(i);
    expect(await Promise.all(requests)).toEqual(gates.map((_, i) => i));
    await tick();
    expect(scheduler.snapshot()).toEqual({ active: 0, queued: 0, limit: 4 });
  });

  it("cancels queued requests without dialing and disposes late active results without oversubscription", async () => {
    const scheduler = createFleetDialScheduler(1);
    const first = deferred<number>();
    const abort = new AbortController();
    const queuedAbort = new AbortController();
    const disposed: number[] = [];
    let queuedStarted = false;
    const active = scheduler.run(
      "a",
      abort.signal,
      () => first.promise,
      (value) => {
        disposed.push(value);
      },
    );
    const queued = scheduler.run(
      "b",
      queuedAbort.signal,
      async () => {
        queuedStarted = true;
        return 2;
      },
      () => {},
    );
    const activeRejected = active.catch((error: Error) => error);
    const queuedRejected = queued.catch((error: Error) => error);
    abort.abort();
    queuedAbort.abort();
    expect(await activeRejected).toBeInstanceOf(Error);
    expect(await queuedRejected).toBeInstanceOf(Error);
    expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0, limit: 1 });
    expect(queuedStarted).toBe(false);
    first.resolve(1);
    await tick();
    expect(disposed).toEqual([1]);
    expect(scheduler.snapshot().active).toBe(0);
  });

  it("releases a failed slot and never dials an already-aborted request", async () => {
    const scheduler = createFleetDialScheduler(1);
    const abort = new AbortController();
    abort.abort();
    let calls = 0;
    await expect(
      scheduler.run(
        "a",
        abort.signal,
        async () => ++calls,
        () => {},
      ),
    ).rejects.toThrow("cancelled");
    await expect(
      scheduler.run(
        "b",
        new AbortController().signal,
        () => {
          throw new Error("dial failed");
        },
        () => {},
      ),
    ).rejects.toThrow("dial failed");
    await tick();
    expect(calls).toBe(0);
    expect(scheduler.snapshot().active).toBe(0);
  });

  it("uses bounded nonzero jitter even with invalid random sources", () => {
    expect(fleetReconnectBackoff(1, () => 0)).toBe(500);
    expect(fleetReconnectBackoff(1, () => 1)).toBe(1000);
    expect(fleetReconnectBackoff(100, () => 1)).toBe(30000);
    expect(fleetReconnectBackoff(100, () => -1)).toBe(15000);
    expect(fleetReconnectBackoff(100, () => NaN)).toBe(22500);
  });
});
