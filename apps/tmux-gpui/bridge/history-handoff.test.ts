import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { drainHistoryCapture } from "./history-handoff.ts";
function fixture(timeout = 2000) {
  const stdout = new PassThrough(),
    stdin = new PassThrough();
  const kills: string[] = [];
  let close!: () => void;
  const done = new Promise<void>((resolve) => {
    close = resolve;
  });
  let command = "";
  stdin.on("data", (chunk) => {
    command += chunk;
  });
  const child = {
    stdout,
    stdin,
    kill: (signal: string) => {
      kills.push(signal);
      return true;
    },
  } as unknown as ChildProcess;
  const drain = drainHistoryCapture(child, done, timeout);
  const intent = JSON.parse(command).intent;
  return { stdout, close, kills, drain, intent };
}
test("accepts only the exact drain intent, ignores display and foreign results", async () => {
  const f = fixture();
  let settled = false;
  void f.drain.result.then(() => {
    settled = true;
  });
  f.stdout.write(
    "partial obsolete frame\n" + JSON.stringify({ snapshot: {}, inputReady: true }) + "\n",
  );
  f.stdout.write(
    JSON.stringify({
      kind: "history-handoff",
      intent: "11111111-1111-4111-8111-111111111111",
      state: "historical",
      token: null,
    }) + "\n",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  f.stdout.write(
    JSON.stringify({
      kind: "history-handoff",
      intent: f.intent,
      state: "historical",
      token: "22222222-2222-4222-8222-222222222222",
    }) + "\n",
  );
  assert.equal((await f.drain.result)?.token, "22222222-2222-4222-8222-222222222222");
  f.close();
  assert.deepEqual(f.kills, ["SIGTERM"]);
});
test("cancellation settles once and ignores late completion", async () => {
  const f = fixture();
  f.drain.cancel();
  f.drain.cancel();
  f.stdout.write(
    JSON.stringify({ kind: "history-handoff", intent: f.intent, state: "live", token: null }) +
      "\n",
  );
  assert.equal(await f.drain.result, null);
  f.close();
  assert.deepEqual(f.kills, ["SIGTERM"]);
});
test("deadline and early child close settle unavailable", async () => {
  const f = fixture(5);
  assert.equal(await f.drain.result, null);
  f.close();
  const g = fixture();
  g.close();
  assert.equal(await g.drain.result, null);
});

test("stdin failure settles without waiting for deadline", async () => {
  const stdout = new PassThrough(),
    stdin = new PassThrough();
  let close!: () => void;
  const done = new Promise<void>((resolve) => {
    close = resolve;
  });
  const child = { stdout, stdin, kill: () => true } as unknown as ChildProcess;
  const drain = drainHistoryCapture(child, done);
  stdin.emit("error", new Error("owned pipe closed"));
  assert.equal(await drain.result, null);
  close();
});
test("framing handles split UTF8 obsolete display before exact result", async () => {
  const f = fixture();
  const data = Buffer.from(
    JSON.stringify({ ignored: "漢字" }) +
      "\n" +
      JSON.stringify({ kind: "history-handoff", intent: f.intent, state: "live", token: null }) +
      "\n",
  );
  for (const byte of data) f.stdout.write(Buffer.from([byte]));
  assert.equal((await f.drain.result)?.state, "live");
  f.close();
});
