import assert from "node:assert/strict";
import test from "node:test";
import {
  artifact,
  canonicalMarker,
  createScreen,
  isolatedEnv,
  shellQuote,
  validateOptions,
} from "./comparative-terminal-support.mjs";

test("requires explicit artifacts, bounded options and records exact bytes", () => {
  const binaries = { tmux: process.execPath };
  const provenance = validateOptions({
    targets: ["tmux"],
    binaries,
    cols: 66,
    rows: 41,
    samples: 2,
    rounds: 1,
  });
  assert.equal(provenance.tmux.sha256.length, 64);
  assert.ok(provenance.tmux.bytes > 0);
  assert.throws(() => artifact("tmux"), /absolute/);
  assert.throws(() =>
    validateOptions({ targets: ["tmux-ide"], binaries, cols: 66, rows: 41, samples: 2, rounds: 1 }),
  );
  assert.throws(
    () =>
      validateOptions({
        targets: ["tmux"],
        binaries,
        cols: 66,
        rows: 41,
        samples: 1000000,
        rounds: 1,
      }),
    /samples/,
  );
});
test("isolates inherited product/socket/config environment and quotes shell arguments literally", () => {
  const env = isolatedEnv(
    {
      PATH: "/bin",
      HOME: "/user",
      TMUX: "user",
      TMUX_PANE: "%7",
      TMUX_IDE_HOME: "wrong",
      HERDR_SOCKET_PATH: "wrong",
      XDG_CONFIG_HOME: "wrong",
    },
    "/private",
  );
  assert.equal(env.HOME, "/private");
  assert.equal(env.PATH, "/bin");
  for (const name of ["TMUX", "TMUX_PANE", "TMUX_IDE_HOME", "HERDR_SOCKET_PATH"])
    assert.equal(env[name], undefined);
  assert.equal(shellQuote("a'$(bad)"), "'a'\\''$(bad)'");
});
test("only one complete canonical marker qualifies", () => {
  assert.deepEqual(canonicalMarker(["CBENCH:000002:66x41:END"]), {
    sequence: 2,
    cols: 66,
    rows: 41,
  });
  assert.equal(canonicalMarker(["CBENCH:000002:66x41:EN"]), null);
  assert.equal(canonicalMarker(["CBENCH:000002:66x41:END", "CBENCH:000001:66x41:END"]), null);
});
test("shared oracle observes parsed terminal cells rather than control text or chunk counts", async () => {
  const frames = [];
  const replies = [];
  const screen = createScreen(
    66,
    41,
    (reply) => replies.push(reply),
    (marker) => frames.push(marker),
  );
  try {
    await screen.write("\x1b]2;CBENCH:999999:66x41:END\x07");
    assert.equal(frames.at(-1), null);
    await screen.write("\x1b[HCBENCH:000");
    assert.equal(frames.at(-1), null);
    await screen.write("002:66x41:END");
    assert.equal(frames.at(-1).sequence, 2);
    await screen.write("\x1b[2J\x1b[HCBENCH:000003:66x41:END");
    assert.equal(frames.at(-1).sequence, 3);
  } finally {
    screen.dispose();
  }
});

test("owned process retirement waits, escalates only live handles and fails on survivors", async () => {
  const { retireOwnedProcess } = await import("./comparative-terminal-support.mjs");
  const signals = [];
  let exits = 0;
  assert.equal(
    await retireOwnedProcess(
      { exited: () => false, signal: (value) => signals.push(value) },
      async () => ++exits === 2,
    ),
    "killed",
  );
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(
    await retireOwnedProcess({ exited: () => true, signal: () => assert.fail() }, async () =>
      assert.fail(),
    ),
    "already-exited",
  );
  await assert.rejects(
    retireOwnedProcess({ exited: () => false, signal: () => {} }, async () => false),
    /did not exit/,
  );
});

test("private tmux cleanup recovers launch identity only behind the exact session/socket fence", async () => {
  const { retirePrivateTmux } = await import("./comparative-terminal-support.mjs");
  const calls = [];
  const command = async (...args) => {
    calls.push(args);
    return "123\n";
  };
  assert.deepEqual(await retirePrivateTmux(command, undefined, "fixture"), {
    pid: 123,
    recoveredIdentity: true,
  });
  assert.deepEqual(calls[0], ["has-session", "-t", "=fixture"]);
  assert.deepEqual(calls.at(-1), ["kill-server"]);
  const changed = [];
  await assert.rejects(
    retirePrivateTmux(
      async (...args) => {
        changed.push(args);
        return "456";
      },
      123,
      "fixture",
    ),
    /changed/,
  );
  assert.equal(
    changed.some((args) => args[0] === "kill-server"),
    false,
  );
  await assert.rejects(
    retirePrivateTmux(
      async () => {
        throw new Error("missing private session");
      },
      null,
      "fixture",
    ),
    /missing private session/,
  );
});

test("input mode validation rejects ambiguous scenarios before artifact access", () => {
  assert.throws(() => validateOptions({ inputMode: "paste" }), /inputMode/);
});

test("key decoder increments once per literal x and line decoder retains split-frame order", async () => {
  const { createProducerInputDecoder } = await import("./comparative-terminal-producer.mjs");
  const keys = [];
  const key = createProducerInputDecoder("key", (value) => keys.push(value));
  key(Buffer.from("xx\r"));
  key(Buffer.from("x"));
  assert.deepEqual(keys, [1, 2, 3]);
  const lines = [];
  const line = createProducerInputDecoder("line", (value) => lines.push(value));
  line(Buffer.from("CBINPUT:000"));
  assert.deepEqual(lines, []);
  line(Buffer.from("001\rCBINPUT:000002\r"));
  assert.deepEqual(lines, [1, 2]);
  assert.throws(() => createProducerInputDecoder("paste", () => {}), /inputMode/);
});
