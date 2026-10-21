import { test } from "node:test";
import assert from "node:assert/strict";
import { createHostedSessionLifecycle, SessionRetiredError } from "./hosted-session-lifecycle.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(
  overrides: Partial<Parameters<typeof createHostedSessionLifecycle<number, string>>[0]> = {},
) {
  const events: string[] = [];
  const session = createHostedSessionLifecycle<number, string>({
    dispatch: (n) => {
      events.push(`command:${n}`);
    },
    emit: (value) => {
      events.push(value);
    },
    unavailable: () => "unavailable",
    revoke: () => {
      events.push("revoke");
    },
    drain: () => {
      events.push("drain");
    },
    close: () => {
      events.push("close");
    },
    ...overrides,
  });
  return { session, events };
}
test("bounded FIFO admission and idempotent retirement order", async () => {
  const wait = deferred();
  const sent: number[] = [];
  const { session, events } = fixture({
    commandCapacity: 2,
    dispatch: async (n) => {
      sent.push(n);
      if (n === 1) await wait.promise;
    },
  });
  const first = session.command(1),
    second = session.command(2);
  await assert.rejects(session.command(3), /capacity/);
  assert.deepEqual(sent, [1]);
  wait.resolve();
  await Promise.all([first, second]);
  session.own(() => {
    events.push("resource");
  });
  const done = session.dispose();
  assert.equal(session.dispose(), done);
  assert.equal(session.context.signal.aborted, true);
  await done;
  assert.deepEqual(sent, [1, 2]);
  assert.deepEqual(events, ["revoke", "unavailable", "drain", "resource", "close"]);
  await assert.rejects(session.command(4), SessionRetiredError);
});
test("dispose cancels active and queued callers and fences late effects", async () => {
  const wait = deferred();
  const effects: number[] = [];
  const { session } = fixture({
    dispatch: async (n, context) => {
      await wait.promise;
      context.checkActive();
      effects.push(n);
    },
  });
  const first = assert.rejects(session.command(1), SessionRetiredError);
  const next = assert.rejects(session.command(2), SessionRetiredError);
  await session.dispose();
  await Promise.all([first, next]);
  wait.resolve();
  await turn();
  assert.deepEqual(effects, []);
});
test("first dispatch fault retires only its session and never replays queue", async () => {
  const wait = deferred();
  const sent: number[] = [];
  const { session } = fixture({
    dispatch: async (n) => {
      sent.push(n);
      await wait.promise;
      throw Error("transport");
    },
  });
  const a = assert.rejects(session.command(1), /transport/);
  const b = assert.rejects(session.command(2), SessionRetiredError);
  const other = fixture();
  wait.resolve();
  await Promise.all([a, b]);
  assert.equal((await session.done).reason, "command-failed");
  await other.session.command(7);
  assert.deepEqual(other.events, ["command:7"]);
  assert.deepEqual(sent, [1]);
  await other.session.dispose();
});
test("publication admission bounded and cancellation wakes a stuck emitter", async () => {
  const wait = deferred();
  const emissions: string[] = [];
  const { session } = fixture({
    emit: (value, signal) => {
      emissions.push(value);
      if (value === "frame") {
        assert.equal(signal.aborted, false);
        return wait.promise;
      }
    },
  });
  const pending = assert.rejects(session.publish("frame"), SessionRetiredError);
  await assert.rejects(session.publish("extra"), /Concurrent/);
  await session.dispose();
  await pending;
  assert.deepEqual(emissions, ["frame", "unavailable"]);
  wait.resolve();
  await turn();
  await assert.rejects(session.publish("late"), SessionRetiredError);
});
test("sync and async callback faults are contained; late callbacks cannot run", async () => {
  for (const asynchronous of [false, true]) {
    const { session } = fixture();
    let calls = 0;
    const callback = session.guard(() => {
      calls++;
      if (asynchronous) return Promise.reject(Error("fault"));
      throw Error("fault");
    });
    callback();
    assert.equal((await session.done).reason, "callback-failed");
    assert.equal(callback(), false);
    assert.equal(calls, 1);
  }
});
test("deadline bounds hanging drain and still starts every disposer and close", async () => {
  const wait = deferred();
  const { session, events } = fixture({ retirementMs: 15, drain: () => wait.promise });
  session.own(() => {
    events.push("bad resource");
    throw Error("close");
  });
  session.own(() => {
    events.push("hung resource");
    return wait.promise;
  });
  const result = await session.dispose();
  assert.equal(result.timedOut, true);
  assert.equal(session.state, "retired");
  assert.deepEqual(events, ["revoke", "unavailable", "bad resource", "hung resource", "close"]);
  assert.ok(result.failures.includes("resource"));
  wait.resolve();
});
test("external abort and publication fault retire with final unavailable", async () => {
  const controller = new AbortController();
  const aborted = fixture({ signal: controller.signal });
  controller.abort();
  assert.equal((await aborted.session.done).reason, "aborted");
  const { session, events } = fixture({
    emit: (value) => {
      events.push(value);
      if (value === "frame") throw Error("emit");
    },
  });
  await assert.rejects(session.publish("frame"), /emit/);
  assert.equal((await session.done).reason, "publication-failed");
  assert.deepEqual(events, ["frame", "revoke", "unavailable", "drain", "close"]);
});
test("already aborted session admits nothing and revoke exceptions do not skip cleanup", async () => {
  const controller = new AbortController();
  controller.abort();
  const { session, events } = fixture({
    signal: controller.signal,
    revoke: () => {
      throw Error("revoke");
    },
  });
  await assert.rejects(session.command(1), SessionRetiredError);
  const result = await session.done;
  assert.deepEqual(result.failures, ["revoke"]);
  assert.deepEqual(events, ["unavailable", "drain", "close"]);
});
