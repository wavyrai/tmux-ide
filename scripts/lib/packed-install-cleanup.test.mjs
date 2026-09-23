import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifyPackedTmuxHandoff,
  packedTmuxWitnessDifferences,
  capturePackedTmuxWitness,
  retirePackedTmuxSocket,
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

function socketFixture() {
  const parent = { dev: 1, ino: 2, uid: 501, mode: 0o40700, isDirectory: () => true };
  const socket = {
    dev: 1,
    ino: 3,
    uid: 501,
    mode: 0o140600,
    birthtimeMs: 100,
    isSocket: () => true,
  };
  let present = true;
  const removed = [];
  const stat = (path) => {
    if (path === "/private/fixture") return parent;
    if (!present) throw Object.assign(new Error(), { code: "ENOENT" });
    return socket;
  };
  const witness = capturePackedTmuxWitness("/private/fixture/tmux.sock", 123, {
    stat,
    uid: 501,
    dead: () => false,
  });
  const dependencies = {
    stat,
    dead: () => true,
    refused: async () => true,
    remove: (path) => {
      removed.push(path);
      present = false;
    },
    pause: async () => {},
  };
  return {
    parent,
    socket,
    witness,
    dependencies,
    removed,
    disappear: () => {
      present = false;
    },
  };
}
test("stale tmux socket is removed only after dead owner, refusal and exact creation witness", async () => {
  const f = socketFixture();
  assert.deepEqual(await retirePackedTmuxSocket(f.witness, f.dependencies), {
    ownerDead: true,
    socketRemoved: true,
    staleSocketRemoved: true,
  });
  assert.deepEqual(f.removed, [f.witness.path]);
  assert.deepEqual(await retirePackedTmuxSocket(f.witness, f.dependencies), {
    ownerDead: true,
    socketRemoved: true,
    staleSocketRemoved: false,
  });
});
test("missing witness, live/reused/unknown PID and listening or unknown endpoint cannot authorize unlink", async () => {
  for (const change of [
    { dead: () => false },
    {
      dead: () => {
        throw Object.assign(new Error(), { code: "EPERM" });
      },
    },
    { refused: async () => false },
    {
      refused: async () => {
        throw new Error("unknown");
      },
    },
  ]) {
    const f = socketFixture();
    await assert.rejects(retirePackedTmuxSocket(f.witness, { ...f.dependencies, ...change }));
    assert.deepEqual(f.removed, []);
  }
  const f = socketFixture();
  await assert.rejects(retirePackedTmuxSocket(null, f.dependencies), /witness missing/);
  assert.deepEqual(f.removed, []);
});
test("recreated socket/parent or PID reuse during refusal probe preserves replacement", async () => {
  for (const mutate of [
    (f) => f.socket.ino++,
    (f) => f.socket.uid++,
    (f) => f.socket.birthtimeMs++,
    (f) => f.parent.ino++,
    (f) => {
      f.parent.mode = 0o40755;
    },
  ]) {
    const f = socketFixture();
    await assert.rejects(
      retirePackedTmuxSocket(f.witness, {
        ...f.dependencies,
        refused: async () => {
          mutate(f);
          return true;
        },
      }),
      /changed/,
    );
    assert.deepEqual(f.removed, []);
  }
  const f = socketFixture();
  let probes = 0;
  await assert.rejects(
    retirePackedTmuxSocket(f.witness, { ...f.dependencies, dead: () => ++probes === 1 }),
    /PID reused/,
  );
  assert.deepEqual(f.removed, []);
});
test("creation witness refuses dead PID and unsafe socket parent", () => {
  const f = socketFixture();
  assert.throws(
    () =>
      capturePackedTmuxWitness(f.witness.path, 123, {
        stat: f.dependencies.stat,
        uid: 501,
        dead: () => true,
      }),
    /unavailable/,
  );
  f.parent.mode = 0o40755;
  assert.throws(
    () =>
      capturePackedTmuxWitness(f.witness.path, 123, {
        stat: f.dependencies.stat,
        uid: 501,
        dead: () => false,
      }),
    /unsafe/,
  );
});

