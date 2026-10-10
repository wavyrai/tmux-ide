import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { stopFixtureChild } from "./fixture-child.mjs";

test("fixture shutdown reaps a helper ignoring SIGTERM", { timeout: 5000 }, async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let timer;
  try {
    await once(child.stdout, "data");
    const completed = await Promise.race([
      stopFixtureChild(child, 50).then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), 500);
      }),
    ]);
    assert.equal(completed, true, "owned helper shutdown must finish");
    assert.equal(child.signalCode, "SIGKILL");
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
  }
});
