import { test } from "node:test";
import assert from "node:assert/strict";
import { createNativeInputGate, MAX_GATE_FRAME } from "./native-input-gate-filter.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const value = (sequence, extra = {}) => ({
  connection: "c",
  sequence,
  request: 3,
  inputReady: true,
  status: "ready",
  snapshot: { marker: sequence },
  presenceRevision: 4,
  regions: [{ id: "pane" }],
  ...extra,
});
test("holds real frame and newest metadata; release is monotonic and then semantically transparent", () => {
  const gate = createNativeInputGate();
  const first = JSON.parse(gate.push(JSON.stringify(value(1))));
  assert.equal(first.inputReady, false);
  assert.deepEqual(first.snapshot, { marker: 1 });
  gate.push(JSON.stringify(value(2)));
  const released = JSON.parse(gate.release());
  assert.deepEqual(released, { ...value(2), sequence: 3 });
  assert.equal(gate.release(), null);
  assert.deepEqual(JSON.parse(gate.push(JSON.stringify(value(3)))), { ...value(3), sequence: 4 });
});
test("missing/unready latest frame cannot revive old held ready state", () => {
  const gate = createNativeInputGate();
  gate.push(JSON.stringify(value(1)));
  gate.push(JSON.stringify(value(2, { snapshot: null, inputReady: false })));
  assert.equal(gate.release(), null);
  assert.equal(gate.readyHeld, false);
  gate.push(JSON.stringify(value(3)));
  gate.clear();
  assert.equal(gate.release(), null);
});
test("bounds and source order/connection are fail closed", () => {
  assert.throws(() => createNativeInputGate().push("x".repeat(MAX_GATE_FRAME + 1)));
  const gate = createNativeInputGate();
  gate.push(JSON.stringify(value(1)));
  assert.throws(() => gate.push(JSON.stringify(value(1))));
  assert.throws(() => gate.push(JSON.stringify(value(2, { connection: "replacement" }))));
});
for (const ending of ["eof", "signal"])
  test(`helper ${ending} reaps its owned real child`, { timeout: 8000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "gpui-input-gate-control-"));
    const fake = join(directory, "source.mjs");
    await writeFile(
      fake,
      `process.stdout.write(${JSON.stringify(JSON.stringify(value(1)) + "\n")});setInterval(()=>{},1000);`,
    );
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./native-input-gate-helper.mjs", import.meta.url)),
        process.execPath,
        fake,
        directory,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.resume();
    const watchdog = setTimeout(() => child.kill("SIGTERM"), 4000);
    try {
      const deadline = Date.now() + 3000;
      while (!existsSync(join(directory, "held.json"))) {
        if (Date.now() > deadline) throw new Error(`No held frame: ${stderr}`);
        await new Promise((done) => setTimeout(done, 10));
      }
      if (ending === "eof") child.stdin.end();
      else child.kill("SIGTERM");
      assert.equal(await closed, 0, stderr);
      const receipt = JSON.parse(await readFile(join(directory, "helper-cleanup.json"), "utf8"));
      assert.equal(receipt.reaped, true);
      assert.equal(receipt.failed, false);
      assert.throws(() => process.kill(receipt.pid, 0), { code: "ESRCH" });
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
      await rm(directory, { recursive: true, force: true });
    }
  });