test("owned new-session can hand off only from proven-dead prior generation and retain reuse identity", async () => {
  const f = socketFixture(),
    previous = f.witness,
    next = { ...previous, pid: 456, socket: { ...previous.socket, ino: 10 } };
  const deps = { dead: () => true, pause: async () => {}, recapture: () => next };
  assert.deepEqual(await verifyPackedTmuxHandoff(previous, next, deps), {
    replaced: true,
    retiredPid: 123,
  });
  assert.deepEqual(await verifyPackedTmuxHandoff(next, next, deps), {
    replaced: false,
    retiredPid: null,
  });
  await assert.rejects(
    verifyPackedTmuxHandoff(previous, next, { ...deps, dead: () => false }),
    /remains live/,
  );
  await assert.rejects(
    verifyPackedTmuxHandoff(previous, next, {
      ...deps,
      dead: () => {
        throw new Error("unknown");
      },
    }),
    /unknown/,
  );
});
test("tmux handoff refuses same-PID changed socket, changed root and replacement during confirmation", async () => {
  const f = socketFixture(),
    previous = f.witness;
  const deps = { dead: () => true, pause: async () => {}, recapture: () => previous };
  await assert.rejects(
    verifyPackedTmuxHandoff(
      previous,
      { ...previous, socket: { ...previous.socket, ino: 10 } },
      deps,
    ),
    /changed socket/,
  );
  await assert.rejects(
    verifyPackedTmuxHandoff(
      previous,
      { ...previous, parent: { ...previous.parent, ino: 10 } },
      deps,
    ),
    /parent changed/,
  );
  const next = { ...previous, pid: 456, socket: { ...previous.socket, ino: 10 } };
  await assert.rejects(verifyPackedTmuxHandoff(previous, next, deps), /changed during handoff/);
});

test("documented owner-execute socket toggle preserves identity through reuse and final retirement", async () => {
  const f = socketFixture(),
    detached = f.witness;
  f.socket.mode = 0o140700;
  const attached = capturePackedTmuxWitness(detached.path, detached.pid, {
    stat: f.dependencies.stat,
    uid: 501,
    dead: () => false,
  });
  assert.deepEqual(packedTmuxWitnessDifferences(detached, attached), ["socket.mode"]);
  assert.deepEqual(
    await verifyPackedTmuxHandoff(detached, attached, { recapture: () => attached }),
    { replaced: false, retiredPid: null },
  );
  f.socket.mode = 0o140600;
  assert.deepEqual(
    await verifyPackedTmuxHandoff(attached, detached, { recapture: () => detached }),
    { replaced: false, retiredPid: null },
  );
  assert.equal((await retirePackedTmuxSocket(attached, f.dependencies)).staleSocketRemoved, true);
});
test("socket mode contract refuses group/other access, missing owner access and special bits", async () => {
  for (const permission of [0o666, 0o660, 0o610, 0o601, 0o400, 0o200, 0o1600, 0o4600]) {
    const f = socketFixture();
    f.socket.mode = 0o140000 | permission;
    assert.throws(
      () =>
        capturePackedTmuxWitness(f.witness.path, 123, {
          stat: f.dependencies.stat,
          uid: 501,
          dead: () => false,
        }),
      /unsafe/,
    );
    await assert.rejects(retirePackedTmuxSocket(f.witness, f.dependencies), /changed/);
    assert.deepEqual(f.removed, []);
  }
});
test("witness diagnostics expose only fixed changed field names", () => {
  const f = socketFixture(),
    next = {
      ...f.witness,
      pid: 456,
      socket: { ...f.witness.socket, ino: 8, uid: 502, mode: 0o140700 },
      extraSecret: "never returned",
    };
  assert.deepEqual(packedTmuxWitnessDifferences(f.witness, next), [
    "pid",
    "socket.ino",
    "socket.uid",
    "socket.mode",
  ]);
});

test("retirement diagnostics preserve fixed refusal cause and PID without private errors", async () => {
  const fixture = runtimeFixture({ refuse: true });
  await assert.rejects(fixture.cleanup(), (error) => {
    assert.deepEqual(
      error.diagnostics.map(({ pid, phase, reason }) => ({ pid, phase, reason })),
      [{ pid: 101, phase: "initial-identity", reason: "identity-read-failed" }],
    );
    assert.equal(JSON.stringify(error.diagnostics).includes("private diagnostic"), false);
    assert.equal(JSON.stringify(error.diagnostics).includes("/private/fixture"), false);
    return true;
  });
  assert.deepEqual(fixture.signals, [[102, "SIGTERM"]]);
});

