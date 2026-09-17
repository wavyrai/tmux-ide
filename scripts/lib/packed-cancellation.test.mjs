import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPackedCancellation } from "./packed-cancellation.mjs";
const url = new URL("./packed-cancellation.mjs", import.meta.url).href;
const cleanupUrl = new URL("./packed-install-cleanup.mjs", import.meta.url).href;
test("signal interrupts waits but cleanup remains admitted and listeners are removed", async () => {
  const signals = new EventEmitter(),
    c = createPackedCancellation({ signals });
  try {
    const waiting = c.pause(5000);
    signals.emit("SIGTERM");
    await assert.rejects(waiting, /cancelled/);
    assert.throws(c.check, /cancelled/);
    await c.cleanup(async () => {
      c.check();
      await c.pause(1);
    });
    assert.throws(c.check, /cancelled/);
    assert.equal(c.facts().signal, "SIGTERM");
  } finally {
    c.dispose();
  }
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});
test("cancellation drains an active command before propagating, never kills only its parent", async () => {
  const signals = new EventEmitter(),
    c = createPackedCancellation({ signals });
  try {
    const started = Date.now();
    const pending = c.command(process.execPath, ["-e", "setTimeout(()=>process.exit(0),100)"]);
    signals.emit("SIGINT");
    await assert.rejects(pending, /cancelled/);
    assert.ok(Date.now() - started >= 100);
    const [command] = c.facts().commands;
    assert.equal(command.status, 0);
    assert.equal(command.settled, true);
    assert.throws(() => process.kill(command.pid, 0), { code: "ESRCH" });
    assert.equal(c.facts().uncertainCommand, false);
  } finally {
    c.dispose();
  }
});
test("command timeout cannot qualify descendant retirement", async () => {
  const c = createPackedCancellation({ signals: new EventEmitter() });
  try {
    const result = await c.command(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeout: 100,
    });
    assert.notEqual(result.status, 0);
    assert.equal(c.facts().uncertainCommand, true);
    assert.throws(() => process.kill(result.pid, 0), { code: "ESRCH" });
  } finally {
    c.dispose();
  }
});
for (const mode of ["signal", "failure"])
  test(`real ${mode} enters owned finally and leaves both processes absent`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "packed-cancel-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const script = join(root, "fixture.mjs");
    writeFileSync(
      script,
      `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';import {createPackedCancellation} from ${JSON.stringify(url)};import {settlePackedChildren} from ${JSON.stringify(cleanupUrl)};const c=createPackedCancellation();const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});const exits=new Map([[child,new Promise(r=>child.once('close',r))]]);let failed=false;try{await new Promise(r=>child.once('spawn',r));writeFileSync(${JSON.stringify(join(root, "ready"))},String(child.pid));if(${JSON.stringify(mode)}==='failure')throw new Error('injected');await c.pause(10000);}catch{failed=true;}finally{c.beginCleanup();const cleanup=await settlePackedChildren([child],exits,{graceMs:500,killMs:500});writeFileSync(${JSON.stringify(join(root, "receipt"))},JSON.stringify({failed,cleanup,facts:c.facts()}));c.dispose();}process.exitCode=1;`,
    );
    const child = spawn(process.execPath, [script], { stdio: "ignore" });
    const closed = once(child, "close", { signal: AbortSignal.timeout(5000) });
    try {
      const deadline = Date.now() + 3000;
      while (!existsSync(join(root, "ready")) && Date.now() < deadline) await delay(10);
      assert.equal(existsSync(join(root, "ready")), true);
      const ownedPid = Number(readFileSync(join(root, "ready"), "utf8"));
      if (mode === "signal") child.kill("SIGTERM");
      assert.equal((await closed)[0], 1);
      const receipt = JSON.parse(readFileSync(join(root, "receipt"), "utf8"));
      assert.equal(receipt.failed, true);
      assert.equal(receipt.cleanup.confirmed, true);
      assert.equal(receipt.facts.requested, mode === "signal");
      assert.throws(() => process.kill(ownedPid, 0), { code: "ESRCH" });
      assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await closed;
    }
  });
