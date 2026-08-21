import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { runBoundedChildCommand } from "./bounded-child-command.mjs";

test("bounded child remains tracked until its retained callback settles after abort", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kills: [],
    kill(signal) {
      this.kills.push(signal);
      return true;
    },
  });
  let callback;
  const tracked = new Set();
  const controller = new AbortController();
  const promise = runBoundedChildCommand({
    executable: "fake",
    args: [],
    options: {},
    timeoutMs: 1_000,
    signal: controller.signal,
    onSpawn: (pid) => tracked.add(pid),
    onSettled: (pid) => tracked.delete(pid),
    execFileImpl: (_executable, _args, _options, done) => {
      callback = done;
      return child;
    },
  });
  controller.abort();
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.deepEqual([...tracked], [4242]);
  const error = Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" });
  callback(error, "", "");
  await assert.rejects(promise, (caught) => caught.code === "ABORT_ERR");
  assert.deepEqual([...tracked], []);
});
