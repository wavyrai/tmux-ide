import { test } from "node:test";
import assert from "node:assert/strict";
import {
  settlePackedChildren,
  createInstalledRuntimeCleanup,
  waitForPackedSocketRemoval,
} from "./packed-install-cleanup.mjs";

function child(onSignal) {
  let close;
  const exit = new Promise((resolve) => {
    close = resolve;
  });
  const signals = [];
  const value = {
    exitCode: null,
    signalCode: null,
    kill(signal) {
      signals.push(signal);
      onSignal?.(signal, () => {
        value.signalCode = signal;
        close();
      });
    },
  };
  return { value, exit, signals, close };
}
test("TERM failure reaches retained KILL and waits for its close before confirming cleanup", async () => {
  const owned = child((signal, close) => {
    if (signal === "SIGKILL") setTimeout(close, 10);
  });
  const result = await settlePackedChildren([owned.value], new Map([[owned.value, owned.exit]]), {
    graceMs: 5,
    killMs: 100,
  });
  assert.deepEqual(owned.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.confirmed, true);
  assert.equal(result.graceful, false);
  assert.equal(result.closed, 1);
});
test("one unconfirmed child does not prevent independent sibling teardown or become cleanup success", async () => {
  const unknown = child(),
    healthy = child((_, close) => close());
  const result = await settlePackedChildren(
    [unknown.value, healthy.value],
    new Map([
      [unknown.value, unknown.exit],
      [healthy.value, healthy.exit],
    ]),
    { graceMs: 5, killMs: 5 },
  );
  assert.equal(result.confirmed, false);
  assert.equal(result.closed, 1);
  assert.deepEqual(unknown.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(healthy.signals, ["SIGTERM"]);
  unknown.close();
});
test("an exit status without a captured close is not proof of retired stdio ownership", async () => {
  const owned = child();
  owned.value.exitCode = 0;
  const result = await settlePackedChildren([owned.value], new Map([[owned.value, owned.exit]]), {
    graceMs: 5,
    killMs: 5,
  });
  assert.equal(result.confirmed, false);
  assert.deepEqual(owned.signals, []);
  owned.close();
});

function runtimeFixture({ refuse = false, neverExit = false, changed = false } = {}) {
  const live = new Set([101, 102]),
    signals = [];
  let pauses = 0;
  const dependencies = {
    inspect(args) {
      if (args[0] === "-axo")
        return {
          status: 0,
          stdout: [...live].map((pid) => `${pid} /private/fixture/tui`).join("\n"),
        };
      const pid = Number(args[1]);
      if (refuse && pid === 101)
        return { status: null, error: new Error("private diagnostic must not be forwarded") };
      return {
        status: live.has(pid) ? 0 : 1,
        stdout: live.has(pid)
          ? `${changed && pauses && pid === 101 ? "changed" : "birth"} /private/fixture/tui`
          : "",
      };
    },
    kill(pid, signal) {
      if (!live.has(pid)) throw Object.assign(new Error(), { code: "ESRCH" });
      if (signal === 0) return;
      signals.push([pid, signal]);
      if (signal === "SIGTERM" && pid === 102) live.delete(pid);
      if (signal === "SIGKILL" && !neverExit) live.delete(pid);
    },
    async pause() {
      pauses++;
    },
  };
  return {
    cleanup: createInstalledRuntimeCleanup("/private/fixture/tui", undefined, dependencies),
    live,
    signals,
  };
}
test("runtime KILL is followed by positive exit confirmation and final empty inventory", async () => {
  const fixture = runtimeFixture();
  await fixture.cleanup();
  assert.equal(fixture.live.size, 0);
  assert.deepEqual(
    fixture.signals.filter(([pid]) => pid === 101),
    [
      [101, "SIGTERM"],
      [101, "SIGKILL"],
    ],
  );
});
test("unknown runtime identity refuses while independently cleaning the verified sibling", async () => {
  const fixture = runtimeFixture({ refuse: true });
  await assert.rejects(fixture.cleanup(), /retirement unconfirmed/);
  assert.deepEqual([...fixture.live], [101]);
  assert.deepEqual(fixture.signals, [[102, "SIGTERM"]]);
});
test("successful KILL request without exit evidence never confirms cleanup", async () => {
  const fixture = runtimeFixture({ neverExit: true });
  await assert.rejects(fixture.cleanup(), /retirement unconfirmed/);
  assert.deepEqual([...fixture.live], [101]);
});
test("changed incarnation is retained without escalation", async () => {
  const fixture = runtimeFixture({ changed: true });
  await assert.rejects(fixture.cleanup(), /retirement unconfirmed/);
  assert.equal(
    fixture.signals.some(([pid, signal]) => pid === 101 && signal === "SIGKILL"),
    false,
  );
});
test("failed process inventory cannot masquerade as no launched runtimes", async () => {
  const cleanup = createInstalledRuntimeCleanup("/private/fixture/tui", undefined, {
    inspect: () => ({ status: 1, stdout: "" }),
  });
  await assert.rejects(cleanup(), /inventory failed/);
});
test("tmux command completion alone is insufficient while its private socket remains", async () => {
  let polls = 0;
  assert.equal(
    await waitForPackedSocketRemoval("/private/socket", {
      present: () => ++polls < 3,
      pause: async () => {},
    }),
    true,
  );
  assert.equal(polls, 3);
  assert.equal(
    await waitForPackedSocketRemoval("/private/socket", {
      present: () => true,
      pause: async () => {},
    }),
    false,
  );
});
