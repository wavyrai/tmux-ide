import assert from "node:assert/strict";
import test from "node:test";
import { retirePackedCliResolution } from "./packed-cli-resolution.mjs";
function fixture() {
  const root = "/private/test",
    directory = root + "/tmux-cli-resolution-abc";
  const s = {
    dev: 1,
    ino: 2,
    uid: process.getuid(),
    mode: 0o40700,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
  const expected = {
    root,
    rootWitness: { dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode },
    cli: "/candidate/cli.js",
    cliHash: "cli",
    binary: "/candidate/tmux",
    binaryHash: "native",
  };
  const receipt = {
    version: 1,
    directory,
    socket: directory + "/owned.sock",
    cli: { realpath: expected.cli, sha256: "cli" },
    native: { realpath: expected.binary, sha256: "native" },
    ownership: {
      identity: "42|100|$0|%0|43",
      serverPid: "42",
      serverStart: "100",
      sessionId: "$0",
      paneId: "%0",
      panePid: "43",
    },
  };
  const calls = [];
  let gone = false;
  const deps = {
    stat: () => s,
    dead: () => gone,
    pause: async () => {},
    exec: (args) => {
      calls.push(args);
      if (args.includes("if-shell")) {
        gone = true;
        return { status: 0, stdout: "", signal: null };
      }
      return { status: 1, stdout: "", signal: null };
    },
  };
  return {
    expected,
    receipt,
    deps,
    calls,
    setGone: () => {
      gone = true;
    },
  };
}
test("interrupted fixture retires only through exact socket/server guard then confirms both PIDs", async () => {
  const f = fixture();
  assert.equal((await retirePackedCliResolution(f.expected, f.receipt, f.deps)).confirmed, true);
  assert.deepEqual(f.calls[0], [
    "-S",
    f.receipt.socket,
    "if-shell",
    "-F",
    "#{&&:#{==:#{pid},42},#{==:#{start_time},100}}",
    "kill-server",
    "display-message -p identity-mismatch",
  ]);
});
test("already retired fixture does not issue another kill", async () => {
  const f = fixture();
  f.setGone();
  await retirePackedCliResolution(f.expected, f.receipt, f.deps);
  assert.equal(f.calls.length, 1);
  assert(f.calls[0].includes("has-session"));
});
test("untrusted receipt cannot substitute paths, hashes or identities", async () => {
  for (const mutate of [
    (r) => (r.directory = "/elsewhere/tmux-cli-resolution-abc"),
    (r) => (r.socket = "/user/server"),
    (r) => (r.cli.realpath = "/other/cli"),
    (r) => (r.native.sha256 = "other"),
    (r) => (r.ownership = null),
    (r) => (r.ownership.serverPid = "42;kill"),
    (r) => (r.ownership.sessionId = "oops"),
  ]) {
    const f = fixture();
    mutate(f.receipt);
    await assert.rejects(retirePackedCliResolution(f.expected, f.receipt, f.deps));
    assert.equal(f.calls.length, 0);
  }
});
test("changed private root never grants kill authority", async () => {
  const f = fixture();
  f.expected.rootWitness.ino++;
  await assert.rejects(retirePackedCliResolution(f.expected, f.receipt, f.deps));
  assert.equal(f.calls.length, 0);
});
test("identity mismatch, live PID and timeout cannot become cleanup success", async () => {
  for (const mode of ["mismatch", "live", "timeout"]) {
    const f = fixture();
    f.deps.exec = () => ({
      status: mode === "timeout" ? null : 0,
      stdout: mode === "mismatch" ? "identity-mismatch" : "",
      signal: mode === "timeout" ? "SIGTERM" : null,
    });
    await assert.rejects(retirePackedCliResolution(f.expected, f.receipt, f.deps));
  }
});
test("socket timeout is not absence even when both recorded PIDs exited", async () => {
  const f = fixture();
  f.setGone();
  f.deps.exec = () => ({ status: null, stdout: "", signal: "SIGTERM" });
  await assert.rejects(retirePackedCliResolution(f.expected, f.receipt, f.deps));
});
test("a symlinked receipt directory never grants kill authority", async () => {
  const f = fixture();
  const original = f.deps.stat;
  f.deps.stat = (path) => ({
    ...original(path),
    isSymbolicLink: () => path === f.receipt.directory,
  });
  await assert.rejects(retirePackedCliResolution(f.expected, f.receipt, f.deps));
  assert.equal(f.calls.length, 0);
});