test("zombie diagnostic never converts a changed binary identity into cleanup authority", async () => {
  let signalled = false;
  const signals = [];
  const cleanup = createInstalledRuntimeCleanup("/private/fixture/tui", undefined, {
    inspect(args) {
      if (args[0] === "-axo") return { status: 0, stdout: "101 /private/fixture/tui" };
      if (args.includes("stat=")) return { status: 0, stdout: "Z" };
      return {
        status: 0,
        stdout: signalled ? "birth [tui] <defunct>" : "birth /private/fixture/tui",
      };
    },
    kill(_pid, signal) {
      if (signal !== 0) {
        signals.push(signal);
        signalled = true;
      }
    },
    pause: async () => {},
  });
  await assert.rejects(cleanup(), (error) => {
    assert.deepEqual(error.diagnostics, [
      {
        pid: 101,
        phase: "exit-confirmation",
        reason: "binary-path-mismatch",
        state: "zombie",
        identityReadable: true,
        binaryPathMatch: false,
      },
    ]);
    return true;
  });
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("identity refusal followed by fresh ESRCH confirms exit without signalling", async () => {
  let reads = 0;
  const signals = [];
  const cleanup = createInstalledRuntimeCleanup("/private/fixture/tui", undefined, {
    inspect(args) {
      if (args[0] === "-axo") return { status: 0, stdout: reads ? "" : "101 /private/fixture/tui" };
      reads++;
      return { status: 0, stdout: "birth [tui] <defunct>" };
    },
    kill(_pid, signal) {
      signals.push(signal);
      throw Object.assign(new Error(), { code: "ESRCH" });
    },
  });
  await cleanup();
  assert.deepEqual(signals, [0]);
});

test("refused identity cannot use alive or uncertain liveness as exit evidence", async () => {
  for (const code of [null, "EPERM"]) {
    const signals = [];
    const cleanup = createInstalledRuntimeCleanup("/private/fixture/tui", undefined, {
      inspect(args) {
        if (args[0] === "-axo") return { status: 0, stdout: "101 /private/fixture/tui" };
        if (args.includes("stat=")) return { status: 0, stdout: "S" };
        return { status: 0, stdout: "new-birth /foreign/program" };
      },
      kill(_pid, signal) {
        signals.push(signal);
        if (code) throw Object.assign(new Error(), { code });
      },
    });
    await assert.rejects(cleanup(), /retirement unconfirmed/);
    assert.ok(signals.every((signal) => signal === 0));
  }
});

test("ESRCH confirmation still requires the final runtime inventory to be empty", async () => {
  const cleanup = createInstalledRuntimeCleanup("/private/fixture/tui", undefined, {
    inspect(args) {
      if (args[0] === "-axo") return { status: 0, stdout: "101 /private/fixture/tui" };
      return { status: 0, stdout: "birth [tui] <defunct>" };
    },
    kill() {
      throw Object.assign(new Error(), { code: "ESRCH" });
    },
  });
  await assert.rejects(cleanup(), /inventory remains live/);
});

test("a signalled runtime can pass through a short zombie state before positive disappearance", async () => {
  let signalled = false;
  let absent = false;
  let livenessReads = 0;
  const signals = [];
  const cleanup = createInstalledRuntimeCleanup("/private/fixture/tui", undefined, {
    inspect(args) {
      if (args[0] === "-axo")
        return { status: 0, stdout: absent ? "" : "101 /private/fixture/tui" };
      return {
        status: 0,
        stdout: signalled ? "birth [tui] <defunct>" : "birth /private/fixture/tui",
      };
    },
    kill(_pid, signal) {
      if (signal === 0) {
        if (++livenessReads >= 3) {
          absent = true;
          throw Object.assign(new Error(), { code: "ESRCH" });
        }
        return;
      }
      signals.push(signal);
      signalled = true;
    },
    pause: async () => {},
  });
  await cleanup();
  assert.equal(absent, true);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(livenessReads, 3);
});
