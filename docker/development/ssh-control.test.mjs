import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, chmodSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  createSshControl,
  requestSshStop,
  waitForSshRetirement,
  startControlledSshListener,
} from "./ssh-control.mjs";
test("private control stops once and acknowledges only after supervisor cleanup", async () => {
  const root = mkdtempSync("/tmp/ti-ssh-control-");
  const path = `${root}/c.sock`,
    nonce = randomUUID();
  let signal;
  const requested = new Promise((resolve) => {
    signal = resolve;
  });
  let count = 0;
  const control = await createSshControl(path, nonce, () => {
    count++;
    signal();
  });
  try {
    let completed = false;
    const stopping = requestSshStop(path, nonce).then((value) => {
      completed = true;
      return value;
    });
    await requested;
    assert.equal(count, 1);
    assert.equal(completed, false);
    await control.finish();
    assert.deepEqual(await stopping, {
      version: 1,
      scope: "ssh-listener",
      stopped: true,
      childrenMayRemain: true,
    });
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("wrong nonce or nonprivate socket cannot signal listener", async () => {
  const root = mkdtempSync("/tmp/ti-ssh-control-");
  const path = `${root}/c.sock`,
    nonce = randomUUID();
  let count = 0;
  const control = await createSshControl(path, nonce, () => {
    count++;
  });
  try {
    await assert.rejects(requestSshStop(path, randomUUID()));
    chmodSync(path, 0o666);
    await assert.rejects(requestSshStop(path, nonce));
    chmodSync(path, 0o600);
    assert.equal(count, 0);
    await control.finish();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale control prevents process creation and retirement waits for owned admission", async () => {
  const root = mkdtempSync("/tmp/ti-ssh-control-");
  const path = `${root}/c.sock`;
  writeFileSync(path, "protected", { mode: 0o600 });
  let spawned = false;
  try {
    await assert.rejects(
      startControlledSshListener(path, randomUUID(), () => {
        spawned = true;
      }),
    );
    assert.equal(spawned, false);
    writeFileSync(`${root}/admission.json`, "protected", { mode: 0o600 });
    await assert.rejects(waitForSshRetirement(root, 20), /incomplete/);
    assert.equal(existsSync(`${root}/admission.json`), true);
    unlinkSync(`${root}/admission.json`);
    await waitForSshRetirement(root, 20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("synchronous listener start failure closes only its own control socket", async () => {
  const root = mkdtempSync("/tmp/ti-ssh-control-");
  const path = `${root}/c.sock`;
  try {
    await assert.rejects(
      startControlledSshListener(path, randomUUID(), () => {
        throw new Error("start failed");
      }),
      /start failed/,
    );
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
